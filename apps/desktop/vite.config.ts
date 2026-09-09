import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Point @pierre/diffs at lib/pierreShiki.ts instead of the `shiki` barrel.
 *
 * pierre's `resolveLanguage` imports Shiki's `bundledLanguages`, ~290 grammar
 * loaders that Vite splits into a chunk each — ~10 MB of the 14 MB `dist`, for
 * languages this app never opens. The shim swaps that map for a curated one.
 *
 * Scoped to pierre's own files rather than done with `resolve.alias`, because
 * an alias is global: streamdown resolves its own Shiki and must keep it.
 */
const pierreShikiBundle = () => ({
  name: "emberyx:pierre-shiki-bundle",
  enforce: "pre" as const,
  resolveId(source: string, importer: string | undefined) {
    if (source !== "shiki" || importer == null) return null;
    if (!importer.includes("@pierre/diffs")) return null;
    return path.resolve(__dirname, "./src/lib/pierreShiki.ts");
  },
});

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [pierreShikiBundle(), react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // The @pierre/diffs highlighter worker code-splits, and Vite's default
  // worker format (iife) cannot: the build fails outright rather than
  // degrading, so this is required, not a tuning knob.
  worker: {
    format: "es",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
