import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const app = fileURLToPath(new URL("../../", import.meta.url))
const availablePort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

// Use the actual runner, configs and host. HTTP probes need no browser binary;
// they qualify process ownership/teardown, not a graphical app journey.
for (const config of ["playwright.config.ts", "playwright.showcase.config.ts"]) {
  for (const failed of [false, true]) {
    test.skipIf(process.platform === "win32")(`${config} cleans its host after a ${failed ? "failed" : "normal"} run`, async () => {
      const root = await mkdtemp(join(tmpdir(), "smithers-host-shutdown-"))
      const receipt = join(root, "owner.json")
      const port = await availablePort()
      let owner: { pid: number; home: string; pids: number[] } | undefined
      try {
        await symlink(join(app, "node_modules"), join(root, "node_modules"), "dir")
        await writeFile(join(root, "playwright.config.ts"), `import config from ${JSON.stringify(join(app, config))};
export default { ...config, testDir: ${JSON.stringify(root)}, testMatch: "shutdown.spec.ts", outputDir: ${JSON.stringify(join(root, "results"))}, webServer: { ...config.webServer, cwd: ${JSON.stringify(app)} } };
`)
        await writeFile(join(root, "shutdown.spec.ts"), `import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
test("owned host receipt", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  const owner = await response.json();
  const processes = execFileSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" }).trim().split("\\n").map(row => row.trim().split(/\\s+/).map(Number));
  const group = processes.find(([pid]) => pid === owner.pid)?.[1];
  expect(group).toBeDefined();
  const pids = processes.filter(([, pgid]) => pgid === group).map(([pid]) => pid);
  writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ ...owner, pids }));
  expect(owner.ok).toBe(${failed ? "false" : "true"});
});
`)
        const run = Bun.spawn(["bun", join(app, "node_modules/@playwright/test/cli.js"), "test", "--config", join(root, "playwright.config.ts")], {
          cwd: app,
          env: { ...process.env, SMITHERS_SKIP_SPA_BUILD: "1", SMITHERS_E2E_PORT: String(port), SMITHERS_SHOWCASE_PORT: String(port) },
          stdout: "pipe", stderr: "pipe"
        })
        const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
        expect(code, stdout + stderr).toBe(failed ? 1 : 0)
        owner = JSON.parse(await readFile(receipt, "utf8"))
        expect(owner!.pids).toContain(owner!.pid)
        const remaining = owner!.pids.filter(alive)
        console.log(JSON.stringify({ config, failed, code, owner, remaining, fixtureRemoved: !existsSync(owner!.home) }))
        expect(remaining).toEqual([])
        expect(existsSync(owner!.home)).toBe(false)
      } finally {
        // A red regression leaves the dead host's fixture; remove only that
        // exact owned directory, never data belonging to another process.
        if (owner && owner.pids.every((pid) => !alive(pid)) && dirname(owner.home) === tmpdir() && basename(owner.home).startsWith("smithers-browser-test-")) {
          await rm(owner.home, { recursive: true, force: true })
        }
        await rm(root, { recursive: true, force: true })
      }
    }, 300_000)
  }
}
