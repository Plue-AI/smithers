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
      title: "No webhook delivery is decoded or routed before its signature verifies",
      threat:
        "An unauthenticated internet caller forges or replays a signed webhook delivery that starts a flow or signals a run in the operator's control plane.",
      lookFor: [
        "A digest, hash, or token compared with ===, startsWith, or an early-return loop instead of constantTimeEqual or timingSafeEqualHex.",
        "A verify path that parses or reads the body before the HMAC over the exact raw bytes passes.",
        "A verifier throw, empty secret, or missing header that resolves to success instead of Unauthorized.",
        "An idempotency or dedupe key built from attacker-chosen fields alone, so a replay with a new key is processed twice."
      ],
      paths: [
        "src/core/Signature.ts",
        "src/core/Channel.ts",
        "src/github/Payload.ts"
      ]
    },
    {
      id: "token-egress",
      title: "Provider tokens reach only the configured API origin and never logs, errors, or spans",
      threat:
        "A malicious API response, pagination link, redirect, or misconfigured base URL sends the operator's GitHub token to a third-party host, or an error message leaks it into run journals.",
      lookFor: [
        "A fetch with a bearer token and no redirect: \"manual\" whose target can come from a response (Link rel=next, absolute path) without an origin check.",
        "An apiBaseUrl accepted with a non-http(s) scheme, or taken from an env var or connection record without validation.",
        "An IntegrationError summary, details map, or cause built from a response body or URL without passing through redact or RedactedError."
      ],
      paths: [
        "src/github/GitHubClient.ts",
        "src/core/Redact.ts",
        "src/core/RedactedError.ts",
        "src/core/AccessToken.ts"
      ]
    },
    {
      id: "request-path-injection",
      title: "Caller- or payload-supplied ids cannot rewrite the provider API path",
      threat:
        "A webhook payload or agent tool call with an owner, repo, or issue id like '..' or '%2F' makes the client call a different API endpoint with the operator's token.",
      lookFor: [
        "A path segment built with template interpolation and no encodeURIComponent, or encoded but still able to be '.' or '..' (see github/Repository.ts).",
        "A query value or GraphQL variable concatenated into a query string instead of passed as a variable."
      ],
      paths: [
        "src/github/Repository.ts",
        "src/github/Actions.ts",
        "src/core/IssueSync.ts"
      ]
    },
    {
      id: "connection-authz",
      title: "A connection's credential resolves only for an authorized principal and only on its granted containers",
      threat:
        "One principal in a shared host uses another person's connection or accesses a container the connection never granted.",
      lookFor: [
        "A client built from a Connection that reads the token without resolveSecret, so access.authorize is never asked.",
        "An empty containers list treated as allow-all, or a container scope omitted when a client is built from a connection.",
        "A per-call container id checked against the allowlist before trimming or case-folding while the request uses the raw value.",
        "A connection-scoped layer that falls back to ambientEnvironment() tokens when the connection's credential fails to resolve."
      ],
      paths: [
        "src/core/Connection.ts",
        "src/Environment.ts",
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
        "An agent run granted one integration container reads messages from another container, or reads text the user revoked.",
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
        "src/core/Sync.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
