/** HTTP projections use the same literal Operation catalog as interactive acts.
 * They expose no additional slash, CLI or model door. Concrete control bodies
 * must resolve their operation before authorization; there is no control grant.
 */
import { NoInput, operation } from "./index"

const read = (name: string, path: string, agent: "run" | "never" = "run", minimumRole: "member" | "owner" = "member") =>
  operation({ name, input: NoInput, summary: name, hidden: true, visibility: "hidden", slash: null, cli: null,
    http: { method: "GET", path }, minimumRole, agent, credentialScope: name === "self.read" ? "read:user" : "read:repository",
    actors: agent === "never" ? ["person"] : ["person", "app_agent", "external_agent"] })

export const httpProjections = [
  read("install.read", "/api/install", "never", "owner"),
  read("install.scorecard", "/api/install/scorecard", "never", "owner"),
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
