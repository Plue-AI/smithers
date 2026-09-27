import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Host from "../src/host.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A recorded model whose every frame reads `check-status.txt` and answers with its text. */
const readReplay = (directory: string): string => {
  const path = JSON.stringify(join(directory, "check-status.txt"))
  const file = join(directory, "read.jsonl")
  const delta = (value: object) => JSON.stringify({ at: 0, event: { _tag: "model-delta", delta: value } })
  const cell = `const r = await ctx.call("read", { path: ${path} }); ctx.done(JSON.stringify(r))`
  writeFileSync(
    file,
    [
      JSON.stringify({ at: 0, event: { _tag: "model-requested" } }),
      delta({ type: "text-start", id: "cell" }),
      delta({ type: "text-delta", id: "cell", text: `\`\`\`cell\n${cell}\n\`\`\`` }),
      delta({ type: "text-end", id: "cell" }),
      JSON.stringify({ at: 0, event: { _tag: "model-settled", message: { stopReason: "stop" } } })
    ].join("\n")
  )
  return file
}

describe("Host.run between-turn reads (#1948)", () => {
  const session = (role?: "worker") => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-read-cache-"))
    roots.push(cwd)
    writeFileSync(join(cwd, "check-status.txt"), "2 checks passed")
    const host = Host.make({ cwd, environment: {}, judge: ScriptedJudge.layer, approvals: "all" })
    const seat = `replay:${readReplay(cwd)}`
    const answer = async () => {
      const outcome = await host.run({
        prompt: "read",
        seat,
        history: [],
        onEvent: () => {},
        ...(role === undefined ? {} : { role })
      }).done
      if (outcome._tag !== "done") throw new Error(JSON.stringify(outcome))
      return outcome.answer
    }
    return { cwd, host, answer }
  }

  test("a chat turn reads what an interactive shell wrote after the previous turn", async () => {
    const { cwd, host, answer } = session()
    try {
      expect(await answer()).toContain("2 checks passed")
      // The `!printf stop-monitor > check-status.txt` the issue ran between turns.
      execFileSync("sh", ["-c", "printf stop-monitor > check-status.txt"], { cwd })
      expect(await answer()).toContain("stop-monitor")
    } finally {
      await host.dispose()
    }
  })

  test("a worker turn reads an edit made between turns, and an unchanged tree reads the same", async () => {
    const { cwd, host, answer } = session("worker")
    try {
      expect(await answer()).toContain("2 checks passed")
      expect(await answer()).toContain("2 checks passed")
      writeFileSync(join(cwd, "check-status.txt"), "stop-monitor")
      expect(await answer()).toContain("stop-monitor")
    } finally {
      await host.dispose()
    }
  })

  test("a later frame sees another worker's edit during the model wait without claiming that edit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-midrun-read-"))
    roots.push(cwd)
    writeFileSync(join(cwd, "check-status.txt"), "original")
    const file = readReplay(cwd)
    const recorded = readFileSync(file, "utf8")
    // First frame observes; the next frame answers using the same read input.
    writeFileSync(
      file,
      recorded.replace("ctx.done(JSON.stringify(r))", "console.log(JSON.stringify(r))") + "\n" + recorded
    )
    const host = Host.make({ cwd, environment: {}, judge: ScriptedJudge.layer, approvals: "all" })
    let requests = 0
    const mutations: boolean[] = []
    try {
      const outcome = await host.run({
        prompt: "Read the current status",
        seat: `replay:${file}`,
        history: [],
        role: "worker",
        onEvent: (event) => {
          if (event._tag === "model-requested" && ++requests === 2) {
            writeFileSync(join(cwd, "check-status.txt"), "changed by another worker")
          }
          if (event._tag === "mutation-observed") mutations.push(event.mutated)
        }
      }).done
      expect(outcome._tag).toBe("done")
      expect(outcome._tag === "done" && outcome.answer).toContain("changed by another worker")
      expect(requests).toBeGreaterThanOrEqual(2)
      expect(mutations.length).toBeGreaterThanOrEqual(2)
      expect(mutations).not.toContain(true)
    } finally {
      await host.dispose()
    }
  })
})
