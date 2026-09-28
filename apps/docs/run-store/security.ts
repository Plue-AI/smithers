/**
 * Security review of the site's copyable guidance and its deploy entry points.
 * `security` reviews the diff against origin/main; `securityAudit` audits
 * every file.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "alchemy.run.ts", "astro.config.mjs", "package.json"],
  checks: [
    {
      id: "run-file-secret-guidance",
      title: "Docs never tell readers to persist a resolved credential in run state or attempt outcomes",
      threat: "A reader who copies a snippet stores API keys in cleartext in flows_runs.state_json or flows_attempts.outcome_json, where anyone with the .db file reads them.",
      lookFor: [
        "A snippet putting a credential field in a payload, state, or action success schema without Schema.Redacted disallowJsonEncode or a secretRef.",
        "Text claiming the store or journal redacts run values, contradicting 'Nothing is redacted' in concepts/durable-values.md.",
        "A literal key, token, or password value (not a placeholder) in any example."
      ],
      paths: ["src/content/docs/**/*.md"]
    },
    {
      id: "fencing-snippet-safety",
      title: "Copyable claim and recovery snippets check the fence result before acting",
      threat: "A reader who copies an example runs a side effect after losing the claim or lease, so two processes mutate the same run's external state.",
      lookFor: [
        "A snippet that calls activate, heartbeat, or a transition and proceeds without branching on its _tag (Activated, Transitioned, Claimed).",
        "A recovery example that reclaims a run without the observer identity and liveness evidence the guide requires."
      ],
      paths: [
        "src/content/docs/quickstart.md",
        "src/content/docs/index.md",
        "src/content/docs/guides/**",
        "src/content/docs/concepts/fencing.md",
        "src/content/docs/concepts/leases.md"
      ]
    },
    {
      id: "published-page-content",
      title: "Rendered pages load no script, frame, or remote style outside the Smithers site and repo",
      threat: "A contributor who edits synced docs or site styles runs script or phishing links on run-store.smithers.sh for every reader.",
      lookFor: [
        "Raw HTML in a .md page: <script>, <iframe>, an on* event attribute, or a javascript: URL.",
        "An editUrl or link whose host is not github.com/smithersai/smithers or a *.smithers.sh domain.",
        "An @import or url() in src/styles that loads from a remote origin."
      ],
      paths: ["src/content/docs/**", "src/styles/**", "src/content.config.ts"]
    },
    {
      id: "docs-deploy-config",
      title: "Deploy entry points carry no credentials and target only the run-store site",
      threat: "Anyone reading the public repo takes a Cloudflare token or account id from the site config, or a changed slug deploys over another package's docs domain.",
      lookFor: [
        "A token, account id, or state-store secret literal in alchemy.run.ts, astro.config.mjs, or package.json.",
        "A slug other than run-store passed to makeDocsSiteStack or defineDocsSite.",
        "A deploy or destroy script that runs without --stage prod, or a new lifecycle script (postinstall, prepare) that executes on install."
      ],
      paths: ["alchemy.run.ts", "astro.config.mjs", "package.json"]
    }
  ]
}
