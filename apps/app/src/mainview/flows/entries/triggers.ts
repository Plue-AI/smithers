/*
 * The `triggers` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { limitsRefusal } from "../../state/seams/TriggersSeam"
import { line, text } from "@smthrs/ui/flow-form"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"
import type { Parsed } from "../SlashPayload"

/**
 * The registration a person asks for: which flow, under which name, on which
 * schedule, with which input. Every field but the repository is required,
 * which is what makes the form appear for a door that named none of them.
 */
const Registration = Schema.Struct({
  repo: Schema.optional(Schema.String),
  flow: Schema.String,
  slug: Schema.String,
  schedule: Schema.String,
  /** The target flow's own input, as JSON text; the seam validates it against that flow's declared schema. */
  input: Schema.optional(Schema.String),
  /**
   * What every unattended fire may spend. Blank uses the ceiling the scheduled
   * flow declares for itself; a flow that declares none is refused until this
   * registration names both (PRODUCT.md O-08).
   */
  tokens: Schema.optional(Schema.String),
  minutes: Schema.optional(Schema.String)
})

/**
 * The prepared registration the plan preview's approve button carries back.
 * `requestId` names the one attempt the preview belongs to, so approving
 * repeats that attempt's plan rather than minting a second one.
 */
const PreparedRegistration = Schema.Struct({
  requestId: Schema.String,
  repo: Schema.optional(Schema.String),
  flow: Schema.String,
  slug: Schema.String,
  schedule: Schema.String,
  input: Schema.optional(Schema.String),
  /** Present only when the person named them; the seam derives them again either way. */
  tokens: Schema.optional(Schema.Number),
  minutes: Schema.optional(Schema.Number),
  planId: Schema.String,
  planDigest: Schema.String
})

/** One schedule, by its own name. */
const ScheduleTarget = Schema.Struct({ repo: Schema.optional(Schema.String), slug: Schema.String })

/** One schedule, by its own name, with the repository leading the form's line. */
const RunTarget = Schema.Struct({ slug: Schema.String, repo: Schema.optional(Schema.String) })

/**
 * The button doors below carry their values as one JSON object rather than a
 * positional line: a cron expression holds spaces and a flow's input is
 * itself JSON, so no positional grammar reads them back unambiguously.
 */
const carried = (name: string) => (args: string | undefined): Parsed => {
  try {
    const value: unknown = JSON.parse((args ?? "").trim())
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return { payload: value as Record<string, unknown> }
  } catch { /* fall through to the one honest refusal */ }
  return { error: `${name} takes the values its button carries` }
}

/** The `triggers` flows registered as one aggregator block. */
export const triggersFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * The dispatcher card: the rules declared in .smithers/FACTORY.ts for
     * every visitor through the public mirror, and the box's live rows when a
     * signed-in session's box answers. A read, so it needs no sign-in and the
     * agent lists it freely (Factory design session 2026-09-07, mock 2).
     */
    name: "triggers.list",
    summary: "Show the dispatcher: the events the repository's rules wait for and the flows they start",
    runtime: ["cloud"],
    args: "[owner/repo]",
    input: RepoTarget,
    handler: ({ repo }) => actions.listTriggers(repo)
  }),
  flow({
    /*
     * The register door: it prepares. The workspace plans the target flow with
     * exactly the input given, the plan is previewed, and the registration is
     * written only after the human approves that plan (triggers.approve).
     */
    name: "triggers.register",
    summary: "Register a repository flow to run on a schedule",
    runtime: ["cloud"],
    args: "[owner/repo] --flow <id> --slug <name> --schedule <cron> [--input <json>] [--tokens <n>] [--minutes <n>]",
    requires: ["signed-in"],
    input: Registration,
    form: {
      submitLabel: "Prepare",
      /* The limits the line named meet the registrar's rule here, in the registrar's own words. */
      refuse: limitsRefusal,
      args: payload => JSON.stringify(Object.fromEntries(Object.keys(payload).flatMap(key => {
        const value = text(payload, key)
        return value === undefined ? [] : [[key, value]]
      }))),
      fields: {
        repo: { label: "Repository", optionsFrom: "cloud-repos", kind: "text" },
        flow: { label: "Flow", placeholder: "nightly-lint" },
        slug: { label: "Name", placeholder: "nightly" },
        schedule: { label: "Schedule", placeholder: "0 9 * * 1-5" },
        input: { label: "Input", placeholder: "{}" }
      }
    },
    handler: (payload) => actions.registerTrigger({ operation: "register", ...payload })
  }),
  flow({
    /*
     * The approval. An approval is the human's to give (apps/app/AGENTS.md,
     * three-door law), so the agent may prepare a registration and may never
     * approve one — the same rule approval.approve states.
     */
    name: "triggers.approve",
    summary: "Approve the previewed plan and register the schedule",
    hidden: true,
    runtime: ["cloud"],
    requires: ["signed-in"],
    userOnly: true,
    userOnlyReason: "approvals belong to the human",
    grammar: carried("triggers.approve"),
    input: PreparedRegistration,
    handler: (payload) => actions.registerTrigger({ operation: "approve", ...payload })
  }),
  flow({
    /*
     * Run now: one dispatch of a schedule already registered, through the
     * registrar's own fire operation. Spending a run is consequential, so the
     * agent asks and the human confirms; their own press dispatches, and two
     * presses dispatch twice.
     */
    name: "triggers.run",
    summary: "Run a registered schedule now",
    runtime: ["cloud"],
    args: "<name> [owner/repo]",
    requires: ["signed-in"],
    confirm: (payload) => `run ${String(payload["slug"])} now`,
    input: RunTarget,
    form: {
      submitLabel: "Run now",
      args: (payload) => line(text(payload, "slug"), text(payload, "repo")),
      fields: {
        slug: { label: "Name", placeholder: "nightly" },
        repo: { label: "Repository", optionsFrom: "cloud-repos", kind: "text" }
      }
    },
    handler: ({ repo, slug }) => actions.registerTrigger({ operation: "run", repo, slug })
  }),
  flow({
    name: "triggers.resume",
    summary: "Resume a paused schedule with its reviewed configuration",
    runtime: ["cloud"],
    args: "<name> [owner/repo]",
    requires: ["signed-in"],
    confirm: payload => `resume ${String(payload["slug"])}`,
    input: RunTarget,
    form: {
      submitLabel: "Resume",
      args: payload => line(text(payload, "slug"), text(payload, "repo")),
      fields: { slug: { label: "Name" }, repo: { label: "Repository", optionsFrom: "cloud-repos", kind: "text" } }
    },
    handler: ({ repo, slug }) => actions.registerTrigger({ operation: "resume", repo, slug })
  }),
  flow({
    /* Stopping a schedule is consequential, so the agent asks and the human confirms. */
    name: "triggers.pause",
    summary: "Pause a schedule",
    hidden: true,
    runtime: ["cloud"],
    requires: ["signed-in"],
    confirm: (payload) => `pause ${String(payload["slug"])}`,
    grammar: carried("triggers.pause"),
    input: ScheduleTarget,
    handler: ({ repo, slug }) => actions.registerTrigger({ operation: "pause", repo, slug })
  })
]
