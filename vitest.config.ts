import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Hermetic unit tests only — no network, no yt-dlp subprocess. Any live integration
    // smoke test (talking to real yt-dlp / YouTube) is opt-in and named *.live.test.ts.
    include: ["src/__tests__/**/*.test.ts"],
    exclude: ["src/__tests__/**/*.live.test.ts", "node_modules/**"],
    testTimeout: 15000,
  },
});
