/** Explicit opt-in acceptance runner; the target supplies the story environment. */
const child = Bun.spawn(["pnpm", "exec", "playwright", "test", "--config", "playwright.config.ts", "e2e/playwright/view-stories.spec.ts"], {
  cwd: import.meta.dir + "/..", env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit"
})
process.exit(await child.exited)
