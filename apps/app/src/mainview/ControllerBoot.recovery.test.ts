import { expect, test } from "bun:test"

/** Run in its own process so module mocks cannot leak into unrelated app tests. */
test("a failed recorded store stops boot before repository, identity, or URL-triggered work", () => {
  const run = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/ControllerBoot.recovery.fixture.ts`],
    cwd: `${import.meta.dir}/../..`,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe"
  })
  expect(run.exitCode).toBe(0)
  expect(new TextDecoder().decode(run.stdout)).toContain("recovery boot stopped before repository")
})
