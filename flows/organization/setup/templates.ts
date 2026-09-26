/** Files `init` writes beside an organization: the environment template and the one Slack app's manifest. */
import * as Subscriptions from "./subscriptions.ts"

/** Every seat an organization page names that runs a model: its seats and a judge other than `none`. */
export const modelSeats = (
  organization: { readonly seats: Readonly<Record<string, string>>; readonly judge: string }
) => [
  ...new Set([...Object.values(organization.seats), ...(organization.judge === "none" ? [] : [organization.judge])])
]

/** Slack bot scopes the one app asks for, matching the integrations Slack guide. */
export const slackBotScopes = [
  "app_mentions:read",
  "channels:history",
  "channels:join",
  "channels:manage",
  "channels:read",
  "chat:write",
  "chat:write.customize",
  "chat:write.public",
  "im:history",
  "im:read",
  "im:write",
  "reactions:read",
  "reactions:write",
  "users:read"
] as const

/** Slack bot events the app subscribes to. */
export const slackBotEvents = ["app_mention", "message.channels", "message.im"] as const

/** The scopes the team channel needs: find, create, join, and post in it under each role's name. */
export const teamChannelScopes = [
  "channels:history",
  "channels:join",
  "channels:manage",
  "channels:read",
  "chat:write",
  "chat:write.customize",
  "chat:write.public"
] as const

/** The scope the owner's acknowledgements need: 👀, then ✅ or ❌, on the owner's message. */
export const reactionScopes = ["reactions:write"] as const

/** Slack's app-manifest YAML for one Socket Mode app with the App Home messages tab open. */
export const slackManifest = (name: string): string => {
  if (!/^[\w .-]{1,35}$/.test(name)) {
    throw new Error("The Slack app name must be 1-35 letters, digits, spaces, dots or dashes")
  }
  return [
    "display_information:",
    `  name: ${name}`,
    "features:",
    "  app_home:",
    "    home_tab_enabled: false",
    "    messages_tab_enabled: true",
    "    messages_tab_read_only_enabled: false",
    "  bot_user:",
    `    display_name: ${name}`,
    "    always_online: true",
    "oauth_config:",
    "  scopes:",
    "    bot:",
    ...slackBotScopes.map((scope) => `      - ${scope}`),
    "settings:",
    "  event_subscriptions:",
    "    bot_events:",
    ...slackBotEvents.map((event) => `      - ${event}`),
    "  interactivity:",
    "    is_enabled: true",
    "  org_deploy_enabled: false",
    "  socket_mode_enabled: true",
    "  token_rotation_enabled: false",
    ""
  ].join("\n")
}

/** What `.env.example` is filled from. */
export interface EnvironmentInput {
  readonly root: string
  readonly stateDir: string
  readonly seats: ReadonlyArray<string>
  /** The repository names the roster grants its workspace roles. */
  readonly repositories: ReadonlyArray<string>
  readonly maxConcurrentVMs: number
}

/** The environment template: names only, every secret left empty. */
export const environmentExample = (input: EnvironmentInput): string => {
  const providers = new Set(input.seats.map(Subscriptions.providerOf))
  return [
    `# Model seats: ${input.seats.join(", ")}, on your subscriptions`,
    ...(providers.has("openai") ? ["# ChatGPT: sign in once with `codex login`"] : []),
    ...(providers.has("anthropic")
      ? ["# Claude: sign in to Claude Code (`claude`), or paste a `claude setup-token` token below"]
      : []),
    `${Subscriptions.modeVariable}=subscription`,
    ...(providers.has("anthropic") ? ["# CLAUDE_CODE_OAUTH_TOKEN="] : []),
    "",
    "# Slack: one app from slack-app-manifest.yaml",
    "SMITHERS_SLACK_BOT_TOKEN=",
    "SMITHERS_SLACK_APP_TOKEN=",
    "SMITHERS_SLACK_TEAM_IDS=",
    "SMITHERS_SLACK_USER_IDS=",
    "# SMITHERS_SLACK_CHANNEL_IDS=",
    "# SMITHERS_SLACK_TEAM_CHANNEL=smithers-team",
    "",
    "# Host",
    `SMITHERS_ORG_ROOT=${input.root}`,
    `# name=path${input.repositories.length === 0 ? "" : `; the roster grants ${input.repositories.join(", ")}`}`,
    "SMITHERS_ORG_REPOS=",
    `SMITHERS_ORG_STATE_DIR=${input.stateDir}`,
    `# SMITHERS_ORG_MAX_CONCURRENT_VMS=${input.maxConcurrentVMs}`,
    ""
  ].join("\n")
}
