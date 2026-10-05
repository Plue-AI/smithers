import { expect, test } from "bun:test"

/*
 * mvp.md §6.1 and spec §16.3.2: the app boots on a plain-HTTP LAN origin. Before T-INS-04 the first
 * crypto.randomUUID() call (AppStore) threw and the page stayed blank. Its own process: the fixture replaces `crypto`.
 */
test("the app boots to Setup without crypto.randomUUID, crypto.subtle or Web Locks", () => {
  const run = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/ControllerBoot.insecure.fixture.ts`],
    cwd: `${import.meta.dir}/../..`,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe"
  })
  const output = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr)
  expect(output).toContain("insecure boot reached Setup: repository,models,source,machine")
  expect(run.exitCode).toBe(0)
})
