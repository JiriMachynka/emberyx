import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Kept out of vite.config.ts so tests don't pull in the Tauri dev-server and
// Tailwind plugin config, neither of which a node-side test run needs. The
// React Compiler is the exception: it changes what the code does at runtime,
// so the tests run the compiled output the app ships. (`bun test` cannot run
// Babel plugins and tests the uncompiled source — same semantics for code that
// keeps the Rules of React, which is exactly what the compiler relies on.)
export default defineConfig({
  plugins: [react({ babel: { plugins: ["babel-plugin-react-compiler"] } })],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/hooks/**"],
    },
  },
});
