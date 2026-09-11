export {};

declare global {
  interface Window {
    /** Tauri's IPC bridge, injected into every webview whether or not
     *  `withGlobalTauri` is on. Specs only resolve paths through it. */
    __TAURI_INTERNALS__: {
      invoke: (cmd: string, args?: Record<string, string | number>) => Promise<string>;
    };
  }
}
