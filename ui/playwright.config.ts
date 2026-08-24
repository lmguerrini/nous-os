import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  retries: 0,
  use: {
    // The webServer below declares where the static root is served, but a relative
    // page.goto("/") has nothing to resolve against without this. Kept in sync with
    // webServer.url deliberately: two places naming one port is the defect waiting
    // to happen, and this is the smaller of the two evils Playwright offers.
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    headless: true,
    viewport: { width: 1_280, height: 900 },
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
    launchOptions: {
      args: [
        "--use-angle=swiftshader",
        "--use-gl=angle",
        "--disable-gpu-vsync",
        "--force-color-profile=srgb",
      ],
    },
  },
  projects: [
    { name: "dpr-1", use: { deviceScaleFactor: 1 } },
    { name: "dpr-2", use: { deviceScaleFactor: 2 } },
  ],
  webServer: {
    command: "python3 -m http.server 4173 --directory ..",
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
