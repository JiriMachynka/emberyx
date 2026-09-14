//! SnapShots: a global shortcut that captures the frontmost window and hands
//! it to the focused composer.
//!
//! `tauri-plugin-global-shortcut` cannot express "both Shift keys together",
//! so the trigger is a hand-rolled `CGEventTap` — listen-only, on
//! `flagsChanged`, watching the device-dependent left/right shift bits. The
//! tap lives in Rust and runs only while the feature is enabled; it is torn
//! down on disable and on app exit, like every other child-owning module.
//!
//! The capture itself is `CGWindowList` for the frontmost window plus
//! `CGWindowListCreateImage` for the PNG, and — when "Include app text" is on
//! — an `AXUIElement` walk of that window's accessibility tree, so the agent
//! can read labels instead of guessing from pixels. The macOS APIs are spoken
//! by hand here the way `browser.rs` speaks CDP: the objc2 crates would pull
//! in a large binding surface for a handful of C calls into system frameworks.
//!
//! Permissions are the user's to grant: Screen Recording for the pixels,
//! Input Monitoring for the listen-only HID tap, Accessibility for the tree.
//! A missing permission is reported by name, never degraded around.

use serde::Serialize;

#[cfg(target_os = "macos")]
mod platform {
    use std::collections::HashMap;
    use std::ffi::{c_char, c_void, CString};
    use std::os::raw::c_long;
    use std::ptr;
    use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU64, Ordering};
    use std::sync::{Arc, LazyLock, Mutex};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use tauri::{AppHandle, Emitter, Manager};

    use super::{A11yNode, SnapshotCapture, SnapshotsStatus};
    use crate::err;
    use crate::error::Result;

    // ---- CoreFoundation ----

    type CFAllocatorRef = *const c_void;
    type CFArrayRef = *const c_void;
    type CFDictionaryRef = *const c_void;
    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFURLRef = *const c_void;
    type CFIndex = isize;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: CFArrayRef) -> CFIndex;
        fn CFArrayGetValueAtIndex(array: CFArrayRef, index: CFIndex) -> CFTypeRef;
        fn CFDictionaryGetValue(dict: CFDictionaryRef, key: CFTypeRef) -> CFTypeRef;
        fn CFStringCreateWithCString(
            alloc: CFAllocatorRef,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFStringGetCString(
            string: CFStringRef,
            buffer: *mut c_char,
            buffer_size: CFIndex,
            encoding: u32,
        ) -> u8;
        fn CFNumberGetValue(number: CFTypeRef, the_type: CFIndex, value_ptr: *mut c_void) -> u8;
        fn CFURLCreateWithFileSystemPath(
            allocator: CFAllocatorRef,
            path: CFStringRef,
            path_style: CFIndex,
            is_directory: u8,
        ) -> CFURLRef;
        fn CFRelease(cf: CFTypeRef);
        fn CFRunLoopGetCurrent() -> CFRunLoopRef;
        fn CFRunLoopAddSource(loop_ref: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
        fn CFRunLoopRemoveSource(
            loop_ref: CFRunLoopRef,
            source: CFRunLoopSourceRef,
            mode: CFStringRef,
        );
        fn CFRunLoopRun();
        fn CFRunLoopStop(loop_ref: CFRunLoopRef);
        fn CFMachPortCreateRunLoopSource(
            allocator: CFAllocatorRef,
            port: CFMachPortRef,
            order: CFIndex,
        ) -> CFRunLoopSourceRef;
        fn CFMachPortInvalidate(port: CFMachPortRef);
        static kCFRunLoopCommonModes: CFStringRef;
    }

    type CFRunLoopRef = *mut c_void;
    type CFRunLoopSourceRef = *mut c_void;
    type CFMachPortRef = *mut c_void;

    const K_CF_NUMBER_FLOAT64: CFIndex = 6;
    const K_CF_URL_POSIX_PATH_STYLE: CFIndex = 0;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    // ---- CoreGraphics: window list, capture, event tap ----

    type CGImageRef = *const c_void;
    type CGWindowID = u32;
    type CGDirectDisplayID = u32;
    type CGEventTapCallBack = unsafe extern "C" fn(
        proxy: *mut c_void,
        event_type: u32,
        event: *mut c_void,
        user_info: *mut c_void,
    ) -> *mut c_void;

    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct CGPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct CGSize {
        width: f64,
        height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            event_mask: u64,
            callback: CGEventTapCallBack,
            user_info: *mut c_void,
        ) -> CFMachPortRef;
        fn CGEventTapEnable(tap: CFMachPortRef, enable: u8);
        fn CGEventGetFlags(event: *mut c_void) -> u64;
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: CGWindowID) -> CFArrayRef;
        fn CGWindowListCreateImage(
            window_bounds: CGRect,
            list_option: u32,
            window_id: CGWindowID,
            image_option: u32,
        ) -> CGImageRef;
        fn CGPreflightScreenCaptureAccess() -> u8;
        fn CGRequestScreenCaptureAccess() -> u8;
        fn CGMainDisplayID() -> CGDirectDisplayID;
        fn CGDisplayPixelsHigh(display: CGDirectDisplayID) -> c_long;
    }

    /// Listen-only HID taps need Input Monitoring, not Accessibility. A session
    /// tap was the previous choice and silently failed unless the process was
    /// already AX-trusted — Screen Recording alone was not enough.
    const K_CG_HID_EVENT_TAP: u32 = 0;
    const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
    const K_CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;
    /// `kCGEventFlagsChanged` (`NX_FLAGSCHANGED`); the tap mask is one bit.
    const K_CG_EVENT_FLAGS_CHANGED: u32 = 12;
    const K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    const K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;

    const K_CG_WINDOW_LIST_ON_SCREEN_ONLY: u32 = 1;
    const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
    const K_CG_WINDOW_LIST_INCLUDING_WINDOW: u32 = 1 << 3;
    const K_CG_WINDOW_IMAGE_NO_SHADOW: u32 = 1 << 1;

    /// Device-dependent shift bits in `CGEventGetFlags` (`NX_DEVICELSHIFTKEYMASK`
    /// / `NX_DEVICERSHIFTKEYMASK`). The generic `NX_SHIFTMASK` cannot tell the
    /// two keys apart; these can, and both held together is the trigger.
    const SHIFT_LEFT: u64 = 0x0000_0002;
    const SHIFT_RIGHT: u64 = 0x0000_0004;

    pub fn both_shifts_down(flags: u64) -> bool {
        flags & SHIFT_LEFT != 0 && flags & SHIFT_RIGHT != 0
    }

    // ---- ImageIO: PNG encode ----

    #[link(name = "ImageIO", kind = "framework")]
    extern "C" {
        fn CGImageDestinationCreateWithURL(
            url: CFURLRef,
            file_type: CFStringRef,
            image_count: usize,
            options: CFDictionaryRef,
        ) -> *mut c_void;
        fn CGImageDestinationAddImage(
            dest: *mut c_void,
            image: CGImageRef,
            properties: CFDictionaryRef,
        );
        fn CGImageDestinationFinalize(dest: *mut c_void) -> u8;
    }

    // ---- Accessibility (HIServices, via ApplicationServices) ----

    type AXUIElementRef = *const c_void;
    type AXValueRef = *const c_void;
    type AXError = i32;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> AXError;
        fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f32);
        fn AXValueGetValue(value: AXValueRef, the_type: u32, buffer: *mut c_void) -> u8;
        fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: CFTypeRef;
        static kCFTypeDictionaryKeyCallBacks: CFDictionaryKeyCallBacks;
        static kCFTypeDictionaryValueCallBacks: CFDictionaryValueCallBacks;
        fn CFDictionaryCreate(
            allocator: CFAllocatorRef,
            keys: *const *const c_void,
            values: *const *const c_void,
            num_values: CFIndex,
            key_call_backs: *const CFDictionaryKeyCallBacks,
            value_call_backs: *const CFDictionaryValueCallBacks,
        ) -> CFDictionaryRef;
    }

    #[repr(C)]
    struct CFDictionaryKeyCallBacks {
        version: CFIndex,
        retain: *const c_void,
        release: *const c_void,
        copy_description: *const c_void,
        equal: *const c_void,
        hash: *const c_void,
    }

    #[repr(C)]
    struct CFDictionaryValueCallBacks {
        version: CFIndex,
        retain: *const c_void,
        release: *const c_void,
        copy_description: *const c_void,
        equal: *const c_void,
    }

    const K_AX_VALUE_TYPE_POINT: u32 = 1;
    const K_AX_VALUE_TYPE_SIZE: u32 = 2;
    const K_AX_ERROR_SUCCESS: AXError = 0;

    /// How deep and how wide the AX walk goes. A window's tree can be thousands
    /// of nodes; the agent needs the shape, not the inventory.
    const AX_MAX_DEPTH: usize = 4;
    const AX_MAX_NODES: usize = 200;
    /// A slow AX server must not hold the capture hostage — past this the image
    /// ships without a tree.
    const AX_DEADLINE: Duration = Duration::from_secs(3);

    /// A CFString pointer that may live in a static map. The strings are
    /// immutable once created, which is what the unsafe impls vouch for.
    #[derive(Clone, Copy)]
    struct CfString(*const c_void);
    unsafe impl Send for CfString {}
    unsafe impl Sync for CfString {}

    /// Attribute and UTI strings, interned once: CFString keys are looked up on
    /// every window row, and leaking a fresh one per lookup would never end.
    fn key(name: &'static str) -> CFStringRef {
        static KEYS: LazyLock<Mutex<HashMap<&'static str, CfString>>> =
            LazyLock::new(|| Mutex::new(HashMap::new()));
        let mut keys = KEYS.lock().unwrap_or_else(|e| e.into_inner());
        let interned = keys.entry(name).or_insert_with(|| {
            let c = CString::new(name).unwrap_or_default();
            CfString(unsafe {
                CFStringCreateWithCString(ptr::null(), c.as_ptr(), K_CF_STRING_ENCODING_UTF8)
            })
        });
        interned.0
    }

    unsafe fn cf_to_string(string: CFStringRef) -> Option<String> {
        if string.is_null() {
            return None;
        }
        let mut buf = [0u8; 1024];
        let ok = CFStringGetCString(
            string,
            buf.as_mut_ptr() as *mut c_char,
            buf.len() as CFIndex,
            K_CF_STRING_ENCODING_UTF8,
        );
        if ok == 0 {
            return None;
        }
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        Some(String::from_utf8_lossy(&buf[..end]).into_owned())
    }

    /// One row of `CGWindowListCopyWindowInfo`, flattened to what the picker
    /// and the capture need. Pure data, so the picker is testable.
    pub struct WindowRow {
        pub id: u32,
        pub pid: i32,
        pub layer: i64,
        pub bounds: CGRect,
        pub owner: Option<String>,
        pub name: Option<String>,
    }

    /// The frontmost app window: the first layer-0 entry, since the list is
    /// ordered front to back and everything the UI draws above windows (menu
    /// bar, dock, overlays) lives on other layers. Emberyx itself is *not*
    /// skipped — pressing the shortcut while Emberyx is frontmost captures
    /// Emberyx.
    pub fn pick_frontmost(rows: &[WindowRow]) -> Option<&WindowRow> {
        rows.iter().find(|row| row.layer == 0)
    }

    unsafe fn dict_number(dict: CFDictionaryRef, key: CFStringRef) -> Option<f64> {
        let value = CFDictionaryGetValue(dict, key);
        if value.is_null() {
            return None;
        }
        let mut out: f64 = 0.0;
        if CFNumberGetValue(value, K_CF_NUMBER_FLOAT64, &mut out as *mut f64 as *mut c_void) != 0 {
            Some(out)
        } else {
            None
        }
    }

    unsafe fn dict_string(dict: CFDictionaryRef, key: CFStringRef) -> Option<String> {
        cf_to_string(CFDictionaryGetValue(dict, key) as CFStringRef)
    }

    unsafe fn copy_window_list() -> Vec<WindowRow> {
        let array = CGWindowListCopyWindowInfo(
            K_CG_WINDOW_LIST_ON_SCREEN_ONLY | K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
            0,
        );
        let mut rows = Vec::new();
        if !array.is_null() {
            let count = CFArrayGetCount(array);
            for i in 0..count {
                let dict = CFArrayGetValueAtIndex(array, i) as CFDictionaryRef;
                if dict.is_null() {
                    continue;
                }
                let bounds = CFDictionaryGetValue(dict, key("kCGWindowBounds")) as CFDictionaryRef;
                if bounds.is_null() {
                    continue;
                }
                let (Some(x), Some(y), Some(w), Some(h)) = (
                    dict_number(bounds, key("X")),
                    dict_number(bounds, key("Y")),
                    dict_number(bounds, key("Width")),
                    dict_number(bounds, key("Height")),
                ) else {
                    continue;
                };
                rows.push(WindowRow {
                    id: dict_number(dict, key("kCGWindowNumber")).unwrap_or(0.0) as u32,
                    pid: dict_number(dict, key("kCGWindowOwnerPID")).unwrap_or(0.0) as i32,
                    layer: dict_number(dict, key("kCGWindowLayer")).unwrap_or(0.0) as i64,
                    bounds: CGRect {
                        origin: CGPoint { x, y },
                        size: CGSize { width: w, height: h },
                    },
                    owner: dict_string(dict, key("kCGWindowOwnerName")),
                    name: dict_string(dict, key("kCGWindowName")),
                });
            }
            CFRelease(array);
        }
        rows
    }

    /// AX reports frames in bottom-left-origin screen space; the window bounds
    /// from CGWindowList are top-left-origin. Convert an element's frame into
    /// window space so the agent gets coordinates that match the PNG it sees.
    /// Known limit: the flip uses the *main* display's height, so bounds for a
    /// window on a secondary display arranged above or below it are off — the
    /// agent still gets the right shape and relative layout, just shifted.
    fn to_window_space(x: f64, y: f64, w: f64, h: f64, win: CGRect, screen_h: f64) -> (f64, f64, f64, f64) {
        let top_left_y = screen_h - y - h;
        (x - win.origin.x, top_left_y - win.origin.y, w, h)
    }

    struct AxBudget {
        nodes: usize,
        deadline: Instant,
        /// The window frame the walk's coordinates are relative to.
        win: CGRect,
    }

    /// Cap a string's byte length without cutting a UTF-8 character in half —
    /// `String::truncate` panics on a non-boundary index, and window titles
    /// are whatever the app wrote.
    fn clamp_chars(mut s: String, max: usize) -> String {
        if s.len() <= max {
            return s;
        }
        let mut end = max;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s
    }

    unsafe fn ax_string(element: AXUIElementRef, attribute: CFStringRef) -> Option<String> {
        let mut value: CFTypeRef = ptr::null();
        if AXUIElementCopyAttributeValue(element, attribute, &mut value) != K_AX_ERROR_SUCCESS {
            return None;
        }
        let text = cf_to_string(value).map(|s| clamp_chars(s, 200));
        CFRelease(value);
        text.filter(|s| !s.is_empty())
    }

    unsafe fn ax_frame(element: AXUIElementRef, win: CGRect) -> (f64, f64, f64, f64) {
        let mut position = CGPoint { x: 0.0, y: 0.0 };
        let mut size = CGSize { width: 0.0, height: 0.0 };
        for (attribute, the_type, out) in [
            (key("AXPosition"), K_AX_VALUE_TYPE_POINT, &mut position as *mut CGPoint as *mut c_void),
            (key("AXSize"), K_AX_VALUE_TYPE_SIZE, &mut size as *mut CGSize as *mut c_void),
        ] {
            let mut value: CFTypeRef = ptr::null();
            if AXUIElementCopyAttributeValue(element, attribute, &mut value) == K_AX_ERROR_SUCCESS
                && !value.is_null()
            {
                AXValueGetValue(value as AXValueRef, the_type, out);
                CFRelease(value);
            }
        }
        let screen_h = CGDisplayPixelsHigh(CGMainDisplayID()) as f64;
        to_window_space(position.x, position.y, size.width, size.height, win, screen_h)
    }

    unsafe fn ax_walk(element: AXUIElementRef, level: usize, budget: &mut AxBudget) -> Option<A11yNode> {
        if element.is_null()
            || level > AX_MAX_DEPTH
            || budget.nodes >= AX_MAX_NODES
            || Instant::now() > budget.deadline
        {
            return None;
        }
        budget.nodes += 1;
        let role = ax_string(element, key("AXRole"))?;
        let name = ax_string(element, key("AXTitle"))
            .or_else(|| ax_string(element, key("AXDescription")));
        let value = ax_string(element, key("AXValue"));
        let (x, y, w, h) = ax_frame(element, budget.win);

        let mut children = Vec::new();
        let mut list: CFTypeRef = ptr::null();
        if AXUIElementCopyAttributeValue(element, key("AXChildren"), &mut list)
            == K_AX_ERROR_SUCCESS
            && !list.is_null()
        {
            let count = CFArrayGetCount(list as CFArrayRef);
            for i in 0..count {
                let child = CFArrayGetValueAtIndex(list as CFArrayRef, i) as AXUIElementRef;
                if let Some(node) = ax_walk(child, level + 1, budget) {
                    children.push(node);
                }
            }
            CFRelease(list);
        }
        Some(A11yNode { role, name, value, x, y, w, h, children })
    }

    unsafe fn ax_tree(pid: i32, win: CGRect) -> Option<A11yNode> {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return None;
        }
        AXUIElementSetMessagingTimeout(app, 2.0);
        let window = ax_copy_element(app, key("AXFocusedWindow"))
            .or_else(|| ax_first_window(app));
        let tree = window.and_then(|w| {
            let mut budget = AxBudget {
                nodes: 0,
                deadline: Instant::now() + AX_DEADLINE,
                win,
            };
            ax_walk(w, 1, &mut budget)
        });
        if let Some(w) = window {
            CFRelease(w);
        }
        CFRelease(app);
        tree
    }

    unsafe fn ax_copy_element(element: AXUIElementRef, attribute: CFStringRef) -> Option<AXUIElementRef> {
        let mut value: CFTypeRef = ptr::null();
        if AXUIElementCopyAttributeValue(element, attribute, &mut value) != K_AX_ERROR_SUCCESS
            || value.is_null()
        {
            return None;
        }
        Some(value as AXUIElementRef)
    }

    unsafe fn ax_first_window(app: AXUIElementRef) -> Option<AXUIElementRef> {
        let mut list: CFTypeRef = ptr::null();
        if AXUIElementCopyAttributeValue(app, key("AXWindows"), &mut list) != K_AX_ERROR_SUCCESS
            || list.is_null()
            || CFArrayGetCount(list as CFArrayRef) == 0
        {
            if !list.is_null() {
                CFRelease(list);
            }
            return None;
        }
        let first = CFArrayGetValueAtIndex(list as CFArrayRef, 0) as AXUIElementRef;
        // The array holds a reference to the element; retain it out of the array
        // so the caller's single release balances.
        CFRetain(first);
        CFRelease(list);
        Some(first)
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    }

    unsafe fn capture_png(id: CGWindowID, bounds: CGRect) -> Option<Vec<u8>> {
        let image = CGWindowListCreateImage(
            bounds,
            K_CG_WINDOW_LIST_INCLUDING_WINDOW,
            id,
            K_CG_WINDOW_IMAGE_NO_SHADOW,
        );
        if image.is_null() {
            return None;
        }
        // Unique per capture: the tap and the settings test button can run at
        // the same moment, and two writers on one path would read each other's
        // bytes.
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "emberyx-snapshot-{}-{}.png",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let c_path = CString::new(path.as_os_str().to_string_lossy().as_bytes()).ok()?;
            let cf_path = CFStringCreateWithCString(ptr::null(), c_path.as_ptr(), K_CF_STRING_ENCODING_UTF8);
            let url = CFURLCreateWithFileSystemPath(ptr::null(), cf_path, K_CF_URL_POSIX_PATH_STYLE, 0);
            let dest = CGImageDestinationCreateWithURL(url, key("public.png"), 1, ptr::null());
            let ok = if dest.is_null() {
                false
            } else {
                CGImageDestinationAddImage(dest, image, ptr::null());
                let ok = CGImageDestinationFinalize(dest) != 0;
                CFRelease(dest);
                ok
            };
            if !url.is_null() {
                CFRelease(url);
            }
            if !cf_path.is_null() {
                CFRelease(cf_path);
            }
            if !ok {
                return None;
            }
            std::fs::read(&path).ok()
        })();
        let _ = std::fs::remove_file(&path);
        CFRelease(image);
        result
    }

    /// A successful capture this process: `CGPreflightScreenCaptureAccess` stays
    /// false until relaunch even after the user flips the System Settings
    /// toggle, so status also trusts a capture that actually produced pixels.
    static CAPTURED_OK: AtomicBool = AtomicBool::new(false);

    /// Capture whatever is frontmost right now. Shared by the tap and the
    /// settings page's test button.
    pub fn capture(include_text: bool) -> Result<SnapshotCapture> {
        let windows = unsafe { copy_window_list() };
        let Some(win) = pick_frontmost(&windows) else {
            return Err(err!("no frontmost window to capture"));
        };
        let app = win.owner.clone().unwrap_or_default();
        let title = win.name.clone().unwrap_or_default();
        // Preflight is cached until relaunch. Try the image first — a grant
        // that System Settings already shows as on often still photographs.
        let Some(bytes) = (unsafe { capture_png(win.id, win.bounds) }) else {
            if unsafe { CGPreflightScreenCaptureAccess() } == 0 {
                return Ok(SnapshotCapture {
                    app,
                    title,
                    error: Some(
                        "Screen Recording permission is missing — allow Emberyx in System Settings → Privacy & Security → Screen Recording, then quit and reopen Emberyx."
                            .into(),
                    ),
                    ..SnapshotCapture::default()
                });
            }
            return Err(err!("could not capture the frontmost window"));
        };
        CAPTURED_OK.store(true, Ordering::Relaxed);
        // A missing Accessibility grant degrades to image-only, the same way a
        // slow AX server does — the pixels are the part the user asked for.
        let a11y = if include_text && unsafe { AXIsProcessTrusted() } != 0 {
            unsafe { ax_tree(win.pid, win.bounds) }
        } else {
            None
        };
        Ok(SnapshotCapture {
            png: Some(STANDARD.encode(bytes)),
            app,
            title,
            a11y,
            error: None,
        })
    }

    // ---- The both-Shifts event tap ----

    struct TapContext {
        app: AppHandle,
        include_text: Arc<AtomicBool>,
        /// Rising-edge guard: one capture per press of the chord, not one per
        /// `flagsChanged` while both are held.
        both_down: AtomicBool,
        /// Shared with `ThreadState` so teardown never has to dereference this
        /// box from the manager thread — it flips the same `Arc`.
        alive: Arc<AtomicBool>,
        /// The tap itself, for re-enabling after a timeout disable.
        tap: AtomicPtr<c_void>,
    }

    struct RunLoopPtr(*mut c_void);
    unsafe impl Send for RunLoopPtr {}

    /// Shared between the manager thread and the tap thread. `context` is only
    /// dereferenced on the tap thread (callback, teardown); the manager side
    /// reaches shared flags through the `Arc`s, never through the raw pointer.
    struct ThreadState {
        run_loop: Mutex<Option<RunLoopPtr>>,
        stop: AtomicBool,
        alive: Arc<AtomicBool>,
        context: *mut TapContext,
    }
    unsafe impl Send for ThreadState {}
    unsafe impl Sync for ThreadState {}

    pub struct RunningTap {
        state: Arc<ThreadState>,
        include_text: Arc<AtomicBool>,
        handle: Option<JoinHandle<()>>,
    }

    unsafe extern "C" fn tap_callback(
        _proxy: *mut c_void,
        event_type: u32,
        event: *mut c_void,
        user_info: *mut c_void,
    ) -> *mut c_void {
        if user_info.is_null() || event.is_null() {
            return event;
        }
        let ctx = &*user_info.cast::<TapContext>();
        if !ctx.alive.load(Ordering::Acquire) {
            return event;
        }
        match event_type {
            K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT | K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT => {
                let tap = ctx.tap.load(Ordering::Acquire);
                if !tap.is_null() {
                    CGEventTapEnable(tap, 1);
                }
            }
            K_CG_EVENT_FLAGS_CHANGED => {
                let both = both_shifts_down(CGEventGetFlags(event));
                let was = ctx.both_down.swap(both, Ordering::Relaxed);
                if both && !was {
                    // Capture off the callback thread: a listen-only tap that
                    // stalls its run loop drops keystrokes system-wide.
                    let app = ctx.app.clone();
                    let include_text = ctx.include_text.load(Ordering::Relaxed);
                    std::thread::spawn(move || {
                        let payload = capture(include_text).unwrap_or_else(|e| SnapshotCapture {
                            error: Some(e.to_string()),
                            ..SnapshotCapture::default()
                        });
                        activate_main(&app);
                        let _ = app.emit("snapshot-captured", payload);
                    });
                }
            }
            _ => {}
        }
        event
    }

    /// Bring Emberyx back to the front after the capture, so the thumb the user
    /// is about to see is on the window they were looking at a moment ago.
    fn activate_main(app: &AppHandle) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
    }

    unsafe fn tap_thread(
        state: Arc<ThreadState>,
        report: std::sync::mpsc::Sender<std::result::Result<(), String>>,
    ) {
        let ctx = state.context;
        let tap = CGEventTapCreate(
            K_CG_HID_EVENT_TAP,
            K_CG_HEAD_INSERT_EVENT_TAP,
            K_CG_EVENT_TAP_OPTION_LISTEN_ONLY,
            1u64 << K_CG_EVENT_FLAGS_CHANGED,
            tap_callback,
            ctx as *mut c_void,
        );
        if tap.is_null() {
            drop(Box::from_raw(ctx));
            let _ = report.send(Err(
                "snapshots: could not create the global tap — grant Emberyx Input Monitoring in System Settings → Privacy & Security → Input Monitoring"
                    .into(),
            ));
            return;
        }
        (*ctx).tap.store(tap, Ordering::Release);
        CGEventTapEnable(tap, 1);
        let source = CFMachPortCreateRunLoopSource(ptr::null(), tap, 0);
        if source.is_null() {
            CFMachPortInvalidate(tap);
            CFRelease(tap);
            drop(Box::from_raw(ctx));
            let _ = report.send(Err("snapshots: could not schedule the global tap".into()));
            return;
        }
        let loop_ref = CFRunLoopGetCurrent();
        CFRunLoopAddSource(loop_ref, source, kCFRunLoopCommonModes);
        *state.run_loop.lock().unwrap_or_else(|e| e.into_inner()) = Some(RunLoopPtr(loop_ref));
        let _ = report.send(Ok(()));
        if !state.stop.load(Ordering::Acquire) {
            CFRunLoopRun();
        }
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        CFMachPortInvalidate(tap);
        CFRelease(tap);
        CFRelease(source);
        drop(Box::from_raw(ctx));
    }

    fn start_tap(app: AppHandle, include_text: bool) -> Result<RunningTap> {
        let include_text = Arc::new(AtomicBool::new(include_text));
        let alive = Arc::new(AtomicBool::new(true));
        let context = Box::into_raw(Box::new(TapContext {
            app,
            include_text: Arc::clone(&include_text),
            both_down: AtomicBool::new(false),
            alive: Arc::clone(&alive),
            tap: AtomicPtr::new(ptr::null_mut()),
        }));
        let state = Arc::new(ThreadState {
            run_loop: Mutex::new(None),
            stop: AtomicBool::new(false),
            alive,
            context,
        });
        let (tx, rx) =
            std::sync::mpsc::channel::<std::result::Result<(), String>>();
        let thread_state = Arc::clone(&state);
        let spawned = std::thread::Builder::new()
            .name("emberyx-snapshots".into())
            .spawn(move || unsafe { tap_thread(thread_state, tx) });
        let handle = match spawned {
            Ok(handle) => handle,
            Err(e) => {
                unsafe { drop(Box::from_raw(context)) };
                return Err(err!("snapshots: could not start the tap thread: {e}"));
            }
        };
        match rx.recv() {
            Ok(Ok(())) => Ok(RunningTap { state, include_text, handle: Some(handle) }),
            Ok(Err(e)) => Err(e.into()),
            Err(_) => Err(err!("snapshots: the tap thread died before it reported")),
        }
    }

    fn stop_tap(running: RunningTap) {
        running.state.stop.store(true, Ordering::Release);
        // The flag the callback reads, flipped through the shared Arc — no
        // dereference of the tap thread's box, which it frees on its way out.
        running.state.alive.store(false, Ordering::Release);
        let loop_ref = running
            .state
            .run_loop
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(RunLoopPtr(loop_ref)) = loop_ref {
            unsafe { CFRunLoopStop(loop_ref) };
        }
        if let Some(handle) = running.handle {
            let _ = handle.join();
        }
    }

    #[derive(Default)]
    struct ManagerState {
        tap: Option<RunningTap>,
        last_error: Option<String>,
    }

    #[derive(Default)]
    pub struct SnapshotManager {
        inner: Mutex<ManagerState>,
    }

    impl SnapshotManager {
        fn is_running(&self) -> bool {
            self.inner.lock().map(|g| g.tap.is_some()).unwrap_or(false)
        }

        fn last_error(&self) -> Option<String> {
            self.inner.lock().ok().and_then(|g| g.last_error.clone())
        }

        /// Start the tap only while enabled; a re-`set_enabled` with the same
        /// state just refreshes the "include app text" flag the callback reads.
        pub fn set_enabled(&self, app: AppHandle, enabled: bool, include_text: bool) -> Result<()> {
            let mut guard = self.inner.lock().map_err(|_| "snapshots: lock poisoned")?;
            match (enabled, guard.tap.is_some()) {
                (false, true) => {
                    if let Some(running) = guard.tap.take() {
                        stop_tap(running);
                    }
                    guard.last_error = None;
                    Ok(())
                }
                (true, true) => {
                    if let Some(running) = guard.tap.as_mut() {
                        running.include_text.store(include_text, Ordering::Relaxed);
                    }
                    Ok(())
                }
                (true, false) => match start_tap(app, include_text) {
                    Ok(running) => {
                        guard.tap = Some(running);
                        guard.last_error = None;
                        Ok(())
                    }
                    Err(e) => {
                        guard.last_error = Some(e.to_string());
                        Err(e)
                    }
                },
                (false, false) => Ok(()),
            }
        }

        /// Called from `RunEvent::Exit` — a global event tap must not outlive
        /// the app that registered it.
        pub fn kill_all(&self) {
            if let Ok(mut guard) = self.inner.lock() {
                if let Some(running) = guard.tap.take() {
                    stop_tap(running);
                }
            }
        }
    }

    pub fn status(manager: &SnapshotManager) -> SnapshotsStatus {
        SnapshotsStatus {
            platform: "macos",
            screen_recording: unsafe { CGPreflightScreenCaptureAccess() } != 0
                || CAPTURED_OK.load(Ordering::Relaxed),
            accessibility: unsafe { AXIsProcessTrusted() } != 0,
            tap_running: manager.is_running(),
            tap_error: manager.last_error(),
        }
    }

    fn permission_pane(kind: &str) -> Result<&'static str> {
        match kind {
            "screen" => {
                Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            }
            "accessibility" => {
                Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            }
            "input" => {
                Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
            }
            other => Err(err!("snapshots: unknown permission kind \"{other}\"")),
        }
    }

    fn prompt_accessibility() {
        // Puts Emberyx on the Accessibility list and shows the system sheet.
        // Opening the pane alone does not register an app that has never asked.
        unsafe {
            let prompt = kAXTrustedCheckOptionPrompt;
            if prompt.is_null() || kCFBooleanTrue.is_null() {
                return;
            }
            let keys: [*const c_void; 1] = [prompt as *const c_void];
            let values: [*const c_void; 1] = [kCFBooleanTrue];
            let dict = CFDictionaryCreate(
                ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks,
            );
            if !dict.is_null() {
                AXIsProcessTrustedWithOptions(dict);
                CFRelease(dict);
            }
        }
    }

    pub fn request_permission(kind: &str) -> Result<()> {
        match kind {
            "screen" => {
                unsafe { CGRequestScreenCaptureAccess() };
            }
            "accessibility" => prompt_accessibility(),
            "input" => {}
            other => return Err(err!("snapshots: unknown permission kind \"{other}\"")),
        }
        let pane = permission_pane(kind)?;
        let status = std::process::Command::new("open")
            .arg(pane)
            .status()
            .map_err(|e| err!("snapshots: could not open System Settings: {e}"))?;
        if !status.success() {
            return Err(err!("snapshots: System Settings did not open"));
        }
        Ok(())
    }

    pub fn set_enabled(app: &AppHandle, manager: &SnapshotManager, enabled: bool, include_text: bool) -> Result<()> {
        manager.set_enabled(app.clone(), enabled, include_text)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn row(id: u32, layer: i64, owner: &str) -> WindowRow {
            WindowRow {
                id,
                pid: 100 + id as i32,
                layer,
                bounds: CGRect {
                    origin: CGPoint { x: 0.0, y: 0.0 },
                    size: CGSize { width: 800.0, height: 600.0 },
                },
                owner: Some(owner.into()),
                name: Some(format!("window {id}")),
            }
        }

        // The list is front-to-back, so the first layer-0 row is the answer —
        // but only after the layers the system draws above windows are skipped.
        #[test]
        fn the_first_layer_zero_row_is_frontmost() {
            let rows = vec![
                row(1, 24, "SystemUIServer"), // menu bar
                row(2, 25, "Dock"),           // overlays
                row(3, 0, "Safari"),
                row(4, 0, "Finder"),
            ];
            assert_eq!(pick_frontmost(&rows).unwrap().owner.as_deref(), Some("Safari"));
        }

        // Pressing the shortcut while Emberyx is frontmost captures Emberyx —
        // the picker must not skip its own process.
        #[test]
        fn emberyx_is_a_legitimate_target() {
            let rows = vec![row(1, 24, "SystemUIServer"), row(2, 0, "emberyx")];
            assert_eq!(pick_frontmost(&rows).unwrap().owner.as_deref(), Some("emberyx"));
        }

        #[test]
        fn a_window_list_without_app_windows_has_no_frontmost() {
            let rows = vec![row(1, 24, "SystemUIServer"), row(2, -20, "Dock")];
            assert!(pick_frontmost(&rows).is_none());
        }

        #[test]
        fn both_shift_keys_down_is_the_trigger() {
            assert!(both_shifts_down(SHIFT_LEFT | SHIFT_RIGHT));
            assert!(both_shifts_down(SHIFT_LEFT | SHIFT_RIGHT | 0x0002_0000 | 0x0010_0010));
        }

        // One shift alone — the everyday capital letter — must never fire.
        #[test]
        fn a_single_shift_never_fires() {
            assert!(!both_shifts_down(0));
            assert!(!both_shifts_down(SHIFT_LEFT));
            assert!(!both_shifts_down(SHIFT_RIGHT));
            // The generic shift bit alone (a synthesised event without device
            // bits) cannot name a side, so it is not the chord.
            assert!(!both_shifts_down(0x0002_0000));
        }

        #[test]
        fn permission_panes_are_named_kinds() {
            assert!(permission_pane("screen").unwrap().contains("ScreenCapture"));
            assert!(permission_pane("accessibility").unwrap().contains("Accessibility"));
            assert!(permission_pane("input").unwrap().contains("ListenEvent"));
            assert!(permission_pane("camera").is_err());
        }

        #[test]
        fn ax_frames_land_in_window_space() {
            let win = CGRect {
                origin: CGPoint { x: 100.0, y: 200.0 },
                size: CGSize { width: 800.0, height: 600.0 },
            };
            // AX says the element sits at screen (150, 500) with height 40.
            // Top-left origin: y = 1080 - 500 - 40 = 540, minus the window's
            // own origin.
            let (x, y, w, h) = to_window_space(150.0, 500.0, 120.0, 40.0, win, 1080.0);
            assert_eq!((x, y, w, h), (50.0, 340.0, 120.0, 40.0));
        }

        // `String::truncate` would panic here — the cap must land on a
        // character boundary, not mid-emoji.
        #[test]
        fn clamping_never_cuts_a_character_in_half() {
            let multi_byte = "🦀".repeat(150); // 600 bytes, 150 chars
            let clamped = clamp_chars(multi_byte.clone(), 200);
            assert!(clamped.len() <= 200);
            assert_eq!(clamped.chars().count(), 50);
            // Short strings pass through untouched.
            assert_eq!(clamp_chars(multi_byte, 600).chars().count(), 150);
        }

        /// Exercises the real capture path against whatever is frontmost.
        /// Ignored by default: CI has no Screen Recording grant, and a test
        /// that silently passes without one would be worse than no test. Run
        /// with `cargo test -- --ignored snapshots_captures_the_frontmost`.
        #[test]
        #[ignore]
        fn snapshots_captures_the_frontmost() {
            let capture = capture(true).expect("capture failed");
            assert!(capture.error.is_none(), "error: {:?}", capture.error);
            let png = capture.png.expect("no png");
            assert!(png.len() > 1000, "png suspiciously small");
            assert!(!capture.app.is_empty(), "no owner name");
            let tree = capture.a11y.expect("no accessibility tree");
            assert!(!tree.role.is_empty());
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use tauri::AppHandle;

    use super::{SnapshotCapture, SnapshotsStatus};
    use crate::error::{err, Result};

    #[derive(Default)]
    pub struct SnapshotManager;

    impl SnapshotManager {
        pub fn kill_all(&self) {}
    }

    pub fn status(_manager: &SnapshotManager) -> SnapshotsStatus {
        SnapshotsStatus {
            platform: "other",
            screen_recording: false,
            accessibility: false,
            tap_running: false,
            tap_error: None,
        }
    }

    pub fn request_permission(_kind: &str) -> Result<()> {
        Err(err!("SnapShots is macOS only"))
    }

    pub fn set_enabled(
        _app: &AppHandle,
        _manager: &SnapshotManager,
        _enabled: bool,
        _include_text: bool,
    ) -> Result<()> {
        Err(err!("SnapShots is macOS only"))
    }

    pub fn capture(_include_text: bool) -> Result<SnapshotCapture> {
        Err(err!("SnapShots is macOS only"))
    }
}

pub use platform::SnapshotManager;

/// One node of the accessibility tree, bounds in window space.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct A11yNode {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<A11yNode>,
}

/// What one capture produced. `error` is set instead of failing the whole
/// event when a permission is missing — the user pressed a shortcut and must
/// hear why nothing appeared.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotCapture {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub png: Option<String>,
    pub app: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub a11y: Option<A11yNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotsStatus {
    pub platform: &'static str,
    pub screen_recording: bool,
    pub accessibility: bool,
    pub tap_running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tap_error: Option<String>,
}

#[tauri::command]
pub fn snapshots_status(manager: tauri::State<'_, SnapshotManager>) -> SnapshotsStatus {
    platform::status(&manager)
}

#[tauri::command]
pub fn snapshots_request_permission(kind: String) -> crate::error::Result<()> {
    platform::request_permission(&kind)
}

#[tauri::command]
pub fn snapshots_set_enabled(
    app: tauri::AppHandle,
    manager: tauri::State<'_, SnapshotManager>,
    enabled: bool,
    include_text: bool,
) -> crate::error::Result<()> {
    platform::set_enabled(&app, &manager, enabled, include_text)
}

/// A capture can take hundreds of milliseconds — off the main thread.
#[tauri::command]
pub async fn snapshots_capture(include_text: bool) -> crate::error::Result<SnapshotCapture> {
    crate::error::blocking(move || platform::capture(include_text)).await
}
