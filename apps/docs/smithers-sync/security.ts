/**
 * Security review of the site's own files. Content under src/content/docs is
 * stitched from packages/smithers/flows/sync/docs; its reviewer owns the
 * wording at the source, this one owns what ships and what users copy.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "public/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "auth-guide-matches-code",
      title: "The authorization pages describe the capability checks the sync source actually performs",
      threat: "An operator following the guide deploys a sync read path that admits unsigned, expired, or over-scoped capabilities to another workspace's runs.",
      lookFor: [
        "A claim in authorize-a-connection.md or authorization.md (constant-time verify, no default secret, kid signed, expiry enforced, layerNoop fails closed) that //packages/smithers/flows/sync/src/WorkspaceShare.ts or SyncAuth.ts does not implement.",
        "A branches.md claim about branch capabilities (scope, expiry, kid, refusal) that //packages/smithers/flows/sync/src/BranchShare.ts does not enforce.",
        "A troubleshooting row that tells the reader to widen access, drop the capability, or switch to layerNoop-as-open to clear an unauthorized refusal."
      ],
      paths: [
        "src/content/docs/guides/authorize-a-connection.md",
        "src/content/docs/concepts/authorization.md",
        "src/content/docs/concepts/branches.md",
        "src/content/docs/troubleshooting.md"
      ]
    },
    {
      id: "copyable-snippet-secrets",
      title: "Code snippets users copy carry no real or reusable signing secret and never move a capability into a URL or log",
      threat: "A reader pastes a snippet into production and ships a guessable HMAC secret or leaks a workspace capability through a query string or log line, letting anyone read that workspace's runs.",
      lookFor: [
        "A literal secret passed to Redacted.make or a keyring outside a snippet explicitly labeled as a test fixture (test-a-follower.md uses \"test-secret\").",
        "A snippet that puts a capability or its encoded header value in a URL query, a console/log call, or a span attribute.",
        "A snippet that reads a secret with a non-null assertion and no stated failure when the variable is unset."
      ],
      paths: ["src/content/docs/**/*.md"]
    },
    {
      id: "static-site-deploy-surface",
      title: "The published site and its deploy stack ship only public assets and link only first-party hosts",
      threat: "A deploy of smithers-sync.smithers.sh publishes a secret or credential-bearing file, or a doc link sends readers to an attacker-controlled host.",
      lookFor: [
        "A file under public/ or src/ holding a token, key, .env content, or internal hostname.",
        "An alchemy.run.ts or astro.config.mjs change that adds bindings, env, or routes beyond makeDocsSiteStack/defineDocsSite with the site slug.",
        "An absolute link or editUrl whose host is not smithers.sh, a *.smithers.sh subdomain, github.com/smithersai, or effect.website."
      ],
      paths: ["public/**", "src/**", "astro.config.mjs", "alchemy.run.ts", "package.json"]
    }
  ]
}
