import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test",
  timeout: 30_000,
  workers: 1,
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 960 },
    colorScheme: "light",
  },
  reporter: "list",
  outputDir: "./test-results",
});
