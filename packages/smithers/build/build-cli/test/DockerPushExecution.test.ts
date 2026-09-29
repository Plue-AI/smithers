import { Smithers as S } from "@smthrs/targets"
import * as Stamp from "@smthrs/targets/Stamp"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as StampExec from "../src/StampExec.ts"

const directories: Array<string> = []
const bounded = async (waiting: Promise<void>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      waiting,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("second push did not start within 10s")), 10_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
afterAll(async () => {
  await Promise.all(directories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

// Executor UNIT fixture only: this synthetic ready plan exercises ordered
// dispatch, not public approval. CLI approval integration remains refused;
// no approval guard or real Docker daemon is involved in this fixture.
const fixture = async (mode: "failure" | "hold", tags = ["one", "two", "three"], prefix = "registry.invalid/unit:") => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-push-unit-")))
  directories.push(root)
  const control = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-push-control-"))
  directories.push(control)
  await Fs.cp(Path.join(import.meta.dirname, "fixtures/chain-exec"), root, { recursive: true })
  await Fs.writeFile(
    Path.join(root, "PACKAGE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  push: S.Shell.Run({ shell: "true", sandbox: "none" })
} })
`
  )
  const calls = Path.join(control, "calls.jsonl")
  const release = Path.join(control, "release")
  const script = Path.join(control, "docker.mjs")
  const pids = Path.join(control, "pids.jsonl")
  const exits = Path.join(control, "exits.jsonl")
  await Fs.writeFile(
    script,
    `import { appendFileSync, existsSync } from "node:fs";
const image = process.argv[3];
appendFileSync(${JSON.stringify(pids)}, JSON.stringify(process.pid) + "\\n");
process.on("exit", () => appendFileSync(${JSON.stringify(exits)}, JSON.stringify(process.pid) + "\\n"));
process.on("SIGTERM", () => process.exit(143));
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (image.endsWith(":two")) {
  if (${JSON.stringify(mode)} === "failure") process.exit(23);
  if (${JSON.stringify(mode)} === "hold") {
    console.error("SECOND_PUSH_WAITING");
    const poll = setInterval(() => {
      if (existsSync(${JSON.stringify(release)})) { clearInterval(poll); process.exit(0); }
    }, 10);
  }
}
`
  )
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)
  const options: PackageExec.RunOptions = {
    index,
    cacheDirectory: ".flows",
    verb: "auto",
    patterns: ["//:push"],
    readCache: false,
    environment: { PATH: Path.dirname(process.execPath) }
  }
  const base = (await PackageExec.plan(options)).workList.find((node) => node.label === "//:push")!
  const commands = tags.map((
    tag
  ) => [process.execPath, script, "push", `${prefix}${tag}`])
  const node: PackageExec.PackageNode = {
    ...base,
    family: "container",
    rule: "Docker.Push",
    declaration: S.Docker.Push({
      image: S.Docker.Build({ dockerfile: S.file("Dockerfile"), context: "." }),
      registry: "registry.invalid",
      name: "unit",
      tags: ["unit"],
      approval: "required",
      sandbox: "none"
    }),
    lane: { kind: "docker-push", commands },
    argv: commands[0],
    env: {},
    secrets: [],
    cacheable: false,
    refusal: undefined
  }
  const planned: PackageExec.PackagePlan = {
    roots: [node.label],
    workList: [node],
    nodes: new Map([[node.label, node]]),
    closures: new Map()
  }
  const readLines = async (file: string): Promise<Array<unknown>> => {
    const text = await Fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
    return text.trim() === "" ? [] : text.trim().split("\n").map((line) => JSON.parse(line))
  }
  const observed = () => readLines(calls)
  let notifyWaiting!: () => void
  const waiting = new Promise<void>((resolve) => {
    notifyWaiting = resolve
  })
  return {
    planned,
    options,
    observed,
    release,
    waiting,
    childPids: () => readLines(pids),
    childExits: () => readLines(exits),
    log: (line: string) => {
      if (line.includes("SECOND_PUSH_WAITING")) notifyWaiting()
    }
  }
}

describe("Docker push executor unit boundary", () => {
  it("refuses a reference outside the declared registry and name before spawning", async () => {
    const host = await fixture("failure", ["one"], "other.invalid/unit:")
    const summary = await PackageExec.execute(host.planned, { ...host.options, log: () => {} })
    expect(summary.ok).toBe(false)
    expect(summary.results[0]?.error).toContain("declared registry and name")
    expect(await host.childPids()).toEqual([])
  })
  for (
    const value of [
      "",
      " ",
      "bad:tag",
      "bad/tag",
      "a".repeat(129),
      "one\n",
      "one\r\n",
      "2026-09-29T16:00:00.000Z",
      Stamp.buildTime
    ]
  ) {
    it(`refuses an invalid resolved stamp before spawning ${JSON.stringify(value)}`, async () => {
      // The empty literal models versionMeta's empty result without Git writes.
      const host = await fixture("failure", [StampExec.token(value === "" ? "versionMeta" : "docker-tag", value)])
      const summary = await PackageExec.execute(host.planned, { ...host.options, log: () => {} })
      expect.soft(summary.ok).toBe(false)
      expect.soft(summary.results).toMatchObject([{ status: "failed" }])
      expect.soft(summary.results[0]?.error).toContain("Docker.Push")
      expect.soft(await host.observed()).toEqual([])
      expect(await host.childPids()).toEqual([])
    })
  }
  it("pushes a valid resolved stamp", async () => {
    const host = await fixture("failure", [StampExec.token("docker-tag", "release_1.0-rc")])
    const summary = await PackageExec.execute(host.planned, { ...host.options, log: () => {} })
    expect(summary.ok).toBe(true)
    expect(await host.observed()).toEqual([["push", "registry.invalid/unit:release_1.0-rc"]])
  })
  it("reports success only after every ordered push finishes", async () => {
    const host = await fixture("hold")
    const controller = new AbortController()
    let settled = false
    const running = PackageExec.execute(host.planned, { ...host.options, signal: controller.signal, log: host.log })
      .then((summary) => {
        settled = true
        return summary
      })
    try {
      await bounded(Promise.race([
        host.waiting,
        running.then(() => {
          throw new Error("executor settled before second push waited")
        })
      ]))
      expect(settled).toBe(false)
      expect(await host.observed()).toEqual([
        ["push", "registry.invalid/unit:one"],
        ["push", "registry.invalid/unit:two"]
      ])
      await Fs.writeFile(host.release, "release")
      const summary = await running
      expect(summary.ok).toBe(true)
      expect(summary.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
      expect(summary.results).toMatchObject([{ label: "//:push", status: "ran" }])
      expect(await host.observed()).toEqual([
        ["push", "registry.invalid/unit:one"],
        ["push", "registry.invalid/unit:two"],
        ["push", "registry.invalid/unit:three"]
      ])
    } finally {
      controller.abort()
      await running.catch(() => {})
    }
  })

  it("fails a later push and never starts subsequent tags", async () => {
    const host = await fixture("failure")
    const summary = await PackageExec.execute(host.planned, { ...host.options, log: () => {} })
    expect(summary.ok).toBe(false)
    expect(summary.counts).toEqual({ hit: 0, ran: 0, failed: 1, skipped: 0 })
    expect(summary.results).toMatchObject([{ label: "//:push", status: "failed" }])
    expect(summary.results[0]?.error).toContain("23")
    expect(await host.observed()).toEqual([
      ["push", "registry.invalid/unit:one"],
      ["push", "registry.invalid/unit:two"]
    ])
  })

  it("cancels the current push before subsequent tags can start", async () => {
    const host = await fixture("hold")
    const controller = new AbortController()
    const running = PackageExec.execute(host.planned, { ...host.options, signal: controller.signal, log: host.log })
    // Install the rejection handler before aborting the running child.
    const outcome = running.then((summary) => ({ summary }), (error: unknown) => ({ error }))
    try {
      await bounded(Promise.race([
        host.waiting,
        outcome.then(() => {
          throw new Error("executor settled before cancellation")
        })
      ]))
    } finally {
      controller.abort()
      await outcome
    }
    const result = await outcome
    expect("error" in result || ("summary" in result && !result.summary.ok)).toBe(true)
    expect(await host.observed()).toEqual([
      ["push", "registry.invalid/unit:one"],
      ["push", "registry.invalid/unit:two"]
    ])
    const pids = await host.childPids()
    expect(pids).toHaveLength(2)
    // Forced termination may bypass JS exit handlers. The normal first
    // child has an exit receipt; OS liveness checks cover the aborted child.
    expect(await host.childExits()).toContain(pids[0])
    for (const pid of pids) {
      expect(() => process.kill(pid as number, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    }
  })
})
