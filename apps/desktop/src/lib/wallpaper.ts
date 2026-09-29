/**
 * Custom window background. Rust keeps one image in the app data dir; this
 * reads it back and hands the webview a blob URL on `--wallpaper`, which
 * `index.css` paints behind the (translucent) chrome.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

export const WALLPAPER_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export const importWallpaper = (source: string) =>
  invoke<string>("wallpaper_import", { source });

export const clearWallpaper = () => invoke<void>("wallpaper_clear");

let objectUrl = "";
let latest = 0;

/** Paint `name` (a file `importWallpaper` returned), or nothing for "". */
export const applyWallpaper = async (name: string) => {
  if (!isTauri()) return;
  const root = document.documentElement.style;
  const call = ++latest;
  if (!name) {
    root.removeProperty("--wallpaper");
    URL.revokeObjectURL(objectUrl);
    objectUrl = "";
    return;
  }
  const bytes = await invoke<ArrayBuffer>("wallpaper_read", { name });
  // A newer pick landed while this one was reading.
  if (call !== latest) return;
  const ext = name.slice(name.lastIndexOf(".") + 1);
  const url = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] }));
  root.setProperty("--wallpaper", `url("${url}")`);
  URL.revokeObjectURL(objectUrl);
  objectUrl = url;
};
