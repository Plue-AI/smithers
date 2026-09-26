/** Bash capture in a git repository: the VCS's own before/after, relative to the working directory. */
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Changes from "../src/changes.ts"

const sh = (cwd: string, ...command: string[]) => {
  const result = Bun.spawnSync(command, { cwd, stdout: "ignore", stderr: "ignore" })
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed`)
}
const repository = (commit = true) => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-capture-"))
  sh(cwd, "git", "init", "-q")
  if (commit) {
    writeFileSync(join(cwd, "root.ts"), "root\n")
    mkdirSync(join(cwd, "sub"))
    writeFileSync(join(cwd, "sub", "tracked.ts"), "one\n")
    sh(cwd, "git", "add", "-A")
    sh(cwd, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
  }
  return cwd
}
/** Runs one captured bash call whose body is `effect`, from `cwd`. */
const bash = async (
  cwd: string,
  effect: () => void,
  input: unknown = { command: "x" }
): Promise<ReadonlyArray<Changes.Receipt>> => {
  const receipts: Array<Changes.Receipt> = []
  const source = {
    name: "test",
    bindings: () =>
      Effect.succeed([{
        descriptor: { name: "bash" },
        run: () => Effect.sync(() => (effect(), { outcome: "success" }))
      }])
  } as unknown as Parameters<typeof Changes.capture>[0]
  const [binding] = await Effect.runPromise(
    Changes.capture(source, cwd, (receipt) => receipts.push(receipt)).bindings()
  )
  await Effect.runPromise(
    binding!.run({ flowName: "bash", input, identity: { session: "t", frame: 1, ordinal: 0 } } as never)
  )
  return receipts
}

describe("bash capture under git", () => {
  it("validates input before invoking jj or git", async () => {
    const cwd = repository()
    const bin = join(cwd, "bin")
    mkdirSync(bin)
    const marker = join(cwd, "vcs-called")
    for (const program of ["jj", "git"]) {
      const executable = join(bin, program)
      writeFileSync(executable, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`)
      chmodSync(executable, 0o755)
    }
    const script = `import { Effect } from "effect";
      import * as Changes from "./src/changes.ts";
      const source = { name: "test", bindings: () => Effect.succeed([{ descriptor: { name: "bash" }, run: () => Effect.succeed({ outcome: "success" }) }]) };
      const [binding] = await Effect.runPromise(Changes.capture(source, process.env.TEST_CWD, () => {}).bindings());
      await Effect.runPromise(binding.run({ flowName: "bash", input: { command: "x", timeoutMs: "bad" }, identity: { session: "t", frame: 1, ordinal: 0 } }));
      await Effect.runPromise(binding.run({ flowName: "bash", input: { command: "x", cwd: { at: "base" } }, identity: { session: "t", frame: 1, ordinal: 1 } }));`
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_CWD: cwd },
      stdout: "pipe",
      stderr: "pipe"
    })
    expect(child.exitCode).toBe(0)
    expect(existsSync(marker)).toBe(false)
  })
  it("names tracked and untracked changes relative to a subdirectory working directory", async () => {
    const root = repository()
    const cwd = join(root, "sub")
    const receipts = await bash(cwd, () => {
      writeFileSync(join(cwd, "tracked.ts"), "two\n")
      writeFileSync(join(cwd, "new.ts"), "fresh\n")
    })
    expect(receipts).toHaveLength(1)
    const paths = receipts[0]!.patches.map((patch) => patch.path).sort()
    expect(paths).toEqual(["new.ts", "tracked.ts"])
    const tracked = receipts[0]!.patches.find((patch) => patch.path === "tracked.ts")!.patch
    expect(tracked).toContain("-one")
    expect(tracked).toContain("+two")
  }, 20_000)

  it("attributes only the call's own change when 900 files were already dirty", async () => {
    const cwd = repository()
    for (let index = 0; index < 900; index++) writeFileSync(join(cwd, `dirty-${index}.txt`), `${index}\n`)
    writeFileSync(join(cwd, "root.ts"), "edited before the call\n")
    const receipts = await bash(cwd, () => writeFileSync(join(cwd, "root.ts"), "edited by the call\n"))
    expect(receipts[0]!.patches.map((patch) => patch.path)).toEqual(["root.ts"])
    expect(receipts[0]!.patches[0]!.patch).toContain("-edited before the call")
    expect(receipts[0]!.patches[0]!.patch).toContain("+edited by the call")
  }, 60_000)

  it("uses the pre-call index when bash stages its edit", async () => {
    const cwd = repository()
    const receipts = await bash(cwd, () => {
      writeFileSync(join(cwd, "root.ts"), "staged by the call\n")
      sh(cwd, "git", "add", "root.ts")
    })
    expect(receipts[0]?.patches.map((patch) => patch.path)).toEqual(["root.ts"])
    expect(receipts[0]?.patches[0]?.patch).toContain("-root")
    expect(receipts[0]?.patches[0]?.patch).toContain("+staged by the call")
  }, 20_000)

  it("captures a repository with no commit yet", async () => {
    const cwd = repository(false)
    const receipts = await bash(cwd, () => writeFileSync(join(cwd, "first.ts"), "hello\n"))
    expect(receipts[0]!.patches.map((patch) => patch.path)).toEqual(["first.ts"])
  }, 20_000)

  it("emits a verified-empty receipt for a no-op in a repository, but none outside one", async () => {
    expect((await bash(repository(), () => {})).map((receipt) => receipt.patches)).toEqual([[]])
    expect(await bash(mkdtempSync(join(tmpdir(), "tui-capture-")), () => {})).toEqual([])
  }, 20_000)
})

describe("named write capture", () => {
  const run = async (cwd: string, input: unknown, effect: () => void, flow = "write") => {
    const receipts: Changes.Receipt[] = []
    const source = {
      name: "test",
      bindings: () =>
        Effect.succeed([{
          descriptor: { name: flow },
          run: () => Effect.sync(() => (effect(), { outcome: "success" }))
        }])
    } as unknown as Parameters<typeof Changes.capture>[0]
    const [binding] = await Effect.runPromise(
      Changes.capture(source, cwd, (receipt) => receipts.push(receipt)).bindings()
    )
    await Effect.runPromise(
      binding!.run({ flowName: flow, input, identity: { session: "t", frame: 1, ordinal: 0 } } as never)
    )
    return receipts
  }

  it("reports a permission change with unchanged bytes", async () => {
    const cwd = repository()
    const target = join(cwd, "root.ts")
    chmodSync(target, 0o644)
    const receipts = await run(cwd, { path: "root.ts", content: "root\n" }, () => chmodSync(target, 0o755))
    expect(receipts[0]?.patches[0]?.patch).toContain("new mode 100755")
  })

  it("emits no receipt for an unchanged binary file", async () => {
    const cwd = repository()
    writeFileSync(join(cwd, "binary.dat"), Buffer.from([0, 1, 2]))
    expect(await run(cwd, { path: "binary.dat", content: "x" }, () => {})).toEqual([])
  })

  it("counts only changed files beyond the patch display limit", async () => {
    const cwd = repository()
    const input = {
      input: `*** Begin Patch\n${
        Array.from({ length: 202 }, (_, i) => `*** Add File: f-${i}.txt\n+new`).join("\n")
      }\n*** End Patch`
    }
    const receipts = await run(cwd, input, () => {
      for (let i = 0; i < 201; i++) writeFileSync(join(cwd, `f-${i}.txt`), "new\n")
    }, "apply_patch")
    expect(receipts[0]?.patches).toHaveLength(201)
    expect(receipts[0]?.patches.at(-1)?.patch).toContain("1 additional files")
  }, 20_000)
})

describe("patch", () => {
  it("diffs a small edit even when the process stalls mid-diff", () => {
    // Under CPU load the process can be descheduled for over 100 ms inside one
    // synchronous diff. A wall-clock budget then labeled a one-line edit
    // "Diff too large" and undo refused it as binary or large.
    const now = Date.now
    let clock = now()
    Date.now = () => (clock += 150)
    try {
      const patch = Changes.patch(
        "math.js",
        "export const add = (a, b) => a - b\n",
        "export const add = (a, b) => a + b\n"
      )
      expect(patch?.patch).toContain("-export const add = (a, b) => a - b")
      expect(patch?.patch).toContain("+export const add = (a, b) => a + b")
    } finally {
      Date.now = now
    }
  })
  it("labels a rewrite beyond the edit bound too large, whatever the clock", () => {
    const lines = (prefix: string) => Array.from({ length: 600 }, (_, i) => `${prefix}${i}`).join("\n")
    expect(Changes.patch("big.txt", lines("a"), lines("b"))?.patch).toBe("Diff too large: big.txt")
  })
})
