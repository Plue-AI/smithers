import { NodeServices } from "@effect/platform-node"
import * as Memory from "@smthrs/agent/Memory"
import { brief } from "@smthrs/agent/SmithersPlugin"
import { Action, Interpreter } from "@smthrs/flow"
import * as Fault from "@smthrs/flow/Fault"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import Wrapped, { grants, layer, sessionPath, type Success, writePrompt } from "../wrapped/flow.ts"
import {
  adapters,
  launch,
  type LaunchInput,
  type LaunchOptions,
  parseClaude,
  run,
  withheld,
  WrappedFailed
} from "../wrapped/launch.ts"
import { extraPrompt, maxExtraBytes, type Permission, rules, sha256, wrappedBrief } from "../wrapped/prompt.ts"

const claude = adapters["claude-code"]
const memoryBlock = (text: string) => `<memory>\n${text}\n</memory>`

const failureOf = <A>(effect: Effect.Effect<A, WrappedFailed>) =>
  Effect.runPromise(Effect.flip(effect)).then((error) => {
    assert.ok(error instanceof WrappedFailed)
    return error
  })

test("extraPrompt is byte-identical for identical inputs and orders brief, rules, memory", () => {
  const memory = { context: memoryBlock("src/a.ts: exports a") }
  const one = extraPrompt({ permission: "acceptEdits", memory })
  assert.equal(one, extraPrompt({ permission: "acceptEdits", memory: { ...memory } }))
  assert.equal(one, `${wrappedBrief}\n\n${rules("acceptEdits")}\n\n${memory.context}\n`)
  assert.ok(!/AGENTS\.md|CLAUDE\.md/.test(rules("acceptEdits")))
})

test("a different memory block changes only the tail; the static prefix is byte-identical", () => {
  const first = extraPrompt({ permission: "acceptEdits", memory: { context: memoryBlock("task one") } })
  const second = extraPrompt({ permission: "acceptEdits", memory: { context: memoryBlock("a different task two") } })
  const prefix = `${wrappedBrief}\n\n${rules("acceptEdits")}\n\n`
  assert.notEqual(first, second)
  assert.ok(first.startsWith(prefix) && second.startsWith(prefix))
  assert.equal(first.slice(prefix.length), `${memoryBlock("task one")}\n`)
})

test("an empty memory block adds nothing, and each permission mode has its own constant rules", () => {
  assert.equal(extraPrompt({ permission: "plan", memory: { context: "" } }), `${wrappedBrief}\n\n${rules("plan")}\n`)
  assert.notEqual(rules("plan"), rules("acceptEdits"))
})

test("the wrapped prompt drops the brief's ctx.call instruction and keeps the rest byte for byte", () => {
  assert.ok(brief.includes("ctx.call("), "the shared brief names ctx.call, which a wrapped harness cannot follow")
  const lines = brief.split("\n")
  const kept = wrappedBrief.split("\n")
  assert.deepEqual(kept, lines.filter((line) => !line.includes("ctx.call(")))
  assert.ok(kept.length > 0 && kept.length < lines.length)
  for (const permission of ["plan", "acceptEdits"] as const) {
    const text = extraPrompt({ permission, memory: { context: "" } })
    assert.ok(!text.includes("ctx.call"), permission)
    assert.ok(!/jj commit|commit with jj/.test(text), `${permission} runs no shell, so it never asks for a commit`)
  }
})

test("the Claude Code argv starts a chosen session under a permission mode and appends exactly the extra bytes", () => {
  const extra = "line one\nline \"two\" $(not a shell)\n"
  const fresh = claude.command(extra, { session: "s-1", resume: false, permission: "acceptEdits" })
  assert.equal(fresh.executable, "claude")
  assert.deepEqual(fresh.args, [
    "-p",
    "--session-id",
    "s-1",
    "--permission-mode",
    "acceptEdits",
    "--tools",
    "Read,Edit,Write,Glob,Grep",
    "--strict-mcp-config",
    "--mcp-config",
    "{\"mcpServers\":{}}",
    "--output-format",
    "json",
    "--append-system-prompt",
    extra
  ])
  const resume = claude.command(extra, { session: "s-1", resume: true, permission: "plan" })
  assert.deepEqual(resume.args, [
    "-p",
    "--resume",
    "s-1",
    "--permission-mode",
    "plan",
    "--tools",
    "Read,Glob,Grep",
    "--strict-mcp-config",
    "--mcp-config",
    "{\"mcpServers\":{}}",
    "--output-format",
    "json",
    "--append-system-prompt",
    extra
  ])
})

test("the envelope yields result and session_id; anything else is a typed failure", async () => {
  assert.deepEqual(
    await Effect.runPromise(parseClaude(JSON.stringify({ type: "result", result: "hi", session_id: "s1" }), "s1")),
    { answer: "hi", session: "s1" }
  )
  const code = async (stdout: string) => (await failureOf(parseClaude(stdout, "s"))).code
  assert.equal(await code("not json"), "bad_envelope")
  assert.equal(await code("[]"), "bad_envelope")
  assert.equal(await code("null"), "bad_envelope")
  assert.equal(await code(JSON.stringify({ result: "hi" })), "bad_envelope")
  assert.equal(await code(JSON.stringify({ result: 1, session_id: "s" })), "bad_envelope")
  assert.equal(await code(JSON.stringify({ result: "hi", session_id: "other" })), "bad_envelope")
  const refused = await failureOf(
    parseClaude(JSON.stringify({ is_error: true, result: "quota", session_id: "s" }), "s")
  )
  assert.deepEqual([refused.code, refused.message], ["harness_error", "quota"])
})

/**
 * A fake `claude` first on PATH that records argv (NUL-separated), stdin and
 * its pid per call, and answers for the session it was given. `tree` and
 * `flood` start a `sleep 30` grandchild and record its pid.
 */
const fakeClaude = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wrapped-fake-")))
  const log = join(dir, "log")
  mkdirSync(log)
  const bin = join(dir, "bin")
  mkdirSync(bin)
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
n=$(ls "$WRAPPED_LOG" | grep -c '^argv')
printf '%s\\0' "$@" > "$WRAPPED_LOG/argv.$n"
echo $$ > "$WRAPPED_LOG/pid.$n"
env > "$WRAPPED_LOG/env.$n"
sid=""
while [ $# -gt 0 ]; do
  case "$1" in --session-id|--resume) sid="$2" ;; esac
  shift
done
cat > "$WRAPPED_LOG/stdin.$n"
case "$FAKE_MODE" in
  fail) echo boom >&2; exit 3 ;;
  garbage) echo nope; exit 0 ;;
  tree) sleep 30 & echo $! > "$WRAPPED_LOG/grandchild"; wait ;;
  orphan) sleep 30 & echo $! > "$WRAPPED_LOG/grandchild" ;;
  flood) sleep 30 & echo $! > "$WRAPPED_LOG/grandchild"; head -c 4096 /dev/zero; wait ;;
esac
printf '{"type":"result","is_error":false,"result":"answer %s","session_id":"%s"}' "$n" "$sid"
`
  )
  chmodSync(join(bin, "claude"), 0o755)
  const env = (mode = "") => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, WRAPPED_LOG: log, FAKE_MODE: mode })
  const call = (n: number) => ({
    argv: readFileSync(join(log, `argv.${n}`), "utf8").split("\0").slice(0, -1),
    stdin: readFileSync(join(log, `stdin.${n}`), "utf8")
  })
  const calls = () => readdirSync(log).filter((name) => name.startsWith("argv")).length
  const pid = (name: string) => Number(readFileSync(join(log, name), "utf8").trim())
  return { dir, log, env, call, calls, pid }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** Waits until `pid` is gone (killed and reaped), failing after 3 s. */
const dies = async (pid: number, what: string) => {
  const deadline = Date.now() + 3000
  while (alive(pid)) {
    assert.ok(Date.now() < deadline, `${what} (pid ${pid}) outlived the launch`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const until = async (path: string, ms = 3000) => {
  const deadline = Date.now() + ms
  while (!existsSync(path) || readFileSync(path, "utf8").trim() === "") {
    assert.ok(Date.now() < deadline, `${path} never appeared`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const noMemory: Memory.Output = {
  context: memoryBlock("remembered"),
  digest: "d",
  kept: [],
  omitted: [],
  cost: { jevRequests: 0, jevMs: 0, candidates: 0 }
}

const prepare = async (cwd: string): Promise<LaunchInput> => {
  const prepared = await Effect.runPromise(writePrompt({ cwd, permission: "acceptEdits", memory: noMemory }))
  return { harness: "claude-code", task: "t", cwd, resume: false, ...prepared }
}

test("the real spawn path passes the file's bytes, the task on stdin, and resumes with identical bytes", async () => {
  const fake = fakeClaude()
  const input = { ...(await prepare(fake.dir)), task: "Explain a.ts" }
  const bytes = readFileSync(input.extra.path, "utf8")
  assert.equal(sha256(bytes), input.extra.digest)
  const observed: Array<ReadonlyArray<string>> = []
  const outputs: Array<string> = []
  const options: LaunchOptions = {
    env: fake.env(),
    observe: (command) => observed.push(command.args),
    observeOutput: (stdout) => outputs.push(stdout)
  }
  const first = await Effect.runPromise(launch(input, options))
  assert.deepEqual(first, { answer: "answer 0", session: input.session })
  const second = await Effect.runPromise(launch({ ...input, task: "One more.", resume: true }, options))
  assert.equal(second.answer, "answer 1")
  const [a, b] = [fake.call(0), fake.call(1)]
  const tail = [
    "--permission-mode",
    "acceptEdits",
    "--tools",
    "Read,Edit,Write,Glob,Grep",
    "--strict-mcp-config",
    "--mcp-config",
    "{\"mcpServers\":{}}",
    "--output-format",
    "json",
    "--append-system-prompt",
    bytes
  ]
  assert.deepEqual(a.argv, ["-p", "--session-id", input.session, ...tail])
  assert.deepEqual(b.argv, ["-p", "--resume", input.session, ...tail])
  assert.deepEqual([a.stdin, b.stdin], ["Explain a.ts", "One more."])
  assert.deepEqual(observed, [a.argv, b.argv])
  assert.deepEqual(outputs.map((stdout) => JSON.parse(stdout).result), ["answer 0", "answer 1"])
})

test("spawn failures are typed and never produce an answer", async () => {
  const fake = fakeClaude()
  const input = await prepare(fake.dir)
  const exit = await failureOf(launch(input, { env: fake.env("fail") }))
  assert.equal(exit.code, "exit_nonzero")
  assert.match(exit.message, /exited 3: boom/)
  assert.equal((await failureOf(launch(input, { env: fake.env("garbage") }))).code, "bad_envelope")
  const missing = { ...process.env, PATH: "/nonexistent" }
  assert.equal((await failureOf(launch(input, { env: missing }))).code, "spawn_failed")
  const calls = fake.calls()
  const gone = { ...input, extra: { ...input.extra, path: join(fake.dir, "absent.md") } }
  assert.equal((await failureOf(launch(gone, { env: fake.env() }))).code, "prompt_failed")
  writeFileSync(input.extra.path, "tampered")
  assert.equal((await failureOf(launch(input, { env: fake.env() }))).code, "extra_changed")
  assert.equal(fake.calls(), calls, "a missing or moved prompt never spawns")
})

test("a timeout and oversized output kill the harness and the processes it started", async () => {
  for (
    const [mode, options, code] of [
      ["tree", { timeoutMs: 1000 }, "timeout"],
      ["flood", { maxBytes: 1024 }, "output_too_large"]
    ] as const
  ) {
    const fake = fakeClaude()
    const input = await prepare(fake.dir)
    assert.equal((await failureOf(launch(input, { ...options, env: fake.env(mode) }))).code, code)
    await until(join(fake.log, "grandchild"))
    await dies(fake.pid("pid.0"), `${mode}: the harness`)
    await dies(fake.pid("grandchild"), `${mode}: the harness's child`)
  }
})

test("interrupting a running launch kills the harness and the processes it started", async () => {
  const fake = fakeClaude()
  const input = await prepare(fake.dir)
  const fiber = Effect.runFork(launch(input, { env: fake.env("tree"), timeoutMs: 60_000 }))
  await until(join(fake.log, "grandchild"))
  const [harness, grandchild] = [fake.pid("pid.0"), fake.pid("grandchild")]
  assert.ok(alive(harness) && alive(grandchild))
  await Effect.runPromise(Fiber.interrupt(fiber))
  await dies(harness, "the harness")
  await dies(grandchild, "the harness's child")
})

/** Keeps every candidate Jev is asked about. */
const keepAll = Evaluator.layerScripted((request) =>
  Object.fromEntries(Object.keys(request.questions).map((id) => [id, { probability: 0.95 }]))
)

const flowHarness = () => {
  const fake = fakeClaude()
  const repo = join(fake.dir, "repo")
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  put("README.md", "# Demo\n\nsrc/ holds the greeting.\n")
  put("src/README.md", "# src\n\ngreeting.ts exports greet.\n")
  put("src/greeting.ts", "export const greet = (name: string) => `hello ${name}`\n")
  return flowHarnessAt(fake, repo)
}

/** Runs the flow through the runtime with `repo` as the workspace and `fake` as `claude`. */
const flowHarnessAt = (fake: ReturnType<typeof fakeClaude>, repo: string) => {
  const memories: Array<Memory.Output> = []
  const run = (
    payload: typeof Wrapped.payloadSchema.Type,
    id: string,
    options: { readonly evaluator?: Layer.Layer<Evaluator.Evaluator>; readonly granted?: boolean } = {}
  ) => {
    const layers = Layer.mergeAll(
      layer({ env: fake.env(), onMemory: (output) => memories.push(output) }).pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, options.evaluator ?? keepAll))
      ),
      Interpreter.layer(Wrapped)
    ).pipe(Layer.provideMerge(Action.layerImplementations))
    const host = NodeRuntime.layerHost(
      {
        filename: join(fake.dir, `${id}.db`),
        workspaceRoot: repo,
        owner: { hostId: id },
        signals: [],
        rules: options.granted === false ? [] : [grants(repo)]
      },
      layers
    )
    return Effect.runPromiseExit(
      Effect.scoped(Wrapped.execute(payload, { executionId: id }).pipe(Effect.provide(host)))
    )
  }
  const succeeded = async (...args: Parameters<typeof run>) => {
    const exit = await run(...args)
    assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")
    return exit.value as Success
  }
  const failed = async (...args: Parameters<typeof run>) => {
    const exit = await run(...args)
    assert.ok(Exit.isFailure(exit))
    return Cause.squash(exit.cause)
  }
  const wrappedCode = async (...args: Parameters<typeof run>) => {
    const error = await failed(...args)
    assert.ok(error instanceof WrappedFailed, String(error))
    return error.code
  }
  return { fake, repo, memories, succeeded, failed, wrappedCode }
}

test("the flow runs memory, records the session, launches through the runtime, then resumes", async () => {
  const { fake, memories, repo, succeeded } = flowHarness()
  const task = "What does src/greeting.ts export?"
  const first = await succeeded({ harness: "claude-code", task, cwd: repo }, "wrapped-1")
  const bytes = readFileSync(first.extra.path, "utf8")
  assert.equal(first.extra.digest, sha256(bytes))
  assert.deepEqual([first.answer, first.permission], ["answer 0", "acceptEdits"])
  const memory = memories[0]!
  assert.ok(memory.context.includes("greeting.ts"))
  assert.ok(bytes.endsWith(`\n\n${memory.context}\n`))
  assert.deepEqual(first.memory, { digest: memory.digest, kept: memory.kept.length, cost: memory.cost })
  assert.ok(first.memory.kept > 0)
  assert.equal(fake.call(0).stdin, task)
  assert.deepEqual(fake.call(0).argv.slice(0, 5), [
    "-p",
    "--session-id",
    first.session,
    "--permission-mode",
    "acceptEdits"
  ])
  assert.equal(fake.call(0).argv.at(-1), bytes)
  const record = readFileSync(sessionPath(repo, first.session)!, "utf8")
  assert.deepEqual(JSON.parse(record), {
    digest: first.extra.digest,
    memory: first.memory,
    permission: "acceptEdits",
    task
  })
  assert.equal(record, `${JSON.stringify(JSON.parse(record), null, 2)}\n`)

  // A different follow-up replays the launch's bytes and never selects again.
  const resumed = await succeeded(
    { harness: "claude-code", task: "Name one more export.", cwd: repo, session: first.session },
    "wrapped-2"
  )
  assert.equal(memories.length, 1, "a resume runs no new memory selection")
  assert.equal(resumed.answer, "answer 1")
  assert.deepEqual({ ...resumed, answer: "" }, { ...first, answer: "" })
  assert.deepEqual(fake.call(1).argv, ["-p", "--resume", first.session, ...fake.call(0).argv.slice(3)])
  assert.equal(fake.call(1).stdin, "Name one more export.")
  assert.equal(readFileSync(sessionPath(repo, first.session)!, "utf8"), record, "a resume never rewrites the record")
})

test("a second launch of the same task with other memory never breaks resuming the first", async () => {
  const { fake, repo, succeeded } = flowHarness()
  const task = "What does src/greeting.ts export?"
  const first = await succeeded({ harness: "claude-code", task, cwd: repo }, "wrapped-a")
  const firstBytes = readFileSync(first.extra.path, "utf8")
  // Jev is down now: memory keeps only the seeds, so the block differs and says why.
  const second = await succeeded(
    { harness: "claude-code", task, cwd: repo },
    "wrapped-b",
    { evaluator: Evaluator.layerUnavailable() }
  )
  assert.notEqual(second.session, first.session)
  assert.notEqual(second.extra.digest, first.extra.digest)
  assert.notEqual(second.extra.path, first.extra.path)
  assert.equal(second.memory.unjudged?.reason, "unreachable")
  assert.equal(first.memory.unjudged, undefined)
  assert.deepEqual(JSON.parse(readFileSync(sessionPath(repo, second.session)!, "utf8")).memory, second.memory)

  const resumed = await succeeded(
    { harness: "claude-code", task: "And the first?", cwd: repo, session: first.session },
    "wrapped-c"
  )
  assert.deepEqual([resumed.extra, resumed.memory], [first.extra, first.memory])
  assert.equal(fake.call(2).argv.at(-1), firstBytes)
})

test("a resume refuses unknown, malformed, moved or re-permissioned sessions without spawning", async () => {
  const { fake, repo, succeeded, wrappedCode } = flowHarness()
  const first = await succeeded({ harness: "claude-code", task: "Read src/greeting.ts", cwd: repo }, "wrapped-1")
  const calls = fake.calls()
  const resume = (session: string, id: string, permission?: Permission) =>
    wrappedCode(
      { harness: "claude-code", task: "again", cwd: repo, session, ...(permission ? { permission } : {}) },
      id
    )
  assert.equal(await resume("never-launched", "wrapped-2"), "session_unknown")
  assert.equal(await resume("../escape", "wrapped-3"), "session_unknown")
  writeFileSync(sessionPath(repo, "bad")!, "{\"digest\":1}\n")
  assert.equal(await resume("bad", "wrapped-4"), "session_malformed")
  writeFileSync(sessionPath(repo, "not-json")!, "{")
  assert.equal(await resume("not-json", "wrapped-5"), "session_malformed")
  // A record names its prompt by digest only; a path in the digest is refused, never read.
  const record = JSON.parse(readFileSync(sessionPath(repo, first.session)!, "utf8"))
  writeFileSync(sessionPath(repo, "escape")!, JSON.stringify({ ...record, digest: "../../../etc/passwd" }))
  assert.equal(await resume("escape", "wrapped-5b"), "session_malformed")
  assert.equal(await resume(first.session, "wrapped-6", "plan"), "permission_changed")
  writeFileSync(first.extra.path, "tampered")
  assert.equal(await resume(first.session, "wrapped-7"), "extra_changed")
  assert.equal(fake.calls(), calls, "a refused resume never spawns")
})

test("a launch whose session cannot be recorded never spawns", async () => {
  const { fake, repo, wrappedCode } = flowHarness()
  mkdirSync(join(repo, ".flows", "wrapped"), { recursive: true })
  writeFileSync(join(repo, ".flows", "wrapped", "sessions"), "a file where the directory goes")
  assert.equal(
    await wrappedCode({ harness: "claude-code", task: "Read src/greeting.ts", cwd: repo }, "wrapped-1"),
    "session_record_failed"
  )
  assert.equal(fake.calls(), 0)
})

test("a plan launch passes plan and records it; its resume keeps it", async () => {
  const { fake, repo, succeeded } = flowHarness()
  const first = await succeeded(
    { harness: "claude-code", task: "Read src/greeting.ts", cwd: repo, permission: "plan" },
    "wrapped-1"
  )
  assert.equal(first.permission, "plan")
  assert.ok(readFileSync(first.extra.path, "utf8").includes(rules("plan")))
  await succeeded({ harness: "claude-code", task: "more", cwd: repo, session: first.session }, "wrapped-2")
  for (const n of [0, 1]) {
    assert.deepEqual(fake.call(n).argv.slice(3, 7), ["--permission-mode", "plan", "--tools", "Read,Glob,Grep"])
  }
})

test("without the host grants memory cannot read the repository and nothing is written or launched", async () => {
  const { failed, fake, repo } = flowHarness()
  const error = await failed({ harness: "claude-code", task: "Read src/greeting.ts", cwd: repo }, "wrapped-1", {
    granted: false
  })
  assert.ok(error instanceof Memory.MemoryFailed, String(error))
  assert.equal(error.code, "read_failed")
  assert.equal(existsSync(join(repo, ".flows", "wrapped")), false)
  assert.equal(fake.calls(), 0)
})

test("a prompt no argv can carry fails prompt_unsendable before anything is written", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "wrapped-argv-")))
  const refused = async (context: string) =>
    (await failureOf(writePrompt({ cwd, permission: "acceptEdits", memory: { ...noMemory, context } }))).code
  assert.equal(await refused(memoryBlock("a decision page with a \0 byte")), "prompt_unsendable")
  const fixed = Buffer.byteLength(extraPrompt({ permission: "acceptEdits", memory: { context: "" } })) + 2
  assert.equal(await refused("x".repeat(maxExtraBytes - fixed + 1)), "prompt_unsendable")
  assert.equal(existsSync(join(cwd, ".flows")), false)
  // The largest prompt that fits is written.
  const fits = await Effect.runPromise(
    writePrompt({ cwd, permission: "acceptEdits", memory: { ...noMemory, context: "x".repeat(maxExtraBytes - fixed) } })
  )
  assert.equal(fits.extra.bytes, maxExtraBytes)
})

test("an argv the OS refuses is a typed spawn_failed, never a defect", async () => {
  const fake = fakeClaude()
  const options = { cwd: fake.dir, stdin: "", timeoutMs: 5000, maxBytes: 1024, env: fake.env() }
  const nul = await failureOf(run({ executable: "claude", args: ["a\0b"] }, options))
  assert.equal(nul.code, "spawn_failed")
  assert.equal(fake.calls(), 0)
})

test("the harness inherits the environment minus the withheld names", async () => {
  const fake = fakeClaude()
  const input = await prepare(fake.dir)
  const env = { ...fake.env(), ...Object.fromEntries(withheld.map((name) => [name, "secret"])), WRAPPED_KEEP: "kept" }
  await Effect.runPromise(launch(input, { env }))
  const seen = readFileSync(join(fake.log, "env.0"), "utf8").split("\n")
  assert.ok(seen.includes("WRAPPED_KEEP=kept"))
  for (
    const name of ["AI_GATEWAY_API_KEY", "NODE_OPTIONS", "NODE_PATH", "SMITHERS_CACHE_URL", "SMITHERS_CACHE_TOKEN"]
  ) {
    assert.ok(!seen.some((line) => line.startsWith(`${name}=`)), name)
  }
})

test("a host stopped by SIGINT, SIGTERM or SIGHUP kills the harness and the processes it started", async () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const { fake, repo } = flowHarness()
    const home = join(fake.dir, "home")
    mkdirSync(home)
    const host = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        join(import.meta.dirname, "..", "wrapped", "main.ts"),
        "--cwd",
        repo,
        "--task",
        "Read src/greeting.ts"
      ],
      { env: { ...fake.env("tree"), HOME: home, AI_GATEWAY_API_KEY: "" }, stdio: "ignore" }
    )
    const exited = new Promise<void>((resolve) => host.once("exit", () => resolve()))
    await until(join(fake.log, "grandchild"), 60_000)
    const [harness, grandchild] = [fake.pid("pid.0"), fake.pid("grandchild")]
    assert.ok(alive(harness) && alive(grandchild))
    host.kill(signal)
    await exited
    await dies(harness, `${signal}: the harness`)
    await dies(grandchild, `${signal}: the harness's child`)
  }
})

test("a harness that exits while a process it started holds stdout returns its answer at once", async () => {
  const fake = fakeClaude()
  const input = await prepare(fake.dir)
  const started = Date.now()
  const launched = await Effect.runPromise(launch(input, { env: fake.env("orphan"), timeoutMs: 20_000 }))
  assert.deepEqual(launched, { answer: "answer 0", session: input.session })
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`)
  await dies(fake.pid("grandchild"), "the stdout holder")
})

test("a resume from a moved checkout reads the prompt at the new location", async () => {
  const { fake, repo, succeeded } = flowHarness()
  const first = await succeeded({ harness: "claude-code", task: "Read src/greeting.ts", cwd: repo }, "wrapped-1")
  const bytes = readFileSync(first.extra.path, "utf8")
  const moved = join(fake.dir, "moved")
  renameSync(repo, moved)
  const flow = flowHarnessAt(fake, moved)
  const resumed = await flow.succeeded(
    { harness: "claude-code", task: "more", cwd: moved, session: first.session },
    "wrapped-2"
  )
  assert.equal(resumed.extra.path, join(moved, ".flows", "wrapped", "extra", `${first.extra.digest}.md`))
  assert.equal(fake.call(1).argv.at(-1), bytes)
})

test("WrappedFailed has a fault class for every code", () => {
  const codes = WrappedFailed.fields.code.literals
  for (const code of codes) {
    // An unregistered error reads as `{ class: "bug", tag: "unregistered" }`.
    assert.equal(Fault.of(new WrappedFailed({ code, message: "m" })).tag, `wrapped/WrappedFailed/${code}`)
  }
})
