import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  testProgram: Smithers.file("//packages/smithers/flows/database/scripts/test-matrix.mjs"),
  deps: [],
  cwd: "packages/smithers/agent/integrations"
})

const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/agent/integrations",
  include: ["src/**"],
  checks: [
    {
      id: "webhook-verification",
      title: "No webhook delivery is decoded or routed before its signature and freshness verify",
      threat:
        "An unauthenticated internet caller forges or replays a Slack, Linear, or GitHub delivery that starts a flow or signals a run in the operator's control plane.",
      lookFor: [
        "A digest, hash, or token compared with ===, startsWith, or an early-return loop instead of constantTimeEqual or timingSafeEqualHex.",
        "A verify path that parses or reads the body, or answers a Slack url_verification challenge, before the HMAC over the exact raw bytes passes.",
        "A replay window that accepts Infinity, NaN, a negative, or a caller value above MAX_TIMESTAMP_SKEW_MS, or a timestamp read from an unsigned field.",
        "A verifier throw, empty secret, or missing header that resolves to success instead of Unauthorized.",
        "An idempotency or dedupe key built from attacker-chosen fields alone, so a replay with a new key is processed twice."
      ],
      paths: [
        "src/core/Signature.ts",
        "src/core/Channel.ts",
        "src/slack/Webhook.ts",
        "src/linear/Webhook.ts",
        "src/github/Payload.ts"
      ]
    },
    {
      id: "telegram-initdata",
      title: "Telegram Mini App initData is trusted only after HMAC or Ed25519 verification and an age check",
      threat:
        "A Mini App user forges initData to impersonate another Telegram user or replays an old initData to act as them in the operator's backend.",
      lookFor: [
        "A data-check string built from decoded-then-split input, unsorted keys, or with hash or signature handled differently than Telegram documents.",
        "maxAgeSeconds or future skew bounds that can be disabled by an out-of-range option instead of throwing.",
        "A user, receiver, or chat field returned from parse() and used without a successful verify call."
      ],
      paths: ["src/telegram/InitData.ts"]
    },
    {
      id: "approval-presser-authz",
      title: "Only an allowlisted presser on this prompt's token resolves an approval",
      threat:
        "Any member of a Slack or Telegram chat approves or rejects a gated agent action they were never allowed to decide.",
      lookFor: [
        "A decision path that treats an empty or missing allowedUserIds or allowedChatIds as allow-all.",
        "A press whose token is absent, empty, or from another prompt that still resolves, including as a rejection.",
        "A select-mode key accepted that the prompt never offered, or callback data with extra segments parsed as a valid choice.",
        "Authorization read from callback_data or message text instead of the presser's from.id or user.id."
      ],
      paths: ["src/telegram/Approval.ts", "src/slack/Approval.ts", "src/slack/Payload.ts"]
    },
    {
      id: "inbound-allowlist",
      title: "Inbound Slack, Telegram, and X messages from outside the configured allowlists never reach an agent",
      threat:
        "A stranger in another Slack workspace, an unlisted chat, or the bot itself injects instructions into an agent run by messaging the integration.",
      lookFor: [
        "A source or decoder that starts with an empty allowedTeamIds, allowedChannelIds, allowedUserIds, or allowedChatIds and admits everything.",
        "A policy checked in Webhook.answer but not again in the channel decoder or SocketSource, so another ingress bypasses it.",
        "Bot or self-authored messages (bot_id, the app's own user id) admitted, creating a self-triggering loop.",
        "Telegram updates filtered on a chat id taken from a field other than the delivered message or callback chat."
      ],
      paths: [
        "src/slack/Payload.ts",
        "src/slack/SocketSource.ts",
        "src/slack/Sync.ts",
        "src/slack/IssueSync.ts",
        "src/telegram/Source.ts",
        "src/telegram/IssueSync.ts",
        "src/x/Sync.ts"
      ]
    },
    {
      id: "token-egress",
      title: "Provider tokens reach only the configured API origin and never logs, errors, or spans",
      threat:
        "A malicious API response, pagination link, redirect, or misconfigured base URL sends the operator's GitHub, Slack, Google, Linear, X, or Telegram token to a third-party host, or an error message leaks it into run journals.",
      lookFor: [
        "A fetch with a bearer token and no redirect: \"manual\" whose target can come from a response (Link rel=next, absolute path) without an origin check.",
        "An apiBaseUrl accepted with a non-http(s) scheme, or taken from an env var or connection record without validation.",
        "A Telegram bot token embedded in a URL that can appear in an error, trace attribute, or url.full span field unredacted.",
        "An IntegrationError summary, details map, or cause built from a response body or URL without passing through redact or RedactedError."
      ],
      paths: [
        "src/github/GitHubClient.ts",
        "src/gmail/GmailClient.ts",
        "src/googlecalendar/CalendarClient.ts",
        "src/linear/LinearClient.ts",
        "src/slack/SlackClient.ts",
        "src/slack/Connections.ts",
        "src/telegram/TelegramClient.ts",
        "src/x/XClient.ts",
        "src/core/Redact.ts",
        "src/core/RedactedError.ts",
        "src/core/AccessToken.ts"
      ]
    },
    {
      id: "request-path-injection",
      title: "Caller- or payload-supplied ids cannot rewrite the provider API path",
      threat:
        "A webhook payload or agent tool call with an owner, repo, calendar, event, method, or mailbox id like '..' or '%2F' makes the client call a different API endpoint with the operator's token.",
      lookFor: [
        "A path segment built with template interpolation and no encodeURIComponent, or encoded but still able to be '.' or '..' (see github/Repository.ts).",
        "A Slack method name or Telegram method interpolated into the URL without the allowed-name pattern check.",
        "A query value or GraphQL variable concatenated into a query string instead of passed as a variable."
      ],
      paths: [
        "src/github/Repository.ts",
        "src/github/Actions.ts",
        "src/googlecalendar/EventId.ts",
        "src/googlecalendar/Actions.ts",
        "src/slack/SlackClient.ts",
        "src/linear/LinearClient.ts",
        "src/core/IssueSync.ts"
      ]
    },
    {
      id: "connection-authz",
      title: "A connection's credential resolves only for an authorized principal and only on its granted containers",
      threat:
        "One principal in a shared host uses another person's personal Slack or Google Calendar connection, or posts to a channel or calendar the connection never granted.",
      lookFor: [
        "A client built from a Connection that reads the token without resolveSecret, so access.authorize is never asked.",
        "An empty containers list treated as allow-all, or allowedCalendars left undefined when the client is built from a connection.",
        "A per-call channel or calendar id checked against the allowlist before trimming or case-folding while the request uses the raw value.",
        "A connection-scoped layer that falls back to ambientEnvironment() tokens when the connection's credential fails to resolve."
      ],
      paths: [
        "src/core/Connection.ts",
        "src/Environment.ts",
        "src/slack/Connections.ts",
        "src/googlecalendar/CalendarClient.ts",
        "src/*/Config.ts"
      ]
    },
    {
      id: "oauth-flow",
      title: "OAuth authorization and token exchange keep PKCE, state, and client secrets intact",
      threat:
        "An attacker who intercepts a redirect or controls a token endpoint response steals an authorization code, a refresh token, or the operator's client secret.",
      lookFor: [
        "extraParams able to override state, redirect_uri, code_challenge, or code_challenge_method.",
        "A code_verifier drawn from Math.random or fewer than 32 random bytes, or a plain challenge method used by default.",
        "A token endpoint request that follows redirects, or accepts a non-https tokenUrl for a non-loopback host.",
        "A token response body echoed into an error without stripping access_token, refresh_token, or client_secret."
      ],
      paths: ["src/core/Pkce.ts", "src/core/AuthorizationUrl.ts", "src/core/OAuthToken.ts", "src/core/AccessToken.ts"]
    },
    {
      id: "source-store-grants",
      title: "Stored integration records are returned only inside the caller's grants and never after revocation",
      threat:
        "An agent run granted one Slack channel or mailbox label reads messages from another container, or reads text the user revoked.",
      lookFor: [
        "A retrieve, validate, or get path that omits the grant clause, or treats an empty containers list as the wildcard.",
        "A record whose access_container_id and thread_container_id are both NULL admitted under a container-scoped grant.",
        "A revoke that leaves text, url, author, or payload_json populated, or a container id of '*' accepted by revokeContainer or reinstate.",
        "SQL built with sql.literal or string concatenation from a query, kind, or id instead of a bound parameter."
      ],
      paths: [
        "src/core/SourceStore.ts",
        "src/core/SourceRecord.ts",
        "src/core/CursorStore.ts",
        "src/core/Sync.ts",
        "src/gmail/Records.ts",
        "src/x/Records.ts"
      ]
    },
    {
      id: "outbound-message-injection",
      title: "Agent-written outbound messages cannot add recipients or smuggle markup",
      threat:
        "A prompt-injected agent run adds a Bcc to an email, mentions @channel, or formats a Telegram message that spoofs an approval prompt, reaching people the operator never approved.",
      lookFor: [
        "A Gmail header value (subject, display name, address, References) that can carry CR, LF, or other control characters into the raw message.",
        "A display name quoted without escaping backslash and double quote, or an address that is not the plain local@domain form.",
        "Telegram MarkdownV2 or HTML text sent without escaping every reserved character, or a chunk split that breaks an escape sequence.",
        "Slack text sent with link_names or unescaped <!channel>/<!here> from agent-authored content."
      ],
      paths: [
        "src/gmail/Mime.ts",
        "src/gmail/Actions.ts",
        "src/telegram/Markdown.ts",
        "src/telegram/Chunk.ts",
        "src/telegram/Actions.ts",
        "src/slack/Actions.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
