import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "todo-stories.spec.ts",
  workers: 1,
  use: { browserName: "chromium", baseURL: "http://127.0.0.1:5194" },
  webServer: {
    cwd: __dirname + "/../..",
    command: "bunx vite --config e2e/playwright/todo-stories.vite.ts --port 5194 --host 127.0.0.1",
    url: "http://127.0.0.1:5194/todo-stories.html",
    reuseExistingServer: false,
  },
});
