/**
 * A file flow's declared `capabilities` bound every host service its actions
 * resolve, through the real `flow start` path: the spawner, the filesystem,
 * the repository and the network are the kernel's, never the engine's own.
 */
import { execFile, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const run = promisify(execFile)
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const preload = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const fixture = fileURLToPath(new URL("./fixtures/capability-ceiling", import.meta.url))
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url))

interface Outcomes {
  readonly spawn: string
  readonly write: string
  readonly jj: string
  readonly http: string
}

const findOutcomes = (value: unknown): Outcomes | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (["spawn", "write", "jj", "http"].every((key) => typeof record[key] === "string")) {
    return record as unknown as Outcomes
  }
  for (const nested of Object.values(record)) {
    const found = findOutcomes(nested)
    if (found !== undefined) return found
  }
  return undefined
}

const denied = /permission[_ ]denied|outside (?:the )?(?:capability )?ceiling|PermissionDenied/i

let server: Server
let requests = 0
let url = ""
beforeAll(async () => {
  server = createServer((_, response) => {
    requests += 1
    response.end("reached")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/probe`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const start = async (flow: "deny" | "spawn") => {
  // The directory name stays free of the repository's name so a local jj
  // wrapper never mistakes this scratch repository for the checkout.
  const root = await realpath(await mkdtemp(join(tmpdir(), "ceiling-")))
  await cp(join(fixture, "flows"), join(root, "flows"), { recursive: true })
  await cp(join(fixture, "probe.ts"), join(root, "probe.ts"))
  await mkdir(join(root, ".flows"))
  await symlink(nodeModules, join(root, "node_modules"), "dir")
  execFileSync("jj", ["git", "init", root], { stdio: "ignore" })
  const marker = join(root, "spawned-marker")
  const written = join(root, "written.txt")
  const environment = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "config"),
    AI_GATEWAY_API_KEY: "",
    SMITHERS_REMOTE: "",
    NODE_OPTIONS: ""
  }
  const command = (arguments_: ReadonlyArray<string>) =>
    run(process.execPath, ["--no-warnings", "--import", preload, bin, ...arguments_], {
      cwd: root,
      env: environment,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    }).catch((cause: unknown) => {
      const failure = cause as { message: string; stdout?: string; stderr?: string }
      throw new Error(`${failure.message}\nstdout: ${failure.stdout ?? ""}\nstderr: ${failure.stderr ?? ""}`)
    })
  const before = requests
  const started = await command([
    "flow",
    "start",
    flow,
    "--data",
    JSON.stringify({ marker, written, url }),
    "--wait",
    "--json"
  ])
  const { runId } = JSON.parse(started.stdout) as { runId: string }
  const shown = await command(["runs", "show", runId, "--json"])
  const logs = await command(["runs", "logs", runId, "--format", "jsonl"])
  const outcomes = logs.stdout.trim().split("\n").map((line) => findOutcomes(JSON.parse(line)))
    .find((found) => found !== undefined)
  expect(outcomes, `${shown.stdout}\n${logs.stdout}`).toBeDefined()
  return {
    root,
    status: (JSON.parse(shown.stdout) as { status: string }).status,
    outcomes: outcomes!,
    spawned: existsSync(marker),
    written: existsSync(written),
    // The engine's own step snapshot around the compensable action, taken on
    // its privileged repository rather than the action's guarded one.
    engineSnapshot: /"snapshotId":"[0-9a-f]{40}"/.test(logs.stdout),
    requested: requests - before
  }
}

describe("a file flow's capability ceiling", () => {
  it("denies spawn, write, jj and network to an action declared with no capabilities", async () => {
    const result = await start("deny")
    try {
      expect(result.status).toBe("completed")
      expect(result.outcomes.spawn).toMatch(denied)
      expect(result.outcomes.write).toMatch(denied)
      expect(result.outcomes.jj).toMatch(denied)
      expect(result.outcomes.http).toMatch(denied)
      expect(result.spawned).toBe(false)
      expect(result.written).toBe(false)
      expect(result.engineSnapshot).toBe(true)
      expect(result.requested).toBe(0)
    } finally {
      await rm(result.root, { recursive: true, force: true })
    }
  }, 240_000)

  it("admits exactly the declared spawn and still refuses every undeclared service", async () => {
    const result = await start("spawn")
    try {
      expect(result.status).toBe("completed")
      // The spawn is admitted and the child runs; the child's own write is
      // still confined to the filesystem grants, which declare none.
      expect(result.outcomes.spawn).toMatch(/: ran$/)
      expect(result.spawned).toBe(false)
      expect(result.outcomes.write).toMatch(denied)
      expect(result.written).toBe(false)
      expect(result.outcomes.jj).toMatch(denied)
      expect(result.engineSnapshot).toBe(true)
      expect(result.outcomes.http).toMatch(denied)
      expect(result.requested).toBe(0)
    } finally {
      await rm(result.root, { recursive: true, force: true })
    }
  }, 240_000)
})
