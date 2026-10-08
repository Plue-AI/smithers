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
const repositoryAdmin = (name: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, input: OperationPayload, credentialScope: "read:repository" | "write:repository" = method === "GET" ? "read:repository" : "write:repository") =>
  operation({ name, input, summary: name, hidden: true, visibility: "hidden", slash: null, cli: null,
    http: { method, path }, minimumRole: "owner", agent: "never", credentialScope, actors: ["person"] })

const accountWrite = (name: string, method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, input: OperationPayload) =>
  operation({ name, input, summary: name, hidden: true, visibility: "hidden", slash: null, cli: null,
    http: { method, path }, minimumRole: "owner", agent: "never", credentialScope: "write:user", actors: ["person"] })
const optionalText = Schema.optional(Schema.Union([Schema.String, Schema.Null]))

export const httpProjections = [
 repositoryAdmin("cache.tokens.list", "GET", "/api/repos/{owner}/{repo}/build-cache/tokens", NoInput),
 repositoryAdmin("cache.tokens.create", "POST", "/api/repos/{owner}/{repo}/build-cache/tokens", Schema.Struct({name:optionalText,namespace_prefix:optionalText})),
 repositoryAdmin("cache.tokens.revoke", "DELETE", "/api/repos/{owner}/{repo}/build-cache/tokens/{id}", NoInput),
 operation({ name:"workspace.command.read", input:NoInput, summary:"Read command result", hidden:true, visibility:"hidden", slash:null, cli:null,
   http:{method:"GET",path:"/api/repos/{owner}/{repo}/workspaces/{id}/command-runs/{operationID}"}, minimumRole:"member", agent:"run", credentialScope:"read:repository", actors:["person","app_agent"] }),
 operation({name:"devtools.write",input:Schema.Struct({session_id:Schema.String,kind:Schema.String,repository_id:Schema.optional(Schema.Union([Schema.Number,Schema.Null])),workspace_id:optionalText,payload:Schema.Record(Schema.String,Schema.Unknown)}),summary:"Save a private snapshot",hidden:true,visibility:"hidden",slash:null,cli:null,http:{method:"POST",path:"/api/repos/{owner}/{repo}/devtools/snapshots"},minimumRole:"member",agent:"run",credentialScope:"write:repository",actors:["person","app_agent"]}),
 operation({name:"devtools.read",input:NoInput,summary:"Read private snapshots",hidden:true,visibility:"hidden",slash:null,cli:null,http:{method:"GET",path:"/api/repos/{owner}/{repo}/devtools/snapshots"},minimumRole:"member",agent:"run",credentialScope:"read:repository",actors:["person","app_agent"]}),
 operation({ name: "landings.read", input: NoInput, summary: "Read recorded review data", hidden: true, visibility: "hidden", slash: null, cli: null,
   http: { method: "GET", path: "/api/repos/{owner}/{repo}/landings" }, minimumRole: "member", agent: "run", credentialScope: "write:repository", actors: ["person", "app_agent"] }),
 repositoryAdmin("mirror.read", "GET", "/api/repos/{owner}/{repo}/mirror-sync/{run_id}", NoInput),
 repositoryAdmin("workspace.preview.update", "PUT", "/api/repos/{owner}/{repo}/workspaces/{id}/services/{port}/visibility", Schema.Struct({ public: Schema.Boolean })),
 operation({ name: "runs.cancel", input: NoInput, summary: "Stop run", hidden: true, visibility: "hidden", slash: null, cli: null,
   http: { method: "POST", path: "/api/repos/{owner}/{repo}/runs/{id}/cancel" }, minimumRole: "member", agent: "confirm", credentialScope: "write:repository", actors: ["person", "app_agent"] }),
 repositoryAdmin("egress.update", "PATCH", "/api/repos/{owner}/{repo}/egress-policy", Schema.Struct({ add: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.Null])), remove: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.Null])) })),
 repositoryAdmin("egress.read", "GET", "/api/repos/{owner}/{repo}/egress-policy", NoInput, "write:repository"),
 operation({ name: "account.oauth.revoke", input: NoInput, summary: "Revoke app access", hidden: true, visibility: "hidden", slash: null, cli: null,
   http: { method: "POST", path: "/api/oauth2/revoke-all" }, minimumRole: "member", agent: "run", credentialScope: "write:user", actors: ["external_agent"] }),
 read("github.import-read", "/api/github/import/{id}", "never", "owner"),
 repositoryAdmin("webhooks.test", "POST", "/api/repos/{owner}/{repo}/hooks/{id}/tests", NoInput, "write:repository"),
 repositoryAdmin("webhooks.list", "GET", "/api/repos/{owner}/{repo}/hooks", NoInput, "write:repository"),
 repositoryAdmin("webhooks.create", "POST", "/api/repos/{owner}/{repo}/hooks", Schema.Struct({ url: Schema.String, secret: optionalText, events: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.Null])), is_active: Schema.optional(Schema.Union([Schema.Boolean, Schema.Null])) }), "write:repository"),
 repositoryAdmin("webhooks.get", "GET", "/api/repos/{owner}/{repo}/hooks/{id}", NoInput, "write:repository"),
 repositoryAdmin("webhooks.update", "PATCH", "/api/repos/{owner}/{repo}/hooks/{id}", Schema.Struct({ url: optionalText, secret: optionalText, events: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.Null])), is_active: Schema.optional(Schema.Union([Schema.Boolean, Schema.Null])) }), "write:repository"),
 repositoryAdmin("webhooks.delete", "DELETE", "/api/repos/{owner}/{repo}/hooks/{id}", NoInput, "write:repository"),
 repositoryAdmin("webhooks.deliveries", "GET", "/api/repos/{owner}/{repo}/hooks/{id}/deliveries", NoInput, "write:repository"),
 repositoryAdmin("webhooks.redeliver", "POST", "/api/repos/{owner}/{repo}/hooks/{id}/deliveries/{delivery_id}/redeliver", NoInput, "write:repository"),
 repositoryAdmin("repo.archive", "POST", "/api/repos/{owner}/{repo}/archive", NoInput),
 repositoryAdmin("repo.unarchive", "POST", "/api/repos/{owner}/{repo}/unarchive", NoInput),
 repositoryAdmin("repo.topics.update", "PUT", "/api/repos/{owner}/{repo}/topics", Schema.Struct({ topics: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.Null])) })),
 repositoryAdmin("deploy-keys.read","GET","/api/repos/{owner}/{repo}/keys",NoInput),
 repositoryAdmin("deploy-keys.create","POST","/api/repos/{owner}/{repo}/keys",Schema.Struct({ title:Schema.String,key:Schema.String,read_only:Schema.optional(Schema.Boolean) })),
 repositoryAdmin("deploy-keys.delete","DELETE","/api/repos/{owner}/{repo}/keys/{id}",NoInput),
 accountWrite("account.inbox.read", "PATCH", "/api/notifications/{id}", NoInput),
 accountWrite("account.inbox.read-all", "PUT", "/api/notifications/mark-read", NoInput),
 accountWrite("account.inbox.preferences", "PUT", "/api/notifications/preferences", Schema.Struct({
 notify_issues: Schema.optional(Schema.Union([Schema.Boolean, Schema.Null])), notify_landings: Schema.optional(Schema.Union([Schema.Boolean, Schema.Null])), notify_mentions: Schema.optional(Schema.Union([Schema.Boolean, Schema.Null]))
 })),
 accountWrite("account.email.add", "POST", "/api/user/emails", Schema.Struct({ email: Schema.String, is_primary: Schema.optional(Schema.Boolean) })),
 accountWrite("account.email.delete", "DELETE", "/api/user/emails/{id}", NoInput),
 accountWrite("account.email.verify", "POST", "/api/user/emails/{id}/verify", NoInput),
 accountWrite("account.signup.update", "PUT", "/api/user/settings/signup", Schema.Struct({
 name: Schema.String, account: Schema.String, stage: Schema.String, question: Schema.optional(Schema.Number), repo: optionalText,
 answers: Schema.optional(Schema.Union([Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String), Schema.Null])), Schema.Null]))
 })),
 accountWrite("account.device.register", "POST", "/api/user/devices", Schema.Struct({ apns_token: Schema.String, platform: optionalText })),
 accountWrite("account.device.delete", "DELETE", "/api/user/devices", Schema.Struct({ apns_token: Schema.String })),
  accountWrite("account.profile.update", "PATCH", "/api/user", Schema.Struct({ display_name: optionalText, bio: optionalText, avatar_url: optionalText, email: optionalText })),
  accountWrite("account.notifications.update", "PUT", "/api/user/settings/notifications", Schema.Struct({ email_notifications_enabled: Schema.optional(Schema.Union([Schema.Boolean, Schema.Null])) })),
  accountWrite("account.connection.delete", "DELETE", "/api/user/connections/{id}", NoInput),
  read("github.account-read", "/api/user/github-repos", "never", "owner"),
  // Values retain the existing write-scope requirement even on reads.
  repositoryAdmin("variables.read", "GET", "/api/repos/{owner}/{repo}/variables", NoInput, "write:repository"),
  repositoryAdmin("variables.set", "POST", "/api/repos/{owner}/{repo}/variables", Schema.Struct({ name: Schema.String, value: Schema.String })),
  repositoryAdmin("variables.delete", "DELETE", "/api/repos/{owner}/{repo}/variables/{name}", NoInput),
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
  // HTTP authorization retains operation-specific write fences. These descriptors
  // are not browser, slash, CLI or model doors; /secrets owns the controls.
  ...(["set", "scope", "delete"] as const).map(op => operation({
    name: `secrets.${op}`, input: NoInput, summary: "Change secret", hidden: true, visibility: "hidden", slash: null, cli: null,
    http: { method: op === "set" ? "POST" : op === "scope" ? "PATCH" : "DELETE", path: op === "set" ? "/api/secrets" : "/api/secrets/{name}" },
    minimumRole: "maintainer", agent: "never", credentialScope: "write:repository", actors: ["person"]
  })),
  operation({ name: "agent.turn", input: NoInput, summary: "Ask agent", hidden: true, visibility: "hidden", agent: "run", credentialScope: "read:user",
    actors: ["person", "app_agent", "external_agent"], minimumRole: "member", http: { method: "POST", path: "/api/conversations/{id}/prompt" } }),
  operation({ name: "telemetry.report", credentialScope: "read:user", input: NoInput, summary: "Report error", hidden: true, visibility: "hidden", agent: "run",
    actors: ["person", "app_agent", "external_agent"], minimumRole: "member", http: { method: "POST", path: "/api/telemetry/errors" } }),
  operation({ name: "sync.retry", input: NoInput, summary: "Retry sync", hidden: true, visibility: "hidden", agent: "run",
    actors: ["person", "app_agent"], minimumRole: "member", http: { method: "POST", path: "/api/github/sync" } })
] as const
