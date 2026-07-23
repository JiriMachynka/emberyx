import { defineConfig } from "vitest/config";
import path from "node:path";

// Kept out of vite.config.ts so tests don't pull in the Tauri dev-server and
// Tailwind plugin config, neither of which a node-side test run needs.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
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
