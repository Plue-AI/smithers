/** The pacing decision: an Opus agent chooses launches inside computed ceilings. */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Schema } from "effect"
import { type Observation, Observation as ObservationSchema, PacePlan } from "./schema.ts"

/**
 * The Claude account the pacer itself runs on: the one with the most slots.
 * The seat names it after `@`, and the host's resolver pins that login.
 */
export const pacerSeat = ({ observation }: { readonly observation: Observation }): string => {
  const usable = observation.capacity
    .filter((c) => c.problem === null && !c.hardStop)
    .toSorted((a, b) => b.slots - a.slots || a.account.localeCompare(b.account))
  const claude = usable.find((c) => c.tool === "claude")
  if (claude !== undefined) return `claude-code:opus@${claude.account}`
  // Never a pay-per-use key: without a Claude login the pacer runs on a Codex subscription login.
  const codex = usable.find((c) => c.tool === "codex")
  return codex === undefined ? "claude-code:opus" : `sol@${codex.account}`
}

const table = (observation: Observation): string =>
  observation.capacity.map((c) =>
    `${c.account} ${c.tool}${c.hardStop ? " STOP" : ""} slots=${c.slots} inFlight=${c.inFlight} ` +
    c.windows.map((w) =>
      `${w.name}=${w.used}%${w.resetsAt === null ? "" : `@${new Date(w.resetsAt).toISOString().slice(5, 16)}`}`
    ).join(" ") +
    (c.problem === null ? "" : ` problem=${c.problem}`)
  ).join("\n")

export const Pace = AgentAction.make("burndown/pace", {
  payload: { observation: ObservationSchema },
  output: PacePlan,
  seat: pacerSeat,
  system: [
    "You pace a fleet of coding agents across subscription accounts to burn down every open issue as fast as the accounts allow.",
    "Concurrency target: launch until in-flight agents reach the target. The target started at 64 and doubles every round until you judge the fleet is at its maximum useful concurrency.",
    "Set nextTarget to double the current target unless you see saturation: workers ending limited (rate limited), accounts approaching 97% in a window that does not reset soon, many failures, or too few candidates. At saturation hold or lower the target and say why in the note.",
    "Spread launches across every usable account in proportion to headroom (100 minus used, weighted toward windows that reset soonest); the slots number is a pacing hint, not a cap. Never use an account marked STOP or with a problem.",
    "Each launch names one candidate lead issue by repo and number, exactly as listed; never repeat a candidate. Prefer higher-priority candidates. Use both Claude (Opus) and Codex (Sol) accounts.",
    "Keep the note to one line."
  ],
  prompt: ({ observation }) =>
    [
      `Now: ${new Date(observation.now).toISOString()}`,
      `Target: ${observation.target}. In flight: ${observation.inFlight.length}. Room now: ${
        Math.max(0, observation.target - observation.inFlight.length)
      }. Open issues: ${observation.openIssues}.`,
      `Finished last round: ${observation.finished.map((f) => `${f.key}=${f.status}`).join(", ") || "none"}`,
      "",
      "# Accounts (slots = computed ceiling for new launches)",
      table(observation),
      "",
      "# Candidates in priority order (repo#n severity effort title)",
      ...observation.candidates.slice(0, 300).map((c) =>
        `${c.repo}#${c.lead.n} ${c.severity} ${c.effort}${c.fix === undefined ? "" : " FIX"} ${
          c.lead.title.slice(0, 80)
        }`
      )
    ].join("\n"),
  corrections: 2
})

export const PaceFailure = AgentAction.AgentFailure
export const PaceError = Schema.Union([AgentAction.AgentFailure])
