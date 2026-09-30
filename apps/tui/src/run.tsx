import * as Failures from "./failures.ts"
import * as Log from "./log.ts"
/**
 * smithers-tui [directory] [--model provider:id] [-c | -r] [-p "prompt"] [--approve ask|all|deny] [--budget-tokens n]
 *
 *   --approve        ask: y/n per consequential call; deny: refuse them; all (default): run them
 *   --budget-tokens  stop a turn or worker at this many tokens (default 200M; 0 or none disables)
 *   --budget-daily-tokens  stop new model calls at this many tokens per UTC day (default 2B)
 *   -c, --continue   continue the latest session in this directory
 *   -r, --resume     pick a session to continue
 *   -p, --print      run one prompt and print the answer
 *   --box            run worker tools in a Smithers Cloud workspace, owner/repo/id (or SMITHERS_BOX)
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as FailureCopy from "@smthrs/model/FailureCopy"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import * as Approvals from "./approvals.ts"
import * as Box from "./box.ts"
import * as Budget from "./budget.ts"
import * as Cli from "./cli.ts"
import type * as Context from "./context.ts"
import * as FlowControl from "./flow-control.ts"
import * as Host from "./host.ts"
import * as Models from "./models.ts"
import * as Session from "./session.ts"
import * as Spend from "./spend.ts"

const parsed = Cli.parse(process.argv.slice(2), process.cwd())
if ("help" in parsed) {
  console.log(Cli.usage)
  process.exit(0)
}
if ("error" in parsed) {
  console.error(`${parsed.error}\nRun smithers-tui --help for usage.`)
  process.exit(1)
}
const { values, cwd } = parsed
const box = values.box ?? (process.env.SMITHERS_BOX || undefined)
if (box !== undefined && !Cli.validBox(box)) {
  console.error("SMITHERS_BOX needs owner/repo/workspace-id")
  process.exit(1)
}
const approvals = Approvals.mode(process.env, { print: values.print !== undefined, flag: values.approve })
if (typeof approvals === "object") {
  console.error(approvals.error)
  process.exit(1)
}
const budget = Budget.policy(process.env, { tokens: values["budget-tokens"], daily: values["budget-daily-tokens"] })
if (budget !== undefined && "error" in budget) {
  console.error(budget.error)
  process.exit(1)
}
if (values.print === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)) {
  console.error("Interactive mode requires a terminal. Use --print <prompt>.")
  process.exit(1)
}
// Resolved before the chdir below, so a relative recording names the caller's file.
const replay = process.env.SMITHERS_TUI_REPLAY === undefined ? undefined : resolve(process.env.SMITHERS_TUI_REPLAY)
try {
  process.chdir(cwd)
} catch {
  console.error(`Cannot open directory: ${cwd}`)
  process.exit(1)
}

const available = await Models.detect(process.env)
const seat = values.model ?? (replay === undefined ? available.defaultSeat : `replay:${replay}`)
if (seat === undefined) {
  console.error("No model is available. Run `codex login` for the ChatGPT subscription, or set a provider API key.")
  process.exit(1)
}
// A replay is an offline fixture that spends no tokens, so it stays out of the machine's daily ledger.
const spending = budget === undefined
  ? {}
  : seat.startsWith("replay:")
  ? { budget: { ...(budget.tokens === undefined ? {} : { tokens: budget.tokens }) } }
  : { budget, ledger: Spend.ledger() }
const host = Host.make({
  cwd,
  environment: available.environment,
  available,
  approvals,
  // Replay is an explicit offline fixture; its claims still receive evidence checks.
  ...(seat.startsWith("replay:") ? { judge: ScriptedJudge.layerAll } : {}),
  ...(box === undefined ? {} : { box: Box.workspace(process.env, box) }),
  ...spending
})

if (values.print !== undefined) {
  const notice = Approvals.notices()
  const turn = host.run({
    prompt: values.print,
    seat,
    history: [] as Array<Context.Entry>,
    onEvent: (event) => {
      if (event._tag !== "cell-call-settled" || !Approvals.denied(event.result)) return
      const line = notice(event.flowName)
      if (line !== undefined) console.error(line)
    }
  })
  const outcome = await turn.done
  await host.dispose()
  if (outcome._tag === "done") {
    console.log(outcome.answer)
    process.exit(0)
  }
  if (outcome._tag === "failed") {
    const failure = FailureCopy.describe(outcome.error, seat)
    console.error(`${failure.headline}\n${failure.line}`)
  } else {
    console.error("Stopped")
  }
  process.exit(1)
}

// Help and print mode never initialize the terminal's native library.
let flows: ReturnType<typeof FlowControl.make> | undefined
try {
  await import("./native.ts")
  const [{ createCliRenderer }, { createRoot }, { App }, { createElement }, { applyColorMode, colorModeOf }] =
    await Promise.all([
      import("@opentui/core"),
      import("@opentui/react"),
      import("./app.tsx"),
      import("react"),
      import("./theme.ts")
    ])
  // App warms the host after first draw; discovery alone never imports a flow module.
  flows = FlowControl.make({ cwd, environment: available.environment, approvals: host.approvals! })
  const resumeFile = values.continue === true ? Session.latest(cwd) : undefined
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).stdout?.trim()
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
  applyColorMode(renderer, colorModeOf(process.env))
  Log.install()
  createRoot(renderer).render(
    createElement(App, {
      host,
      seat,
      workerSeat: replay === undefined ? available.workerSeat ?? seat : seat,
      models: available.models,
      ...(replay === undefined ? {} : { seatOf: () => seat }),
      contextWindow: (id) => SeatResolver.contextWindowTokensFor(Seat.modelIdOf(id)),
      ...(resumeFile === undefined ? {} : { resume: resumeFile }),
      pickSession: values.resume === true,
      flows,
      ...(branch === undefined || branch === "" ? {} : { branch })
    })
  )
} catch (error) {
  await flows?.dispose()
  await host.dispose()
  console.error(Failures.line("startup", error, `Details: ${Log.path()}`))
  process.exit(1)
}
