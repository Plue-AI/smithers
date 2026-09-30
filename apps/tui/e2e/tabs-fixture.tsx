/** Deterministic host with workers in every status and a real scratch-file fix. */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Effect } from "effect"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as pause } from "node:timers/promises"
import { App } from "../src/app.tsx"
import * as Changes from "../src/changes.ts"
import type * as Host from "../src/host.ts"

const workers: Record<string, { title: string; prompt: string; model?: "sol" | "luna" }> = {
  fix: { title: "Fix add in math.js", prompt: "Fix add in math.js so node check.mjs passes." },
  audit: { title: "Audit auth middleware", prompt: "Audit the auth middleware.", model: "sol" },
  flaky: { title: "Fix flaky seat queue test", prompt: "Fix the flaky seat queue test.", model: "luna" },
  strip: { title: "Refactor tab strip overflow", prompt: "Refactor the tab strip overflow." },
  frame: { title: "Profile frame budget", prompt: "Profile the frame budget.", model: "sol" },
  docs: { title: "Document which-key", prompt: "Document which-key." },
  lint: { title: "Lint the key registry", prompt: "Lint the key registry." },
  api: { title: "implement/api", prompt: "Implement the OAuth session." },
  capped: { title: "flaky seat queue", prompt: "Loop on the seat queue." },
  drive: { title: "implement/session", prompt: "Implement the session refresh." }
}
/** The chat's delegating cell: each worker is requested from an `agent.delegate` call, as a model's cell does. */
const delegate = (input: Host.TurnInput, prose: string, ids: ReadonlyArray<string>) => {
  input.onEvent(event({ _tag: "model-requested" }))
  input.onEvent(
    event({ _tag: "model-delta", delta: { type: "text-delta", text: `${prose}\n\`\`\`js\nawait delegate()\n\`\`\`` } })
  )
  input.onEvent(event({ _tag: "cell-produced", cell: { text: "await delegate()" } }))
  ids.forEach((id, ordinal) => {
    const identity = { session: "fixture", frame: 1, cell: 1, ordinal }
    const request = { id, ...workers[id]! }
    input.onEvent(event({ _tag: "cell-call-started", call: { flowName: "agent.delegate", input: request, identity } }))
    input.runtime!.delegate!(request)
    input.onEvent(event({
      _tag: "cell-call-settled",
      flowName: "agent.delegate",
      identity,
      result: { outcome: "success", value: { id, status: "requested" } }
    }))
  })
  input.onEvent(event({ _tag: "cell-settled", outcome: { _tag: "settled" } }))
}
const event = (value: unknown) => value as Parameters<Host.TurnInput["onEvent"]>[0]
const stream = (input: Host.TurnInput, prose: string, code: string, flow: string, subject: string, settle: boolean) => {
  input.onEvent(event({ _tag: "model-requested" }))
  input.onEvent(
    event({ _tag: "model-delta", delta: { type: "text-delta", text: `${prose}\n\`\`\`js\n${code}\n\`\`\`` } })
  )
  input.onEvent(event({
    _tag: "model-settled",
    usage: { inputTokens: 18_400, outputTokens: 2_150, cachedInputTokens: 16_900 },
    message: { role: "assistant", content: [{ type: "text", text: prose }] }
  }))
  input.onEvent(event({ _tag: "cell-produced", cell: { text: code } }))
  const identity = { session: "fixture", frame: 1, cell: 1, ordinal: 0 }
  input.onEvent(
    event({ _tag: "cell-call-started", call: { flowName: flow, input: { path: subject, command: subject }, identity } })
  )
  if (!settle) return
  input.onEvent(
    event({ _tag: "cell-call-settled", flowName: flow, identity, result: { outcome: "success", value: {} } })
  )
  input.onEvent(event({ _tag: "cell-settled", outcome: { _tag: "settled" } }))
}
const pending = new Map<string, (outcome: Host.Outcome) => void>()
const fixtureCwd = process.env.SMITHERS_TUI_FIXTURE_CWD
const host: Host.Host = {
  cwd: fixtureCwd ?? process.cwd(),
  runCap: 200,
  judged: false,
  dispose: async () => {},
  run: (input) => {
    if (input.role === "worker") {
      const id = input.source ?? ""
      if (id === "fix") {
        const controller = new AbortController()
        let command: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
        const done = (async (): Promise<Host.Outcome> => {
          if (fixtureCwd === undefined) return { _tag: "failed", message: "Scratch directory required", detail: "" }
          try {
            input.onEvent(event({ _tag: "model-requested" }))
            input.onEvent(event({ _tag: "cell-produced", cell: { text: "await fix()" } }))
            const identity = (ordinal: number) => ({
              session: "fixture-fix",
              frame: 1,
              cell: "fix",
              ordinal,
              declaration: "fixture",
              layers: []
            })
            const start = (ordinal: number, flowName: string, value: Record<string, string>) =>
              input.onEvent(event({
                _tag: "cell-call-started",
                call: { flowName, input: value, identity: identity(ordinal) }
              }))
            const settle = (ordinal: number, flowName: string, value: unknown) =>
              input.onEvent(event({
                _tag: "cell-call-settled",
                flowName,
                identity: identity(ordinal),
                result: { outcome: "success", value }
              }))
            start(0, "read", { path: "math.js" })
            await pause(1000, undefined, { signal: controller.signal })
            const before = await readFile(join(fixtureCwd, "math.js"), "utf8")
            settle(0, "read", { content: before })
            start(1, "edit", { path: "math.js", oldString: "a - b", newString: "a + b" })
            await pause(1000, undefined, { signal: controller.signal })
            const lines = before.split("\n")
            const at = lines.findIndex((line) => line.includes("a - b"))
            if (at < 0) throw new Error("Scratch math.js has no subtraction to fix")
            const after = before.replace("a - b", "a + b")
            await writeFile(join(fixtureCwd, "math.js"), after)
            input.onPatch?.({
              call: Changes.identity(identity(1)),
              patches: [{
                path: "math.js",
                patch: `--- a/math.js\n+++ b/math.js\n@@ -${at + 1} +${at + 1} @@\n-${lines[at]}\n+${
                  lines[at]!.replace("a - b", "a + b")
                }`
              }]
            })
            settle(1, "edit", {})
            start(2, "bash", { command: "node check.mjs" })
            await pause(1000, undefined, { signal: controller.signal })
            command = Bun.spawn(["node", "check.mjs"], {
              cwd: fixtureCwd,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe"
            })
            const [exitCode, stdout, stderr] = await Promise.all([
              command.exited,
              new Response(command.stdout).text(),
              new Response(command.stderr).text()
            ])
            settle(2, "bash", { exitCode, stdout, stderr })
            input.onEvent(event({ _tag: "cell-settled", outcome: { _tag: "settled" } }))
            if (exitCode !== 0) return { _tag: "failed", message: "Check failed", detail: "" }
            const answer = "add returned a - b; it now returns a + b."
            input.onEvent(
              event({
                _tag: "resolved",
                eventType: "flows.harness.resolved.v1",
                message: { role: "assistant", content: [{ type: "text", text: answer }] }
              })
            )
            return { _tag: "done", answer }
          } catch (error) {
            return controller.signal.aborted
              ? { _tag: "cancelled" }
              : { _tag: "failed", message: "Scratch fix failed", detail: "", error }
          }
        })()
        return {
          done,
          cancel: () => {
            controller.abort()
            command?.kill()
          }
        }
      }
      if (id === "flaky") {
        stream(
          input,
          "Rerun the seat queue test 50 times.",
          "await ctx.call(\"bash\", { command: \"bun test seat\" })",
          "bash",
          "bun test test/seat.test.ts",
          true
        )
        return {
          done: Promise.resolve({ _tag: "done", answer: "Fixed: the queue drained before the seat freed." }),
          cancel: () => {}
        }
      }
      // The drive worker runs four frames, each after a steering boundary, so a take-over parks it there.
      if (id === "drive") {
        const done = (async (): Promise<Host.Outcome> => {
          for (let frame = 1; frame <= 4; frame++) {
            await new Promise((resolve) => setTimeout(resolve, 2500))
            const drained = await Effect.runPromise(
              input.steering!.drain({ boundary: `frame-${frame}`, wouldIdle: frame === 4 })
            )
            const said = drained.inserts.flatMap((message) =>
              message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            )
            stream(
              input,
              `Frame ${frame}${said.length === 0 ? "" : `: ${said.join(" ")}`}`,
              "await ctx.call(\"read\", { path: \"src/session.ts\" })",
              "read",
              `src/session.ts#${frame}`,
              true
            )
          }
          return { _tag: "done", answer: "Refreshed the session before retry." }
        })()
        return { done, cancel: () => {} }
      }
      // The capped worker trips its token cap; raised from the form, it resumes under the new cap.
      if (id === "capped") {
        return {
          done: Promise.resolve(
            input.caps?.times === undefined
              ? {
                _tag: "failed",
                message: "Token budget reached",
                detail: "",
                error: { _tag: "flows/agent/BudgetExceeded", scope: "tokens", used: 200, max: 200 }
              }
              : { _tag: "done", answer: `Resumed under ${input.caps.times * 200} tokens.` }
          ),
          cancel: () => {}
        }
      }
      // The api worker asks for help (`ctx.help`); a top-level worker's ask goes to the person.
      if (id === "api") {
        return {
          done: input.runtime!.ask!({
            question: process.env.SMITHERS_TUI_ASK_QUESTION ?? "Session cookie or bearer header?",
            options: ["Session cookie", "Bearer header"]
          }).then(({ answer }) => ({ _tag: "done", answer: `Using: ${answer}` })),
          cancel: () => {}
        }
      }
      // The audit worker delegates a child of its own, for the overview's tree.
      if (id === "audit") {
        input.runtime?.delegate?.({ id: "refresh", title: "Check the refresh path", prompt: "Check it." })
      }
      if (id === "strip") {
        return {
          done: Promise.resolve({ _tag: "failed", message: "Seat quota exhausted", detail: "" }),
          cancel: () => {}
        }
      }
      stream(
        input,
        "Read the middleware and its tests.",
        "const src = await ctx.call(\"read\", { path: \"src/auth.ts\" })",
        "read",
        "src/auth.ts",
        false
      )
      return {
        done: new Promise((resolve) => pending.set(id, resolve)),
        cancel: () => pending.get(id)?.({ _tag: "cancelled" })
      }
    }
    let answer = "Still here."
    if (input.prompt === "fix" || input.prompt === workers.fix!.prompt) {
      delegate(input, "", ["fix"])
      answer = ""
    }
    if (input.prompt === "delegate") {
      delegate(input, "I'll split this into three workers.", ["audit", "flaky", "strip"])
      answer = "Requested three workers."
    }
    if (input.prompt === "drive") {
      delegate(input, "One worker.", ["drive"])
      answer = "Requested one worker."
    }
    if (input.prompt === "cap") {
      delegate(input, "One worker.", ["capped"])
      answer = "Requested one worker."
    }
    if (input.prompt === "help") {
      delegate(input, "One worker.", ["api"])
      answer = "Requested one worker."
    }
    if (input.prompt === "more") {
      delegate(input, "Three more.", ["frame", "docs", "lint"])
      answer = "Requested three more."
    }
    queueMicrotask(() =>
      input.onEvent(event({
        _tag: "resolved",
        eventType: "flows.harness.resolved.v1",
        message: { role: "assistant", content: [{ type: "text", text: answer }] }
      }))
    )
    return { done: Promise.resolve({ _tag: "done", answer }), cancel: () => {} }
  }
}
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
createRoot(renderer).render(
  <App
    host={host}
    seat="test:chat"
    workerSeat="openai:gpt-6-luna"
    models={[{ seat: "openai:gpt-6-sol", label: "GPT-6 Sol", provider: "openai" }]}
    contextWindow={() => 128_000}
  />
)
