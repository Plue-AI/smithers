/** HTTP projections use the same literal Operation catalog as interactive acts.
 * They expose no additional slash, CLI or model door. Concrete control bodies
 * must resolve their operation before authorization; there is no control grant.
 */
import { Schema } from "effect"
import { NoInput, operation, type OperationPayload } from "./index"

const read = (name: string, path: string, agent: "run" | "never" = "run", minimumRole: "member" | "owner" = "member") =>
  operation({ name, input: NoInput, summary: name, hidden: true, visibility: "hidden", slash: null, cli: null,
    http: { method: "GET", path }, minimumRole, agent, credentialScope: name === "self.read" ? "read:user" : "read:repository",
    actors: agent === "never" ? ["person"] : ["person", "app_agent", "external_agent"] })

// Empty person-actor lists are system descriptors, not person permissions.
// Credential kinds and stored-subject predicates remain the existing handlers
// (spec 6.1.2d); these rows grant no slash, CLI or model door.
const system = (name: string, method: "GET" | "POST", path: string, credentialScope: "read:workspace" | "write:workspace" | "write:repository", input: OperationPayload = NoInput) =>
  operation({ name, input, summary: name, hidden: true, visibility: "hidden", slash: null, cli: null,
    http: { method, path }, minimumRole: "member", agent: "never", credentialScope, actors: [] })
const source = Schema.Struct({ change_id: Schema.String, commit_id: Schema.String, tree_id: Schema.String, parent_commit_ids: Schema.Array(Schema.String) })
const reservedStack = Schema.Struct({ requestId: Schema.String, source: Schema.optional(source), generation: Schema.optional(Schema.Number) })
const machine = (op: "sleep" | "wake") => operation({
  name: `branch.${op}`, input: Schema.Struct({ branch: Schema.String }), summary: op === "sleep" ? "Sleep branch" : "Wake branch",
  hidden: true, visibility: "hidden", slash: null, cli: null, agent: "never", actors: ["person"], minimumRole: "member",
  http: { method: "POST", path: "/api/branches/{branch}", defaults: { op } }
})

// Retained repository administration keeps its existing owner-only person doors.
const repositoryAdmin = (name: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, input: OperationPayload) =>
  operation({ name, input, summary: name, hidden: true, visibility: "hidden", slash: null, cli: null,
    http: { method, path }, minimumRole: "owner", agent: "never", credentialScope: method === "GET" ? "read:repository" : "write:repository", actors: ["person"] })

export const httpProjections = [
  repositoryAdmin("protected-bookmarks.read", "GET", "/api/repos/{owner}/{repo}/protected-bookmarks", NoInput),
  repositoryAdmin("protected-bookmarks.upsert", "POST", "/api/repos/{owner}/{repo}/protected-bookmarks", Schema.Struct({
    pattern: Schema.String, require_review: Schema.optional(Schema.Boolean), require_human_approvals: Schema.optional(Schema.Number),
    require_agent_lgtm: Schema.optional(Schema.Boolean), require_status_checks: Schema.optional(Schema.Boolean), required_status_contexts: Schema.optional(Schema.Array(Schema.String))
  })),
  repositoryAdmin("protected-bookmarks.delete", "DELETE", "/api/repos/{owner}/{repo}/protected-bookmarks/{pattern}", NoInput),
  repositoryAdmin("labels.create", "POST", "/api/repos/{owner}/{repo}/labels", Schema.Struct({ name: Schema.String, color: Schema.String, description: Schema.optional(Schema.String) })),
  repositoryAdmin("labels.update", "PATCH", "/api/repos/{owner}/{repo}/labels/{id}", Schema.Struct({ name: Schema.optional(Schema.String), color: Schema.optional(Schema.String), description: Schema.optional(Schema.String) })),
  repositoryAdmin("labels.delete", "DELETE", "/api/repos/{owner}/{repo}/labels/{id}", NoInput),
  system("stack.candidate", "POST", "/api/repos/{owner}/{repo}/workspaces/{id}/stack/candidate", "write:repository", reservedStack),
  system("stack.propose", "POST", "/api/repos/{owner}/{repo}/workspaces/{id}/stack/propose", "write:repository", reservedStack),
  system("workspace.head", "POST", "/api/repos/{owner}/{repo}/workspaces/{id}/head", "write:repository", Schema.Struct({
    retain_source: Schema.optional(source), change_id: Schema.optional(Schema.String), commit_id: Schema.optional(Schema.String),
    ahead: Schema.optional(Schema.Number), behind: Schema.optional(Schema.Number), coding_operations: Schema.optional(Schema.Array(Schema.Unknown))
  })),
  system("workspace.children.list", "GET", "/api/repos/{owner}/{repo}/workspaces/{id}/children", "read:workspace"),
  system("workspace.children.spawn", "POST", "/api/repos/{owner}/{repo}/workspaces/{id}/children", "write:workspace", Schema.Struct({ count: Schema.Number, profile: Schema.optional(Schema.String), ttl_secs: Schema.optional(Schema.Number) })),
  system("workspace.children.stop", "POST", "/api/repos/{owner}/{repo}/workspaces/{id}/children/{child_id}/stop", "write:workspace"),
  system("workspace.provider-pool", "GET", "/provider-pool/routes", "read:workspace"),

  operation({
    name: "flow.source-coedit",
    summary: "Edit source",
    hidden: true,
    visibility: "hidden",
    slash: null,
    cli: null,
    input: Schema.Struct({
      changes: Schema.Array(Schema.Struct({
        path: Schema.String,
        base_digest: Schema.String,
        content: Schema.Union([Schema.String, Schema.Null]),
        encoding: Schema.optional(Schema.Literals(["utf-8", "base64"]))
      }))
    }),
    http: { method: "PUT", path: "/api/repos/{owner}/{repo}/workspaces/{id}/files/content" },
    minimumRole: "member",
    agent: "run",
    credentialScope: "write:repository",
    actors: ["person", "external_agent"]
  }),
  machine("sleep"), machine("wake"),
  read("install.read", "/api/install", "never", "owner"),
  read("install.scorecard", "/api/install/scorecard", "never", "owner"),
  operation({ name: "external.read", input: NoInput, summary: "external.read", hidden: true, visibility: "hidden",
    slash: null, cli: null, minimumRole: "owner", agent: "never", credentialScope: "read:repository", actors: ["person"] }),
  read("self.read", "/api/user/orgs"),
  read("repo.read", "/api/repos/{owner}/{repo}/mythical"),
  read("wiki.read", "/api/repos/{owner}/{repo}/wiki"),
  read("sync.read", "/api/github/sync"),
  read("live", "/api/live"),
  read("issue.read", "/api/issues"),
  read("todo.read", "/api/todos"),
  read("agents.read", "/api/agents"),
  read("flows.read", "/api/flows"),
  read("proposals.read", "/api/proposals"),
  read("branches.read", "/api/branches"),
  read("branch.read", "/api/branches/{b}"),
  read("confirmations.read", "/api/confirmations"),
  read("members.list", "/api/members", "never"),
  read("secrets.read", "/api/secrets", "never"),
  operation({ name: "agent.turn", input: NoInput, summary: "Ask agent", hidden: true, visibility: "hidden", agent: "run", credentialScope: "read:user",
    actors: ["person", "app_agent", "external_agent"], minimumRole: "member", http: { method: "POST", path: "/api/conversations/{id}/prompt" } }),
  operation({ name: "telemetry.report", credentialScope: "read:user", input: NoInput, summary: "Report error", hidden: true, visibility: "hidden", agent: "run",
    actors: ["person", "app_agent", "external_agent"], minimumRole: "member", http: { method: "POST", path: "/api/telemetry/errors" } }),
  operation({ name: "sync.retry", input: NoInput, summary: "Retry sync", hidden: true, visibility: "hidden", agent: "run",
    actors: ["person", "app_agent"], minimumRole: "member", http: { method: "POST", path: "/api/github/sync" } })
] as const
