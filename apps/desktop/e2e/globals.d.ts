export {};

declare global {
  interface Window {
    /** Tauri's IPC bridge, injected into every webview whether or not
     *  `withGlobalTauri` is on. Specs only resolve paths through it. */
    __TAURI_INTERNALS__: {
      invoke: (cmd: string, args?: Record<string, string | number>) => Promise<string>;
    };
    /** Bench-only: DOM-quiescence probe the diff spec installs before opening
     *  a diff. Set by the spec, read back to time the render. */
    __emberyxBench?: { last: number; count: number };
  }
}
