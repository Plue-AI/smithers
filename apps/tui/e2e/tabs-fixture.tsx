/** Deterministic host with workers in every status, for the subagent cards, tab strip, worker view and sidebar. */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"

const workers: Record<string, { title: string; prompt: string; model?: "sol" | "luna" | "astra" }> = {
  audit: { title: "Audit auth middleware", prompt: "Audit the auth middleware.", model: "sol" },
  flaky: { title: "Fix flaky seat queue test", prompt: "Fix the flaky seat queue test.", model: "luna" },
  strip: { title: "Refactor tab strip overflow", prompt: "Refactor the tab strip overflow." },
  frame: { title: "Profile frame budget", prompt: "Profile the frame budget.", model: "astra" },
  docs: { title: "Document which-key", prompt: "Document which-key." },
  lint: { title: "Lint the key registry", prompt: "Lint the key registry." },
  api: { title: "implement/api", prompt: "Implement the OAuth session." },
  capped: { title: "flaky seat queue", prompt: "Loop on the seat queue." }
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
const host: Host.Host = {
  cwd: process.cwd(),
  runCap: 200,
  judged: false,
  compaction: async () => undefined,
  dispose: async () => {},
  run: (input) => {
    if (input.role === "worker") {
      const id = input.source ?? ""
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
            question: "Session cookie or bearer header?",
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
    if (input.prompt === "delegate") {
      delegate(input, "I'll split this into three workers.", ["audit", "flaky", "strip"])
      answer = "Requested three workers."
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
