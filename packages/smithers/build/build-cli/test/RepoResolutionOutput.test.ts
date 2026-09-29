/**
 * Child repository output reaches the parent's reporter redacted a complete
 * line at a time with the diagnostic rules, and so does the failure's stderr tail.
 */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"

const children: Array<FakeChild> = []

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = undefined
  kill() {}
}

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: () => {
    const child = new FakeChild()
    children.push(child)
    return child
  }
}))

const RepoResolution = await import("../src/RepoResolution.ts")

const resolution = {
  repoName: "child",
  repoPath: "child",
  absolutePath: "/child",
  label: "//:test",
  args: [],
  kinds: ["test"],
  refusal: undefined,
  externalLabel: "@child//:test"
} as import("../src/RepoResolution.ts").Resolution
const resolver = { environment: {} } as unknown as import("../src/RepoResolution.ts").Resolver

describe("child repository output", () => {
  it("never submits an unfinished overlong line as complete", async () => {
    const secret = "ZqSynthetic7Secret4Value9"
    const seen: Array<string> = []
    const execution = RepoResolution.execute(resolver, resolution, { output: (_stream, text) => seen.push(text) })
    const child = children.at(-1)!
    child.stdout.emit("data", Buffer.from(`${"x".repeat(65_537)} pass`))
    child.stdout.emit("data", Buffer.from(`word=${secret}\n`))
    child.emit("close", 0)
    await execution
    expect(seen.join("")).not.toContain(secret)
    expect(seen.join("")).toContain("[overlong line omitted]")
  })

  it("redacts diagnostic spellings and values split across chunks before the reporter and the failure", async () => {
    const secret = "ZqSynthetic7Secret4Value9"
    const seen: Array<string> = []
    const resolution = {
      repoName: "child",
      repoPath: "child",
      absolutePath: "/child",
      label: "//:test",
      args: [],
      kinds: ["test"],
      refusal: undefined,
      externalLabel: "@child//:test"
    } as import("../src/RepoResolution.ts").Resolution
    const resolver = { environment: {} } as unknown as import("../src/RepoResolution.ts").Resolver
    const execution = RepoResolution.execute(resolver, resolution, {
      output: (stream, text) => seen.push(`${stream}:${text}`)
    })
    const child = children.at(-1)!
    const text = `sshpass -p ${secret.slice(0, 9)}`
    child.stderr.emit("data", Buffer.from(text))
    child.stderr.emit("data", Buffer.from(`${secret.slice(9)} ssh host\npassword: "\n${secret}\n"\n`))
    child.stdout.emit("data", Buffer.from(`Authorization: Token ${secret}\n`))
    child.emit("close", 1)
    const failure = (await execution.then(() => undefined, (cause: unknown) => cause)) as Error
    expect(seen.join("")).not.toContain(secret)
    expect(seen.join("")).not.toContain(secret.slice(9))
    expect(seen).toContain("stdout:Authorization: [REDACTED]\n")
    expect(failure).toBeInstanceOf(RepoResolution.ExecutionError)
    expect(failure.message).toContain("sshpass -p [REDACTED] ssh host")
    expect(failure.message).not.toContain(secret)
  })
})
