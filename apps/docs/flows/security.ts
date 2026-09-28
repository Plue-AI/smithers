/**
 * Security review of the site's own files: the copyable snippets readers run
 * against their repositories and credentials, and the site and deploy config.
 * `security` reviews the diff against origin/main; `securityAudit` audits all
 * of it.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "docs-example-secrets",
      title: "Published docs and examples carry no real credentials",
      threat: "Any reader of flows.smithers.sh copies a live provider key, sandbox credential, or host token and spends or impersonates the owner's account.",
      lookFor: [
        "A string literal shaped like a real key (sk-, sk-ant-, ghp_, AKIA, long base64/hex) inside a fenced code block or table.",
        "A sandbox or host snippet that inlines a credential value instead of reading it from a resolver or environment variable."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-capability-grants",
      title: "Copyable capability rules and sandbox options stay narrowly scoped",
      threat: "A user who copies a quickstart or troubleshooting snippet grants every flow action broad filesystem, process, or network authority on their own machine and repository.",
      lookFor: [
        "A Capability.Permission.Rule example with effect allow whose action or resource pattern is a wildcard (*, **, /) instead of the workspace path the text names.",
        "Troubleshooting fixes for PermissionAsked or PermissionDenied that tell the reader to add an allow-all rule or drop the first ruleset's deny veto.",
        "A SandboxedFlow example that disables nonce checking, secret redaction, or workspace isolation, or claims redaction is a guarantee (the guide says it is best effort)."
      ],
      paths: ["src/content/docs/quickstart.md", "src/content/docs/troubleshooting.md", "src/content/docs/guides/**", "src/content/docs/concepts/**"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on flows.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an API token or state-store secret instead of the shared kit's environment reads."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    },
    {
      id: "docs-security-claims",
      title: "Every security guarantee the docs state matches what @smthrs/flows enforces",
      threat: "An integrator who trusts a stated guarantee (unmatched capability denied, cross-ruleset deny veto, sandbox nonce check, bounded redacted tails) exposes their host, repository, or credentials to a flow the code does not actually stop.",
      lookFor: [
        "A claim that the unattended layerHost grant store denies any capability no rule allows, or that a later ruleset's allow cannot lift an earlier deny, that the capability and runtime sources contradict.",
        "A sandbox guide claim that the host accepts only the current attempt nonce, discards stale result files, or redacts guest stdout/stderr before retaining it, that the sandbox source does not implement.",
        "A security claim stated as absolute (guarantee, always, never leaks) where the source is best effort; report it against packages/smithers/flows docs, since src/content/docs is synced from there."
      ],
      paths: [
        "src/content/docs/quickstart.md",
        "src/content/docs/troubleshooting.md",
        "src/content/docs/reference/api.md",
        "src/content/docs/guides/run-a-child-flow-in-a-sandbox.md",
        "src/content/docs/guides/stand-up-a-node-runtime.md"
      ]
    }
  ]
}
