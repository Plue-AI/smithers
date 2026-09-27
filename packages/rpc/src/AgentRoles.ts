/**
 * Role and event contracts for coordinated agents.
 *
 * @since 1.0.0
 */

import { z } from "zod"
import { HARNESS_IDS } from "./LocalApp.ts"

/** Built-in agent roles bind a job to a model and supported local harness. */

/** A role id: lowercase, starts with a letter, 2–41 characters, no spaces.
 * @since 1.0.0
 * @category constants
 */
export const AGENT_ROLE_ID = /^[a-z][a-z0-9-]{1,40}$/
/**
 * Validates agent role id values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentRoleIdSchema = z.string().regex(
  AGENT_ROLE_ID,
  "an agent id is lowercase letters, digits and dashes, starting with a letter"
)
/**
 * The decoded value accepted by {@link AgentRoleIdSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentRoleId = z.infer<typeof AgentRoleIdSchema>

/**
 * A model id as a harness accepts it on its command line: no spaces and no
 * leading dash, so it can never be read as a second flag (flag injection).
 * @since 1.0.0
 * @category constants
 */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,80}$/
/**
 * Validates model id values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelIdSchema = z.string().regex(MODEL_ID, "a model id has no spaces and does not start with a dash")

/** The built-in role ids: the seed rows, in menu order.
 * @since 1.0.0
 * @category constants
 */
export const AGENT_ROLE_IDS = [
  "orchestrator",
  "explainer",
  "implementation",
  "trivial-implementation",
  "ui",
  "fast-ui"
] as const
/**
 * The builtin agent role id contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type BuiltinAgentRoleId = (typeof AGENT_ROLE_IDS)[number]

/**
 * Validates agent role model values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentRoleModelSchema = z.object({
  /** The provider the model belongs to, for the human ("anthropic", "openai", "kimi-for-coding"). */
  provider: z.string(),
  /** The id the harness's model flag takes, verbatim. */
  id: ModelIdSchema,
  /** The label the menus show ("Fable 5"). */
  label: z.string()
})
/**
 * The decoded value accepted by {@link AgentRoleModelSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentRoleModel = z.infer<typeof AgentRoleModelSchema>

/**
 * Validates agent role values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentRoleSchema = z.object({
  id: AgentRoleIdSchema,
  label: z.string().min(1).max(60),
  /** One sentence the model and the UI both read. */
  purpose: z.string().max(400),
  model: AgentRoleModelSchema,
  /** The local harness that runs this model; its availability is the role's. */
  harness: z.enum(HARNESS_IDS),
  /** Whether this role's job is to delegate to the others. */
  delegates: z.boolean(),
  /** Whether the role belongs to the built-in registry. */
  builtin: z.boolean(),
  /** Profile metadata: whether it is a core role or a specialist. */
  kind: z.enum(["core", "specialist", "helper"]).optional(),
  createdAt: z.number(),
  updatedAt: z.number()
})
/**
 * The decoded value accepted by {@link AgentRoleSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentRole = z.infer<typeof AgentRoleSchema>

const seeded = (
  role: Omit<AgentRole, "builtin" | "createdAt" | "updatedAt">
): AgentRole => ({ ...role, builtin: true, createdAt: 0, updatedAt: 0 })

/** The built-in roles: the seed of every agents store, in menu order.
 * @since 1.0.0
 * @category constants
 */
export const AGENT_ROLES: ReadonlyArray<AgentRole> = [
  seeded({
    id: "orchestrator",
    label: "Orchestrator",
    purpose: "The smartest agent: plans, writes workflows frame by frame, and delegates most work to the other roles.",
    model: { provider: "anthropic", id: "claude-fable-5", label: "Fable 5" },
    harness: "claude",
    delegates: true
  }),
  seeded({
    id: "explainer",
    label: "Explainer",
    purpose: "Explains things very well: errors, code, runs, and decisions, in plain language.",
    model: { provider: "kimi-for-coding", id: "kimi-for-coding/k3", label: "Kimi K3" },
    harness: "opencode-kimi",
    delegates: false
  }),
  /*
   * Implement runs on the smart seat, first try included (factory-spec review
   * RULINGS 42, Will, 2026-09-08). `implementation` is the smart seat of this
   * table and is the only row an implement-shaped delegation may take. The
   * fast rows below it (`trivial-implementation` and `fast-ui`) exist for a
   * person who explicitly picks one for a mechanical edit; nothing may route
   * an implement-shaped run to them, and no code here or downstream may
   * "start cheap and escalate". Cost control is parallelism, caching and the
   * prototype-first decision, never a cheaper model for the implementation
   * itself. The pin is
   * apps/app/src/mainview/state/controller/implementSeat.test.ts.
   */
  seeded({
    id: "implementation",
    label: "Implementation",
    purpose: "Implements non-trivial changes end to end, with tests.",
    model: { provider: "openai", id: "gpt-6-sol", label: "GPT-6 Sol" },
    harness: "codex",
    delegates: false
  }),
  seeded({
    id: "trivial-implementation",
    label: "Trivial implementation",
    purpose: "Makes small, low-risk, mechanical changes quickly.",
    model: { provider: "openai", id: "gpt-6-luna", label: "GPT-6 Luna" },
    harness: "codex",
    delegates: false
  }),
  seeded({
    id: "ui",
    label: "UI",
    purpose: "Builds and reviews UI and visual work.",
    model: { provider: "kimi-for-coding", id: "kimi-for-coding/k3", label: "Kimi K3" },
    harness: "opencode-kimi",
    delegates: false
  }),
  seeded({
    id: "fast-ui",
    label: "Fast UI",
    purpose: "Fast, cheap UI iterations.",
    model: { provider: "cerebras", id: "cerebras/qwen-3.8-27b", label: "Cerebras Qwen 3.8 27B" },
    harness: "opencode-cerebras",
    delegates: false
  })
]

/** The role with this id in a list (the built-ins by default), or undefined.
 * @since 1.0.0
 * @category conversions
 */
export const findAgentRole = (id: string, roles: ReadonlyArray<AgentRole> = AGENT_ROLES): AgentRole | undefined =>
  roles.find((candidate) => candidate.id === id)

/** A built-in role by id; throws for anything else (the built-ins are the compile-time table).
 * @since 1.0.0
 * @category conversions
 */
export const agentRole = (id: BuiltinAgentRoleId): AgentRole => {
  const role = findAgentRole(id)
  if (role === undefined) throw new Error(`Unknown agent role ${id}`)
  return role
}

/*
 * Cloud roles (docs: the concierge's side turns). A cloud role is a
 * sub-agent the app Worker answers ITSELF, on the deployment's own Cerebras
 * key, instead of forwarding the turn to the chat upstream: the Librarian
 * answers wiki and repository questions from the runtime context, the Flows
 * agent picks which registered flows achieve a goal. Neither runs a local
 * harness, so a cloud role is not an `AgentRole` (AgentRoleSchema requires a
 * harness) and never appears in the agents store or the `+` menus: it is a
 * separate compile-time table with a `seat: "cloud"` marker. A cloud role is
 * tool-free by contract; the Worker refuses a tool-bearing body on it.
 *
 * The model row is the default; a deployment overrides it with the named
 * environment variable, so the served model is always readable from the
 * Worker's configuration and never claimed by the client.
 */

/** The cloud role ids: the sub-agents the Worker serves on Cerebras.
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_AGENT_ROLE_IDS = ["librarian", "flows"] as const
/**
 * The cloud role id contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type CloudRoleId = (typeof CLOUD_AGENT_ROLE_IDS)[number]
/**
 * Validates cloud role id values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const CloudRoleIdSchema = z.enum(CLOUD_AGENT_ROLE_IDS)

/**
 * Validates cloud role values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const CloudRoleSchema = z.object({
  id: CloudRoleIdSchema,
  label: z.string().min(1).max(60),
  /** One sentence the model and the UI both read. */
  purpose: z.string().max(400),
  /** Served by the app Worker, never by a local harness. */
  seat: z.literal("cloud"),
  /** The default model; `provider` is always "cerebras". */
  model: AgentRoleModelSchema,
  /** The Worker environment variable whose value, when set, replaces `model.id`. */
  modelEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/)
})
/**
 * The decoded value accepted by {@link CloudRoleSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type CloudRole = z.infer<typeof CloudRoleSchema>

/** The cloud roles, in the order the concierge names them.
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_AGENT_ROLES: ReadonlyArray<CloudRole> = [
  {
    id: "librarian",
    label: "Librarian",
    purpose:
      "Answers questions about the Wiki and the repository facts in the runtime context, citing paths and pages, never inventing one.",
    seat: "cloud",
    model: { provider: "cerebras", id: "qwen-3.8-27b", label: "Cerebras Qwen 3.8 27B" },
    modelEnv: "CEREBRAS_MODEL_LIBRARIAN"
  },
  {
    id: "flows",
    label: "Flows",
    purpose:
      "Picks which registered flows achieve a goal and says how to run them, using only flows the catalog offers.",
    seat: "cloud",
    model: { provider: "cerebras", id: "qwen-3.8-27b", label: "Cerebras Qwen 3.8 27B" },
    modelEnv: "CEREBRAS_MODEL_FLOWS"
  }
]

/** Whether an id names a cloud role.
 * @since 1.0.0
 * @category conversions
 */
export const isCloudRoleId = (value: string): value is CloudRoleId =>
  (CLOUD_AGENT_ROLE_IDS as ReadonlyArray<string>).includes(value)

/** A cloud role by id; throws for anything else (the table is compile-time).
 * @since 1.0.0
 * @category conversions
 */
export const cloudRole = (id: CloudRoleId): CloudRole => {
  const role = CLOUD_AGENT_ROLES.find((candidate) => candidate.id === id)
  if (role === undefined) throw new Error(`Unknown cloud role ${id}`)
  return role
}

/**
 * The model id a deployment serves a cloud role on: the role's `modelEnv`
 * variable when it is set to a well-formed model id, else the table default.
 * A malformed override is ignored, not launched: the id is re-checked here
 * against the same model-id alphabet a local role uses.
 * @since 1.0.0
 * @category conversions
 */
export const cloudRoleModelId = (role: CloudRole, env: Readonly<Record<string, string | undefined>>): string => {
  const override = env[role.modelEnv]?.trim()
  return override !== undefined && override !== "" && MODEL_ID.test(override) ? override : role.model.id
}

/** "Explainer · Kimi K3": the menu label.
 * @since 1.0.0
 * @category conversions
 */
export const agentRoleTitle = (role: AgentRole): string => `${role.label} · ${role.model.label}`

/**
 * The display name the built-in tables give a model id ("gpt-6-sol" is
 * "GPT-6 Sol"), or undefined for an id no built-in or cloud role runs on: a
 * repository flow's model shows this name when the id is a known one and the
 * id as written otherwise, never a name invented for it.
 * @since 1.0.0
 * @category conversions
 */
export const knownModelLabel = (id: string): string | undefined =>
  [...AGENT_ROLES, ...CLOUD_AGENT_ROLES].find((role) => role.model.id === id)?.model.label

/**
 * What a harness needs to launch a role: its binary name and the flag that
 * takes a model id (`claude --model`, `codex -m`, `opencode --model`). The
 * harness table (@smthrs/harness-detect) states these, verified against each
 * installed binary's `--help`.
 * @since 1.0.0
 * @category models
 */
export interface HarnessModelSpec {
  /** argv[0]: the binary name, resolved to a path server-side. */
  readonly binary: string
  /** The flag(s) placed before the model id. */
  readonly flag: ReadonlyArray<string>
}
