/** Backend command schemas, owned by the npm CLI.
 * @since 0.1.0
 */

import { z } from "incur"
/** @private
 * @since 0.1.0
 */
export const definitions = {
  "admin alerts channels add": {
    description: "Add an alert channel",
    args: z.object({}),
    options: z.object({
      "type": z.enum(["email", "sms", "pagerduty", "webhook"]).describe("Notification channel type"),
      "display-name": z.string().describe("display name"),
      "target": z.string().describe("target"),
      "route": z.enum(["critical", "all"]).describe("Alert routing severity")
    })
  },
  "admin alerts channels list": {
    description: "List alert channels",
    args: z.object({}),
    options: z.object({})
  },
  "admin alerts channels remove": {
    description: "Remove an alert channel",
    args: z.object({ "id": z.string().describe("Exact target id") }),
    options: z.object({ "yes": z.boolean().describe("Confirm this destructive operation").default(false) })
  },
  "admin alerts channels send-code": {
    description: "Send a verification code to an alert channel",
    args: z.object({ "id": z.string().describe("Exact target id") }),
    options: z.object({})
  },
  "admin alerts channels set-route": {
    description: "Choose which alerts a channel receives",
    args: z.object({ "id": z.string().describe("Exact target id") }),
    options: z.object({ "route": z.enum(["critical", "all"]).describe("Alert routing severity") })
  },
  "admin alerts channels verify": {
    description: "Verify an alert channel with its code",
    args: z.object({ "id": z.string().describe("Exact target id") }),
    options: z.object({ "code": z.string().describe("code") })
  },
  "admin alerts policies disable": {
    description: "Turn off an alert policy",
    args: z.object({ "name": z.string().describe("Exact target name") }),
    options: z.object({})
  },
  "admin alerts policies enable": {
    description: "Turn on an alert policy",
    args: z.object({ "name": z.string().describe("Exact target name") }),
    options: z.object({})
  },
  "admin alerts policies list": {
    description: "List alert policies",
    args: z.object({}),
    options: z.object({})
  },
  "admin analytics summary": {
    description: "Summarize product usage over a time range",
    args: z.object({}),
    options: z.object({
      "include-synthetic": z.boolean().describe("Include synthetic users and their resources").default(false),
      "range": z.string().describe("range").optional()
    })
  },
  "admin audit list": {
    description: "List audit log entries",
    args: z.object({}),
    options: z.object({ "since": z.string().describe("since") })
  },
  "admin deploys observe list": {
    description: "List Observe deployments",
    args: z.object({}),
    options: z.object({})
  },
  "admin deploys observe redeploy": {
    description: "Redeploy an Observe deployment",
    args: z.object({ "id": z.string().describe("Exact target id") }),
    options: z.object({ "yes": z.boolean().describe("Confirm this destructive operation").default(false) })
  },
  "admin deploys observe restart": {
    description: "Restart an Observe deployment",
    args: z.object({ "id": z.string().describe("Exact target id") }),
    options: z.object({ "yes": z.boolean().describe("Confirm this destructive operation").default(false) })
  },
  "admin deploys observe rollback": {
    description: "Roll back an Observe deployment",
    args: z.object({ "id": z.string().describe("Exact target id") }),
    options: z.object({ "yes": z.boolean().describe("Confirm this destructive operation").default(false) })
  },
  "admin deploys platform list": {
    description: "List platform components",
    args: z.object({}),
    options: z.object({})
  },
  "admin deploys platform rollback": {
    description: "Roll a platform component back to a revision",
    args: z.object({ "component": z.string().describe("Exact target component") }),
    options: z.object({
      "revision": z.string().describe("revision"),
      "yes": z.boolean().describe("Confirm this destructive operation").default(false)
    })
  },
  "admin deploys platform status": {
    description: "Show a platform component's deployment status",
    args: z.object({ "component": z.string().describe("Exact target component") }),
    options: z.object({})
  },
  "admin health": { description: "System health status", args: z.object({}), options: z.object({}) },
  "admin runs list": {
    description: "List workflow runs in a repository",
    args: z.object({}),
    options: z.object({
      "repo": z.string().describe("Repository (OWNER/REPO)"),
      "limit": z.coerce.number().describe("Results per page").default(30),
      "page": z.coerce.number().describe("Page number").default(1)
    })
  },
  "admin sessions cancel": {
    description: "Cancel an agent session",
    args: z.object({ "id": z.string().describe("Exact target id") }),
    options: z.object({
      "reason": z.string().describe("reason").optional(),
      "yes": z.boolean().describe("Confirm this destructive operation").default(false)
    })
  },
  "admin sessions list": {
    description: "List agent sessions",
    args: z.object({}),
    options: z.object({
      "include-synthetic": z.boolean().describe("Include synthetic users and their resources").default(false),
      "limit": z.coerce.number().describe("limit").optional(),
      "status": z.string().describe("status").optional()
    })
  },
  "admin status": { description: "Show system status", args: z.object({}), options: z.object({}) },
  "admin tokens list": {
    description: "List access tokens",
    args: z.object({}),
    options: z.object({
      "expiring-days": z.coerce.number().describe("expiring-days").optional(),
      "limit": z.coerce.number().describe("limit").optional(),
      "scope": z.string().describe("scope").optional(),
      "unused-days": z.coerce.number().describe("unused-days").optional()
    })
  },
  "admin user create": {
    description: "Create a user",
    args: z.object({}),
    options: z.object({ "username": z.string().describe("Username"), "email": z.string().describe("Email address") })
  },
  "admin user delete": {
    description: "Suspend a user and mark it deleted; keeps its data",
    args: z.object({ "username": z.string().describe("Username to delete") }),
    options: z.object({ "yes": z.boolean().describe("Confirm deleting the user").default(false) })
  },
  "admin user erase": {
    description: "Erase a user's data; keeps billing records",
    args: z.object({ "username": z.string().describe("Username to erase") }),
    options: z.object({
      "request-date": z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).describe(
        "Date the user asked for deletion (YYYY-MM-DD)"
      ),
      "user-id": z.coerce.number().int().positive().optional().describe(
        "Account id the first erase returned; required once the username is reused"
      ),
      "yes": z.boolean().describe("Confirm erasing the user").default(false)
    })
  },
  "admin user export": {
    description: "Download a user's data as a tar.gz archive",
    args: z.object({
      "username": z.string().describe("Username to export"),
      "out": z.string().describe("Archive path to write")
    }),
    options: z.object({})
  },
  "admin user disable": {
    description: "Suspend a user",
    args: z.object({ "username": z.string().describe("Username to suspend") }),
    options: z.object({})
  },
  "admin user enable": {
    description: "Lift a user's suspension",
    args: z.object({ "username": z.string().describe("Username to unsuspend") }),
    options: z.object({})
  },
  "admin user list": {
    description: "List all users",
    args: z.object({}),
    options: z.object({
      "limit": z.coerce.number().describe("Results per page").default(30),
      "page": z.coerce.number().describe("Page number").default(1)
    })
  },
  "admin users set-synthetic": {
    description: "Mark a user as synthetic or not",
    args: z.object({ "username": z.string().describe("Exact target username") }),
    options: z.object({ "value": z.enum(["true", "false"]).describe("Whether the user is synthetic") })
  },
  "admin workspaces list": {
    description: "List workspaces",
    args: z.object({}),
    options: z.object({
      "include-synthetic": z.boolean().describe("Include synthetic users and their resources").default(false),
      "kind": z.string().describe("kind").optional(),
      "limit": z.coerce.number().describe("limit").optional(),
      "owner": z.string().describe("owner").optional(),
      "status": z.string().describe("status").optional()
    })
  },
  "admin workspaces stop": {
    description: "Stop a workspace",
    args: z.object({ "id": z.string().describe("Exact target id") }),
    options: z.object({ "yes": z.boolean().describe("Confirm this destructive operation").default(false) })
  },
  "admin workspaces suspend": {
    description: "Suspend a workspace",
    args: z.object({ "id": z.string().describe("Exact target id") }),
    options: z.object({ "yes": z.boolean().describe("Confirm this destructive operation").default(false) })
  },
  "agent ask": {
    description: "Talk to the local Smithers usage helper",
    args: z.object({
      "prompt": z.string().describe("Optional one-shot prompt for the local Smithers helper").optional()
    }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "agent chat": {
    description: "Send a message to an existing remote conversation",
    args: z.object({ "id": z.string().describe("Session ID"), "message": z.string().describe("Message to send") }),
    options: z.object({
      "provider": z.enum(["smithers", "codex"]).describe("Remote agent provider").default("smithers"),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "transport": z.enum(["workflow", "http"]).describe("Remote agent transport").default("workflow")
    })
  },
  "agent list": {
    description: "List remote conversations",
    args: z.object({}),
    options: z.object({
      "page": z.coerce.number().describe("Page number").default(1),
      "per-page": z.coerce.number().describe("Results per page").default(30),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "agent run": {
    description: "Start a remote conversation and run a prompt",
    args: z.object({ "prompt": z.string().describe("Prompt to send to the remote agent") }),
    options: z.object({
      "provider": z.enum(["smithers", "codex"]).describe("Remote agent provider").default("smithers"),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "title": z.string().describe("Conversation title").optional(),
      "transport": z.enum(["workflow", "http"]).describe("Remote agent transport").default("workflow")
    })
  },
  "agent session chat": {
    description: "Send a message to an existing remote conversation",
    args: z.object({ "id": z.string().describe("Session ID"), "message": z.string().describe("Message to send") }),
    options: z.object({
      "provider": z.enum(["smithers", "codex"]).describe("Remote agent provider").default("smithers"),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "transport": z.enum(["workflow", "http"]).describe("Remote agent transport").default("workflow")
    })
  },
  "agent session list": {
    description: "List remote conversations",
    args: z.object({}),
    options: z.object({
      "page": z.coerce.number().describe("Page number").default(1),
      "per-page": z.coerce.number().describe("Results per page").default(30),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "agent session run": {
    description: "Start a remote conversation and run a prompt",
    args: z.object({ "prompt": z.string().describe("Prompt to send to the remote agent") }),
    options: z.object({
      "provider": z.enum(["smithers", "codex"]).describe("Remote agent provider").default("smithers"),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "title": z.string().describe("Conversation title").optional(),
      "transport": z.enum(["workflow", "http"]).describe("Remote agent transport").default("workflow")
    })
  },
  "agent session view": {
    description: "View a remote conversation",
    args: z.object({ "id": z.string().describe("Session ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "agent view": {
    description: "View a remote conversation",
    args: z.object({ "id": z.string().describe("Session ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "api": {
    description: "Make raw API calls to the Smithers server",
    args: z.object({ endpoint: z.string() }),
    options: z.object({
      method: z.string().default("GET"),
      field: z.array(z.string()).optional(),
      header: z.array(z.string()).optional(),
      input: z.string().describe("JSON request body from a file, or - for stdin").optional()
    })
  },
  "artifact download": {
    description: "Download an artifact from a workflow run",
    args: z.object({ "runId": z.coerce.number().describe("Run ID"), "name": z.string().describe("Artifact name") }),
    options: z.object({
      "output": z.string().describe("Output path (defaults to artifact name)").optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "artifact list": {
    description: "List artifacts for a workflow run",
    args: z.object({ "runId": z.coerce.number().describe("Run ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "auth connect": {
    description:
      "Connect an Anthropic API key (--api-key) for your own agent runs on a self-hosted server. Vendor subscriptions stay with their own CLIs; sign into Codex on the workspace with codex login --device-auth",
    args: z.object({ "provider": z.string().describe("claude or codex") }),
    options: z.object({
      "label": z.string().describe("Display label for the connection").optional(),
      "api-key": z.boolean().describe("Read an Anthropic API key from stdin (claude only)").default(false)
    })
  },
  "auth connections": {
    description: "List connected subscriptions",
    args: z.object({}),
    options: z.object({ "org": z.string().describe("List an organization's connections").optional() })
  },
  "auth local bootstrap": {
    description: "Create and log in as the installation owner",
    args: z.object({}),
    options: z.object({
      "host": z.string().describe("Hostname or API origin (alias for --hostname)").optional(),
      "hostname": z.string().describe("Hostname or API origin").optional(),
      "username": z.string().describe("Owner username").optional()
    })
  },
  "auth local login": {
    description: "Log in to an owner backend",
    args: z.object({}),
    options: z.object({
      "host": z.string().describe("Hostname or API origin (alias for --hostname)").optional(),
      "hostname": z.string().describe("Hostname or API origin").optional(),
      "username": z.string().describe("Owner username").optional()
    })
  },
  "auth local status": {
    description: "Show owner setup status",
    args: z.object({}),
    options: z.object({
      "host": z.string().describe("Hostname or API origin (alias for --hostname)").optional(),
      "hostname": z.string().describe("Hostname or API origin").optional()
    })
  },
  "auth login": {
    description: "Log in to Smithers",
    args: z.object({}),
    options: z.object({
      "admin": z.boolean().describe("Request an expiring administrator token with browser consent").default(false),
      "host": z.string().describe("Hostname or API URL (alias for --hostname)").optional(),
      "hostname": z.string().describe("Hostname or API URL to authenticate with").optional(),
      "observe": z.boolean().describe("Sign in as an administrator and open Observe already authenticated").default(
        false
      ),
      "ttl": z.string().describe("Admin token lifetime (5m to 12h; default 1h)").optional(),
      "with-token": z.boolean().describe("Read token from stdin instead of browser flow").default(false)
    })
  },
  "auth logout": {
    description: "Log out of Smithers",
    args: z.object({}),
    options: z.object({ "hostname": z.string().describe("Hostname or API URL to log out from").optional() })
  },
  "auth revoke": {
    description: "Revoke a connected subscription",
    args: z.object({ "id": z.string().describe("Connection id") }),
    options: z.object({})
  },
  "auth status": {
    description: "Show authentication status",
    args: z.object({}),
    options: z.object({ "hostname": z.string().describe("Hostname or API URL to inspect").optional() })
  },
  "auth token": {
    description: "Show token status without displaying the credential",
    args: z.object({}),
    options: z.object({ "hostname": z.string().describe("Hostname or API URL to inspect").optional() })
  },
  "bookmark create": {
    description: "Create a bookmark",
    args: z.object({ "name": z.string().describe("Bookmark name") }),
    options: z.object({
      "change": z.string().describe("Target change ID").optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "bookmark delete": {
    description: "Delete a bookmark",
    args: z.object({ "name": z.string().describe("Bookmark name") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "bookmark list": { description: "List local bookmarks", args: z.object({}), options: z.object({}) },
  "cache clear": {
    description: "Clear workflow caches for a repository",
    args: z.object({}),
    options: z.object({
      "bookmark": z.string().describe("Filter by bookmark name").optional(),
      "key": z.string().describe("Filter by cache key").optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "cache connect": {
    description:
      "Connect this workspace to the Smithers Cloud build cache: mint a public read token and declare it in the root PACKAGE.ts",
    args: z.object({}),
    options: z.object({
      "repo": z.string().describe("Repository (OWNER/REPO); detected from the jj or git remote when omitted")
        .optional(),
      "workspace": z.string().describe("Workspace root holding PACKAGE.ts").default("."),
      "write": z.boolean().describe("Write the declaration into PACKAGE.ts (false prints it)").default(true)
    })
  },
  "cache list": {
    description: "List workflow caches for a repository",
    args: z.object({}),
    options: z.object({
      "bookmark": z.string().describe("Filter by bookmark name").optional(),
      "key": z.string().describe("Filter by cache key").optional(),
      "limit": z.coerce.number().describe("Number of results").default(30),
      "page": z.coerce.number().describe("Page number").default(1),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "cache stats": {
    description: "Show workflow cache statistics for a repository",
    args: z.object({}),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "cache token create": {
    description: "Mint a public read token: it can only read this repository's build cache and is safe to commit",
    args: z.object({}),
    options: z.object({
      "name": z.string().describe("A label for the token").default(""),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "cache token list": {
    description: "List the repository's active public read tokens",
    args: z.object({}),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "cache token revoke": {
    description: "Revoke a public read token by id",
    args: z.object({}),
    options: z.object({
      "id": z.coerce.number().describe("Token id").default(0),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "change conflicts": {
    description: "List conflicts in a change",
    args: z.object({ "id": z.string().describe("Change ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "change diff": {
    description: "Show diff for a change",
    args: z.object({ "id": z.string().describe("Change ID (defaults to working copy)").optional() }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "change files": {
    description: "List files in a change",
    args: z.object({ "id": z.string().describe("Change ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "change list": {
    description: "List changes",
    args: z.object({}),
    options: z.object({
      "limit": z.coerce.number().describe("Number of changes to show").default(10),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "change show": {
    description: "Show a specific change",
    args: z.object({ "id": z.string().describe("Change ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "changeset create": {
    description: "Create a changeset that pins one change per member repository",
    args: z.object({}),
    options: z.object({
      "org": z.string().describe("Organization name"),
      "member": z.array(z.string()).describe("Member as REPO=CHANGE_ID (repeat or comma-separate for several)").default(
        []
      ),
      "description": z.string().describe("Changeset description").default(""),
      "parent": z.string().describe("Parent changeset change id (stacking)").default(""),
      "target": z.string().describe("Target bookmark for every member and the superproject").default("main")
    })
  },
  "changeset get": {
    description: "Show a changeset",
    args: z.object({}),
    options: z.object({
      "org": z.string().describe("Organization name"),
      "id": z.coerce.number().describe("Changeset id").default(0)
    })
  },
  "changeset land": {
    description: "Land a changeset: every member change, then the superproject commit, as one transaction",
    args: z.object({}),
    options: z.object({
      "org": z.string().describe("Organization name"),
      "id": z.coerce.number().describe("Changeset id").default(0)
    })
  },
  "changeset list": {
    description: "List an organization's changesets",
    args: z.object({}),
    options: z.object({
      "org": z.string().describe("Organization name"),
      "limit": z.coerce.number().describe("Results per page").default(30),
      "page": z.coerce.number().describe("Page number").default(1)
    })
  },
  "completion": { description: "Generate shell completions", args: z.object({}), options: z.object({}) },
  "config get": {
    description: "Get a config value by key",
    args: z.object({ "key": z.string().describe("Config key (api_origin, observe_url, git_protocol)") }),
    options: z.object({})
  },
  "config list": { description: "List all config values", args: z.object({}), options: z.object({}) },
  "config set": {
    description: "Set a config value by key",
    args: z.object({
      "key": z.string().describe("Config key (api_origin, observe_url, git_protocol)"),
      "value": z.string().describe("Value to set")
    }),
    options: z.object({})
  },
  "config show": {
    description: "Show effective configuration with env var overrides and source information",
    args: z.object({}),
    options: z.object({})
  },
  "egress allow": {
    description: "Let the repository's sandboxes reach a host",
    args: z.object({ "host": z.string().describe("Host name or *.domain") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "egress deny": {
    description: "Take a host off the repository's egress allowlist",
    args: z.object({ "host": z.string().describe("Host name or *.domain") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "egress list": {
    description: "List the hosts the repository's sandboxes may reach",
    args: z.object({}),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "history backfill": {
    description: "Admit every open issue to the history now",
    args: z.object({}),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "history bootstrap": {
    description: "Create the history from main's commits",
    args: z.object({}),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "history parallel": {
    description: "Set how many lanes work at once",
    args: z.object({ "lanes": z.coerce.number().describe("Lanes, 1 to 8") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "history land": {
    description: "Land a proposed TODO's pull request once its review approves and CI is green",
    args: z.object({ "issue": z.string().describe("Issue number (12 or #12) or item id") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "history retry": {
    description: "Give a blocked, rejected or declined issue a fresh set of attempts",
    args: z.object({ "issue": z.string().describe("Issue number (12 or #12) or item id") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "history show": {
    description: "Show the history: each issue's lane, checks and pull request",
    args: z.object({}),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "history todo": {
    description: "File a TODO for the factory",
    args: z.object({ "title": z.string().describe("TODO title") }),
    options: z.object({
      "body": z.string().describe("TODO body").default(""),
      "request": z.string().describe("Request id: sending it again returns the TODO already filed").optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "history watch": {
    description: "Follow one issue until its pull request is open or it stops",
    args: z.object({ "issue": z.string().describe("Issue number (12 or #12) or item id") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "issue close": {
    description: "Close an issue",
    args: z.object({ "number": z.string().describe("Issue number") }),
    options: z.object({
      "comment": z.string().describe("Add a comment when closing").optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "issue comment": {
    description: "Add a comment to an issue",
    args: z.object({ "number": z.string().describe("Issue number") }),
    options: z.object({
      "body": z.string().describe("Comment body"),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "issue create": {
    description: "Create an issue",
    args: z.object({ "title": z.string().describe("Issue title").optional() }),
    options: z.object({
      "assignee": z.string().describe("Assignee username").optional(),
      "body": z.string().describe("Issue body").default(""),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "title": z.string().describe("Issue title").optional()
    })
  },
  "issue edit": {
    description: "Edit an issue",
    args: z.object({ "number": z.string().describe("Issue number") }),
    options: z.object({
      "assignee": z.string().describe("Add assignee username").optional(),
      "body": z.string().describe("New body").optional(),
      "label": z.string().describe("Add label name").optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "title": z.string().describe("New title").optional()
    })
  },
  "issue list": {
    description: "List issues",
    args: z.object({}),
    options: z.object({
      "all": z.boolean().describe("Fetch all pages automatically").default(false),
      "cursor": z.string().describe("Pagination cursor (from previous response)").optional(),
      "limit": z.coerce.number().describe("Results per page").default(30),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "state": z.enum(["open", "closed", "fixed", "verified", "all"]).describe("Filter by state").default("open"),
      "view": z.string().describe("Saved issue view id from issue views; replaces --state").optional()
    })
  },
  "issue reopen": {
    description: "Reopen an issue",
    args: z.object({ "number": z.string().describe("Issue number") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "issue view": {
    description: "View an issue",
    args: z.object({ "number": z.string().describe("Issue number") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "issue views": {
    description: "List the repository's saved issue views",
    args: z.object({}),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "label create": {
    description: "Create a label",
    args: z.object({ "name": z.string().describe("Label name") }),
    options: z.object({
      "color": z.string().describe("Label color (hex)").default(""),
      "description": z.string().describe("Label description").default(""),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "label delete": {
    description: "Delete a label",
    args: z.object({ "id": z.coerce.number().describe("Label ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "label list": {
    description: "List labels",
    args: z.object({}),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "land checks": {
    description: "View landing request checks",
    args: z.object({ "number": z.string().describe("Landing request number") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "land comment": {
    description: "Add a comment to a landing request",
    args: z.object({ "number": z.string().describe("Landing request number") }),
    options: z.object({
      "body": z.string().describe("Comment body"),
      "commit": z.string().describe("Commit ID of the revision being commented on"),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "land conflicts": {
    description: "View landing request conflicts",
    args: z.object({ "number": z.string().describe("Landing request number") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "land create": {
    description: "Create a landing request",
    args: z.object({}),
    options: z.object({
      "title": z.string().describe("Landing request title"),
      "body": z.string().describe("Landing request body").default(""),
      "change": z.string().describe("Change ID(s) to land").optional(),
      "change-id": z.string().describe("Change ID(s) to land").optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "stack": z.boolean().describe("Include the full stack up to the target").default(false),
      "target": z.string().describe("Target bookmark").default("main")
    })
  },
  "land edit": {
    description: "Edit a landing request",
    args: z.object({ "number": z.string().describe("Landing request number") }),
    options: z.object({
      "body": z.string().describe("New body").optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "target": z.string().describe("New target bookmark").optional(),
      "title": z.string().describe("New title").optional()
    })
  },
  "land land": {
    description: "Land (merge) a landing request",
    args: z.object({ "number": z.string().describe("Landing request number") }),
    options: z.object({
      "commit": z.string().describe("Expected current commit ID"),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "land list": {
    description: "List landing requests",
    args: z.object({}),
    options: z.object({
      "all": z.boolean().describe("Fetch all pages automatically").default(false),
      "cursor": z.string().describe("Pagination cursor (from previous response)").optional(),
      "limit": z.coerce.number().describe("Results per page").default(30),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "state": z.enum(["open", "closed", "merged", "landed", "all"]).describe("Filter by state").default("open")
    })
  },
  "land review": {
    description: "Submit a review on a landing request",
    args: z.object({ "number": z.string().describe("Landing request number") }),
    options: z.object({
      "commit": z.string().describe("Commit ID of the revision being reviewed"),
      "approve": z.boolean().describe("Approve the landing request").default(false),
      "body": z.string().describe("Review comment").default(""),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "land view": {
    description: "View a landing request",
    args: z.object({ "number": z.string().describe("Landing request number") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "notification list": {
    description: "List notifications",
    args: z.object({}),
    options: z.object({
      "all": z.boolean().describe("Fetch all pages automatically").default(false),
      "cursor": z.string().describe("Pagination cursor (from previous response)").optional(),
      "limit": z.coerce.number().describe("Results per page").default(30),
      "unread": z.boolean().describe("Show only unread notifications").default(false)
    })
  },
  "notification read": {
    description: "Mark a notification as read",
    args: z.object({ "id": z.string().describe("Notification ID").optional() }),
    options: z.object({ "all": z.boolean().describe("Mark all notifications as read").default(false) })
  },
  "org create": {
    description: "Create an organization",
    args: z.object({ "name": z.string().describe("Organization name") }),
    options: z.object({
      "description": z.string().describe("Organization description").default(""),
      "visibility": z.enum(["public", "limited", "private"]).describe("Organization visibility").default("public")
    })
  },
  "org edit": {
    description: "Update organization settings",
    args: z.object({ "name": z.string().describe("Organization name") }),
    options: z.object({
      "description": z.string().describe("New organization description").optional(),
      "visibility": z.enum(["public", "limited", "private", ""]).describe("Organization visibility").default("")
    })
  },
  "org list": {
    description: "List organizations for the authenticated user",
    args: z.object({}),
    options: z.object({})
  },
  "org member add": {
    description: "Add a member to an organization",
    args: z.object({
      "org": z.string().describe("Organization name"),
      "username": z.string().describe("Username to add")
    }),
    options: z.object({})
  },
  "org member list": {
    description: "List members in an organization",
    args: z.object({ "org": z.string().describe("Organization name") }),
    options: z.object({})
  },
  "org member remove": {
    description: "Remove a member from an organization",
    args: z.object({
      "org": z.string().describe("Organization name"),
      "username": z.string().describe("Username to remove")
    }),
    options: z.object({})
  },
  "org team create": {
    description: "Create a team",
    args: z.object({ "org": z.string().describe("Organization name"), "name": z.string().describe("Team name") }),
    options: z.object({
      "description": z.string().describe("Team description").default(""),
      "permission": z.enum(["read", "write", "admin"]).describe("Default permission level").default("read")
    })
  },
  "org team delete": {
    description: "Delete a team",
    args: z.object({ "org": z.string().describe("Organization name"), "team": z.string().describe("Team slug") }),
    options: z.object({})
  },
  "org team edit": {
    description: "Update a team",
    args: z.object({ "org": z.string().describe("Organization name"), "team": z.string().describe("Team slug") }),
    options: z.object({
      "description": z.string().describe("New description").optional(),
      "name": z.string().describe("New team name").optional(),
      "permission": z.enum(["read", "write", "admin", ""]).describe("Default permission level").default("")
    })
  },
  "org team list": {
    description: "List teams in an organization",
    args: z.object({ "org": z.string().describe("Organization name") }),
    options: z.object({})
  },
  "org team member add": {
    description: "Add a user to a team",
    args: z.object({
      "org": z.string().describe("Organization name"),
      "team": z.string().describe("Team slug"),
      "username": z.string().describe("Username to add")
    }),
    options: z.object({})
  },
  "org team member list": {
    description: "List members in a team",
    args: z.object({ "org": z.string().describe("Organization name"), "team": z.string().describe("Team slug") }),
    options: z.object({})
  },
  "org team member remove": {
    description: "Remove a user from a team",
    args: z.object({
      "org": z.string().describe("Organization name"),
      "team": z.string().describe("Team slug"),
      "username": z.string().describe("Username to remove")
    }),
    options: z.object({})
  },
  "org team repo add": {
    description: "Grant a team access to a repository",
    args: z.object({
      "org": z.string().describe("Organization name"),
      "team": z.string().describe("Team slug"),
      "repo": z.string().describe("Repository in OWNER/REPO format")
    }),
    options: z.object({})
  },
  "org team repo list": {
    description: "List repositories assigned to a team",
    args: z.object({ "org": z.string().describe("Organization name"), "team": z.string().describe("Team slug") }),
    options: z.object({})
  },
  "org team repo remove": {
    description: "Remove a repository from a team",
    args: z.object({
      "org": z.string().describe("Organization name"),
      "team": z.string().describe("Team slug"),
      "repo": z.string().describe("Repository in OWNER/REPO format")
    }),
    options: z.object({})
  },
  "org team view": {
    description: "View team details",
    args: z.object({ "org": z.string().describe("Organization name"), "team": z.string().describe("Team slug") }),
    options: z.object({})
  },
  "org view": {
    description: "View organization details",
    args: z.object({ "name": z.string().describe("Organization name") }),
    options: z.object({})
  },
  "repo archive": {
    description: "Archive a repository",
    args: z.object({ "repo": z.string().describe("Repository in OWNER/REPO format") }),
    options: z.object({})
  },
  "repo clone": {
    description: "Clone a repository",
    args: z.object({
      "repo": z.string().describe("Repository in OWNER/REPO format or URL").optional(),
      "rest": z.array(z.string()).describe("Optional directory, then clone arguments after --").default([])
    }),
    options: z.object({
      "clone-arg": z.array(z.string()).describe("Extra arguments for clone").default([]),
      "directory": z.string().describe("Target directory").optional(),
      "protocol": z.enum(["ssh", "https", ""]).describe("Git protocol to use").default("")
    })
  },
  "repo connect": {
    description: "Connect this jj repository to a public GitHub repository",
    args: z.object({ "repo": z.string().describe("Repository in OWNER/REPO format") }),
    options: z.object({})
  },
  "repo create": {
    description: "Create a new repository",
    args: z.object({ "name": z.string().describe("Repository name") }),
    options: z.object({
      "description": z.string().describe("Repository description").default(""),
      "private": z.boolean().describe("Make repository private").default(false)
    })
  },
  "repo delete": {
    description: "Delete a repository",
    args: z.object({ "repo": z.string().describe("Repository in OWNER/REPO format") }),
    options: z.object({ "yes": z.boolean().describe("Confirm deleting the repository").default(false) })
  },
  "repo disconnect": {
    description: "Disconnect this repository from Smithers",
    args: z.object({}),
    options: z.object({})
  },
  "repo edit": {
    description: "Edit repository settings",
    args: z.object({ "repo": z.string().describe("Repository in OWNER/REPO format") }),
    options: z.object({
      "description": z.string().describe("New description").optional(),
      "name": z.string().describe("New repository name").optional(),
      "private": z.boolean().describe("Set visibility").optional()
    })
  },
  "repo fork": {
    description: "Fork a repository",
    args: z.object({ "repo": z.string().describe("Repository to fork in OWNER/REPO format") }),
    options: z.object({
      "name": z.string().describe("Name for the forked repository").optional(),
      "organization": z.string().describe("Organization to fork into").optional()
    })
  },
  "repo home": {
    description:
      "List remote homepage blocks in server order using the saved login; local smthrs flow list reads checkout flows",
    args: z.object({
      "repo": z.string().describe("Repository in OWNER/REPO format; detected when omitted").optional()
    }),
    options: z.object({ "repo": z.string().describe("Repository in OWNER/REPO format").optional() })
  },
  "repo list": {
    description: "List your repositories",
    args: z.object({}),
    options: z.object({
      "limit": z.coerce.number().describe("Results per page").default(30),
      "page": z.coerce.number().describe("Page number").default(1)
    })
  },
  "repo mirror-sync": {
    description: "Start a GitHub mirror sync run",
    args: z.object({}),
    options: z.object({ "repo": z.string().describe("Repository in OWNER/REPO format") })
  },
  "repo push": {
    description: "Push this checkout to your own ref on Smithers Cloud for a workspace to fetch",
    args: z.object({}),
    options: z.object({
      "delete": z.boolean().describe("Delete the ref instead").default(false),
      "list": z.boolean().describe("List your refs in this repository with their expiry instead").default(false),
      "name": z.string().describe("Ref name under refs/smithers/users/<your id>/").default("head"),
      "repo": z.string().describe("Repository (OWNER/REPO); detected from the remote when omitted").optional(),
      "working-copy": z.boolean().describe("jj: push @ with uncommitted edits instead of @-").default(false)
    })
  },
  "repo status": { description: "Show local repository connection status", args: z.object({}), options: z.object({}) },
  "repo report": {
    description:
      "Read the registration report another account recorded for a public repository at its current commit, without analysing it again; prints cached: false when there is none",
    args: z.object({ "repo": z.string().describe("Public GitHub repository in OWNER/REPO format") }),
    options: z.object({
      "workspace": z.string().describe("ID of one of your workspaces that answers the lookup")
    })
  },
  "repo transfer": {
    description: "Transfer repository ownership",
    args: z.object({ "repo": z.string().describe("Repository in OWNER/REPO format") }),
    options: z.object({ "to": z.string().describe("New owner (user or organization)") })
  },
  "repo unarchive": {
    description: "Unarchive a repository",
    args: z.object({ "repo": z.string().describe("Repository in OWNER/REPO format") }),
    options: z.object({})
  },
  "repo view": {
    description: "View repository details",
    args: z.object({ "repo": z.string().describe("Repository in OWNER/REPO format").optional() }),
    options: z.object({ "repo": z.string().describe("Repository in OWNER/REPO format").optional() })
  },
  "run cancel": {
    description: "Cancel a workflow run",
    args: z.object({ "id": z.coerce.number().describe("Run ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "run list": {
    description: "List workflow runs",
    args: z.object({}),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "run logs": {
    description: "Stream logs for a workflow run",
    args: z.object({ "id": z.coerce.number().describe("Run ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "run rerun": {
    description: "Rerun a workflow",
    args: z.object({ "id": z.coerce.number().describe("Run ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "run view": {
    description: "View a workflow run",
    args: z.object({ "id": z.coerce.number().describe("Run ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "run watch": {
    description: "Watch a workflow run in real-time (streams logs, status changes, and completion)",
    args: z.object({ "id": z.coerce.number().describe("Run ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "search code": {
    description: "Search code",
    args: z.object({ "query": z.string().describe("Search query") }),
    options: z.object({
      "limit": z.coerce.number().describe("Results per page").default(30),
      "page": z.coerce.number().describe("Page number").default(1)
    })
  },
  "search issues": {
    description: "Search issues",
    args: z.object({ "query": z.string().describe("Search query") }),
    options: z.object({
      "limit": z.coerce.number().describe("Results per page").default(30),
      "page": z.coerce.number().describe("Page number").default(1)
    })
  },
  "search repos": {
    description: "Search repositories",
    args: z.object({ "query": z.string().describe("Search query") }),
    options: z.object({
      "limit": z.coerce.number().describe("Results per page").default(30),
      "page": z.coerce.number().describe("Page number").default(1)
    })
  },
  "search users": {
    description: "Search users",
    args: z.object({ "query": z.string().describe("Search query") }),
    options: z.object({
      "limit": z.coerce.number().describe("Results per page").default(30),
      "page": z.coerce.number().describe("Page number").default(1)
    })
  },
  "secret bind": {
    description: "Set the hosts and headers a secret may be sent to; none unbinds it",
    args: z.object({ "name": z.string().describe("Secret name") }),
    options: z.object({
      "header": z.array(z.string()).describe("Request header the value goes in (repeatable)").default([]),
      "host": z.array(z.string()).describe("Host the secret may be sent to (repeatable)").default([]),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "secret delete": {
    description: "Delete a secret",
    args: z.object({ "name": z.string().describe("Secret name") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "secret list": {
    description: "List secrets",
    args: z.object({}),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "secret set": {
    description: "Set a secret",
    args: z.object({ "name": z.string().describe("Secret name") }),
    options: z.object({
      "body-stdin": z.boolean().describe("Read the secret value from stdin").default(false),
      "header": z.array(z.string()).describe("Request header the value goes in (repeatable, with --host)").default([]),
      "host": z.array(z.string()).describe("Host the secret may be sent to (repeatable, with --header)").default([]),
      "main-only": z.boolean().describe("Only trusted runs on the default bookmark receive it").default(false),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "secret scope": {
    description: "Limit a secret to trusted runs on the default bookmark, or give it to every run",
    args: z.object({
      "name": z.string().describe("Secret name"),
      "scope": z.enum(["main-only", "all"]).describe("main-only or all")
    }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "ssh-key add": {
    description: "Add an SSH key",
    args: z.object({}),
    options: z.object({ "title": z.string().describe("Key title"), "key": z.string().describe("Public key content") })
  },
  "ssh-key delete": {
    description: "Delete an SSH key",
    args: z.object({ "id": z.string().describe("Key ID") }),
    options: z.object({})
  },
  "ssh-key list": { description: "List SSH keys", args: z.object({}), options: z.object({}) },
  "stack land": {
    description: "Land approved stack PRs from the bottom and re-stack remaining changes",
    args: z.object({}),
    options: z.object({
      "all": z.boolean().describe("Land all consecutively approved+passing changes from the bottom").default(false),
      "change": z.string().describe("Land this change and everything below it").optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "target": z.string().describe("Target branch").default("main")
    })
  },
  "stack status": {
    description: "Show stack status with PR, review, and CI state",
    args: z.object({}),
    options: z.object({
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "target": z.string().describe("Target branch").default("main")
    })
  },
  "stack submit": {
    description: "Create or update linked GitHub pull requests from the local jj stack",
    args: z.object({}),
    options: z.object({
      "draft": z.boolean().describe("Create pull requests as drafts").default(false),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "target": z.string().describe("Target branch").default("main")
    })
  },
  "stack sync": {
    description: "Sync stack with merged PRs, rebase remaining changes, and refresh PR tables",
    args: z.object({}),
    options: z.object({
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "target": z.string().describe("Target branch").default("main")
    })
  },
  "stack unsubmit": {
    description: "Close stacked PRs, delete smithers remote branches, and remove stack mapping",
    args: z.object({}),
    options: z.object({
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "target": z.string().describe("Target branch").default("main")
    })
  },
  "status": { description: "Show working copy status", args: z.object({}), options: z.object({}) },
  "variable delete": {
    description: "Delete a variable",
    args: z.object({ "name": z.string().describe("Variable name") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "variable get": {
    description: "Get a variable value",
    args: z.object({ "name": z.string().describe("Variable name") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "variable list": {
    description: "List variables",
    args: z.object({}),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "variable set": {
    description: "Set a variable",
    args: z.object({ "name": z.string().describe("Variable name") }),
    options: z.object({
      "body": z.string().describe("Variable value"),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "webhook create": {
    description: "Create a webhook",
    args: z.object({}),
    options: z.object({
      "url": z.string().describe("Webhook payload URL"),
      "active": z.boolean().describe("Whether the webhook is active").default(true),
      "events": z.array(z.string()).describe("Events to trigger on").default([]),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "secret-stdin": z.boolean().describe("Read the webhook secret from stdin").default(false)
    })
  },
  "webhook delete": {
    description: "Delete a webhook",
    args: z.object({ "id": z.coerce.number().describe("Webhook ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "webhook deliveries": {
    description: "View delivery history for a webhook",
    args: z.object({ "id": z.coerce.number().describe("Webhook ID") }),
    options: z.object({
      "replay": z.string().describe("Delivery ID to replay").optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "webhook list": {
    description: "List webhooks",
    args: z.object({}),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "webhook update": {
    description: "Update a webhook",
    args: z.object({ "id": z.coerce.number().describe("Webhook ID") }),
    options: z.object({
      "active": z.boolean().describe("Whether the webhook is active").optional(),
      "events": z.array(z.string()).describe("Events to trigger on").default([]),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "secret-stdin": z.boolean().describe("Read the webhook secret from stdin").default(false),
      "url": z.string().describe("Webhook payload URL").optional()
    })
  },
  "webhook view": {
    description: "View webhook details and recent deliveries",
    args: z.object({ "id": z.coerce.number().describe("Webhook ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "wiki create": {
    description: "Create a wiki page",
    args: z.object({}),
    options: z.object({
      "title": z.string().describe("Page title"),
      "body": z.string().describe("Page content (Markdown)").default(""),
      "path": z.string().describe("Markdown path in the space (defaults to <slug>.md)").optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "slug": z.string().describe("Page slug (defaults to a slugified title)").optional(),
      "visibility": z.enum(["public", "private"]).describe("Wiki space: public (default) or private").optional()
    })
  },
  "wiki delete": {
    description: "Delete a wiki page",
    args: z.object({ "slug": z.string().describe("Wiki page slug") }),
    options: z.object({
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "visibility": z.enum(["public", "private"]).describe("Wiki space: public (default) or private").optional()
    })
  },
  "wiki edit": {
    description: "Edit a wiki page",
    args: z.object({ "slug": z.string().describe("Wiki page slug") }),
    options: z.object({
      "body": z.string().describe("New content (Markdown)").optional(),
      "expected-revision": z.coerce.number().describe(
        "The revision you read; a stale one is refused instead of overwritten"
      ).default(0),
      "path": z.string().describe("New Markdown path in the space").optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "slug": z.string().describe("New slug").optional(),
      "title": z.string().describe("New title").optional(),
      "visibility": z.enum(["public", "private"]).describe("Wiki space: public (default) or private").optional()
    })
  },
  "wiki history": {
    description: "List a wiki page's history by page id, renames and the deletion included",
    args: z.object({ "page-id": z.string().describe("Wiki page id") }),
    options: z.object({
      "limit": z.coerce.number().describe("Results per page").default(30),
      "page": z.coerce.number().describe("Page number").default(1),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "visibility": z.enum(["public", "private"]).describe("Wiki space: public (default) or private").optional()
    })
  },
  "wiki index": {
    description: "Show a space's navigation index: pages with tags and backlinks, folders, tags",
    args: z.object({}),
    options: z.object({
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "visibility": z.enum(["public", "private"]).describe("Wiki space: public (default) or private").optional()
    })
  },
  "wiki list": {
    description: "List wiki pages",
    args: z.object({}),
    options: z.object({
      "limit": z.coerce.number().describe("Results per page").default(30),
      "page": z.coerce.number().describe("Page number").default(1),
      "query": z.string().describe("Search titles, slugs, and body content").optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "visibility": z.enum(["public", "private"]).describe("Wiki space: public (default) or private").optional()
    })
  },
  "wiki revisions": {
    description: "List revisions for a wiki page",
    args: z.object({ "slug": z.string().describe("Wiki page slug") }),
    options: z.object({
      "limit": z.coerce.number().describe("Results per page").default(30),
      "page": z.coerce.number().describe("Page number").default(1),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "visibility": z.enum(["public", "private"]).describe("Wiki space: public (default) or private").optional()
    })
  },
  "wiki search": {
    description: "Search wiki pages by title, slug, and body content",
    args: z.object({}),
    options: z.object({
      "query": z.string().describe("Search query"),
      "limit": z.coerce.number().describe("Results per page").default(30),
      "page": z.coerce.number().describe("Page number").default(1),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "visibility": z.enum(["public", "private"]).describe("Wiki space: public (default) or private").optional()
    })
  },
  "wiki view": {
    description: "View a wiki page",
    args: z.object({ "slug": z.string().describe("Wiki page slug") }),
    options: z.object({
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "visibility": z.enum(["public", "private"]).describe("Wiki space: public (default) or private").optional()
    })
  },
  "workflow dispatch": {
    description: "Trigger a workflow",
    args: z.object({ "id": z.coerce.number().describe("Workflow ID") }),
    options: z.object({
      "input": z.array(z.string()).describe("Input key=value pairs (can be repeated)").default([]),
      "ref": z.string().describe("Git ref to run against").default("main"),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "workflow list": {
    description: "List workflows",
    args: z.object({}),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "workflow run": {
    description: "Run a workflow by name",
    args: z.object({ "workflow": z.string().describe("Workflow name") }),
    options: z.object({
      "input": z.array(z.string()).describe("Input key=value pairs (can be repeated)").default([]),
      "ref": z.string().describe("Git ref to run against").default("main"),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "workflow watch": {
    description: "Watch a workflow run in real-time",
    args: z.object({ "id": z.coerce.number().describe("Run ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "workspace children list": {
    description: "List a workspace's children",
    args: z.object({}),
    options: z.object({
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "workspace": z.string().describe("Parent workspace ID (this workspace when run inside one)").optional()
    })
  },
  "workspace children spawn": {
    description: "Spawn children of a running workspace",
    args: z.object({}),
    options: z.object({
      "count": z.coerce.number().describe("How many children").default(1),
      "profile": z.enum(["small", "build"]).describe("small (1 vCPU, 2 GB) or build (2 vCPU, 8 GB)").optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "ttl": z.coerce.number().describe("Seconds the children may live (plan default when omitted)").optional(),
      "workspace": z.string().describe("Parent workspace ID (this workspace when run inside one)").optional()
    })
  },
  "workspace children stop": {
    description: "Stop a workspace's child",
    args: z.object({ "child": z.string().describe("Child workspace ID") }),
    options: z.object({
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "workspace": z.string().describe("Parent workspace ID (this workspace when run inside one)").optional()
    })
  },
  "workspace cp": {
    description: "Copy files or directories between the local machine and a workspace",
    args: z.object({
      "src": z.string().describe("Local path or <workspace-id>:<path>"),
      "dst": z.string().describe("Local path or <workspace-id>:<path>")
    }),
    options: z.object({
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "timeout": z.coerce.number().describe("Transfer timeout in seconds").default(0),
      "user": z.string().describe("Guest user").default("developer")
    })
  },
  "workspace create": {
    description: "Create a workspace",
    args: z.object({}),
    options: z.object({
      "allow": z.array(z.string()).describe(
        "Hostname the workspace may reach (repeatable or comma-separated; implies --network allowlist)"
      ).default([]),
      "cpus": z.coerce.number().describe("vCPUs for the workspace").optional(),
      "disk": z.coerce.number().describe("Writable disk in MiB").optional(),
      "idleTimeout": z.coerce.number().describe("Seconds of inactivity before the workspace suspends (0 = never)")
        .optional(),
      "image": z.string().describe(
        "OCI image to boot instead of the default workspace image (e.g. docker.io/library/python:3.13-slim)"
      ).optional(),
      "kind": z.enum(["container", "vm", "desktop"]).describe(
        "Workspace kind: container (default), vm (the repository's Nix environment) or desktop"
      ).optional(),
      "memory": z.coerce.number().describe("Memory in MiB").optional(),
      "name": z.string().describe("Workspace name").default(""),
      "network": z.string().describe("Egress mode: proxy (default), allowlist, none").optional(),
      "ref": z.string().describe("Check out one of your pushed refs (smthrs repo push --name) instead of the bookmark")
        .optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "service": z.array(z.string()).describe("Network service NAME=COMMAND started inside the workspace (repeatable)")
        .default([]),
      "snapshot": z.string().describe("Snapshot ID to restore from").optional(),
      "wait": z.boolean().describe(
        "Wait until the workspace is running; exit non-zero with the failure code if provisioning fails"
      ).default(false),
      "waitTimeout": z.coerce.number().describe("Seconds to wait with --wait").default(600)
    })
  },
  "workspace delete": {
    description: "Delete a workspace",
    args: z.object({ "id": z.string().describe("Workspace ID") }),
    options: z.object({
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "yes": z.boolean().describe("Confirm deleting the workspace").default(false)
    })
  },
  "workspace exec": {
    description: "Run a workspace command with a durable receipt and bounded output",
    args: z.object({ "id": z.string().describe("Workspace ID (auto-detected if omitted)").optional() }),
    options: z.object({
      "command": z.string().describe("Remote command to run (multi-line allowed; runs under bash)"),
      "cwd": z.string().describe(
        "Working directory (default: workspace root)"
      ).optional(),
      "detach": z.boolean().describe("Return the receipt at once; the command keeps running (reattach with --exec-id)")
        .default(false),
      "env": z.array(z.string()).describe("KEY=VALUE exported to the command (repeatable)").default([]),
      "exec-id": z.string().describe("Durable command ID; reuse with the same command to reattach after a disconnect")
        .optional(),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "seedAgentAuth": z.string().describe(
        "Agent auth to seed before running the command (claude seeds ANTHROPIC_API_KEY; subscription logins stay on the workspace)"
      ).optional(),
      "timeout": z.coerce.number().describe("Cancel after this many seconds (default: 0; server guard: 60 minutes)")
        .optional()
    })
  },
  "workspace fork": {
    description: "Fork a workspace",
    args: z.object({ "id": z.string().describe("Workspace ID") }),
    options: z.object({
      "name": z.string().describe("Name for the forked workspace").default(""),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional()
    })
  },
  "workspace issue": {
    description: "Spin up a workspace for an issue, run Claude Code, then create a landing request",
    args: z.object({ "number": z.string().describe("Issue number to work on") }),
    options: z.object({
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "target": z.string().describe("Target bookmark for the landing request").default("main")
    })
  },
  "workspace list": {
    description: "List workspaces",
    args: z.object({}),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "workspace shell": {
    description: "Open an interactive terminal in a workspace via the WebSocket terminal endpoint",
    args: z.object({ "id": z.string().describe("Workspace ID (auto-detected if omitted)").optional() }),
    options: z.object({
      "cols": z.coerce.number().describe("Initial terminal columns (0 = detect)").default(0),
      "repo": z.string().describe("Repository (OWNER/REPO)").optional(),
      "rows": z.coerce.number().describe("Initial terminal rows (0 = detect)").default(0)
    })
  },
  "workspace snapshots": {
    description: "List workspace snapshots",
    args: z.object({ "id": z.string().describe("Workspace ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "workspace ssh": {
    description: "SSH into a workspace (creates one if none exists for the repo)",
    args: z.object({ "id": z.string().describe("Workspace ID (auto-detected if omitted)").optional() }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "workspace view": {
    description: "View workspace details (status, SSH info, persistence)",
    args: z.object({ "id": z.string().describe("Workspace ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  },
  "workspace watch": {
    description: "Watch a workspace for real-time status updates",
    args: z.object({ "id": z.string().describe("Workspace ID") }),
    options: z.object({ "repo": z.string().describe("Repository (OWNER/REPO)").optional() })
  }
} as const
