/**
 * Security review: `security` reviews the diff against origin/main and
 * `securityAudit` audits every included file. The content tree is synced from
 * packages/smithers/agent/scorers/docs, so fixes land there, not here.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "public/**", "astro.config.mjs", "alchemy.run.ts", "package.json", "tsconfig.json"],
  checks: [
    {
      id: "docs-example-secrets",
      title: "Published docs and examples carry no real credentials",
      threat: "Any reader of scorers.smithers.sh copies a live judge-model API key, gateway key, or database URL with embedded credentials and spends or reads the owner's accounts.",
      lookFor: [
        "A string literal shaped like a real key (sk-, sk-ant-, ghp_, xox, AKIA, JWT, long base64/hex) inside a fenced code block or table.",
        "A judge-scorer or SqlScoreStore snippet that inlines a key or a user:password@host URL instead of reading it from a resolver or environment variable."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-redaction-claims",
      title: "Docs describe score redaction as best effort and never promise it as a guarantee",
      threat: "A user who trusts an overstated redaction claim writes credentials or private agent output into score reason or meta, which persist unpruned in flows_scores and print in CI gate summaries.",
      lookFor: [
        "Text stating that reason or meta scrubbing guarantees no secret is stored, without pointing values that must never persist to a Redacted field.",
        "A guide example that puts a request, header, token, or raw judge transcript into reason or meta."
      ],
      paths: ["src/content/docs/durability.md", "src/content/docs/guides/**", "src/content/docs/concepts/observations.md"]
    },
    {
      id: "docs-unsafe-snippets",
      title: "Copyable scorer snippets do not teach disabling a safety control",
      threat: "A user who copies a guide snippet ships a gate that always passes, or a judge scorer that feeds untrusted agent output to a model with tools, against their own repository and CI.",
      lookFor: [
        "A snippet that binds ScoreStore.layerNoop or a constant-pass scorer as the recommended production composition without calling it a test or disabled gate.",
        "A judge example that interpolates agent output into instructions without delimiting it as data, or grants the judge tools or write capabilities.",
        "A shell snippet piping a remote download into sh or passing a dangerous skip-permissions flag."
      ],
      paths: ["src/content/docs/guides/**", "src/content/docs/quickstart.md", "src/content/docs/installation.md"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on scorers.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an API token or state-store secret instead of the shared kit's environment reads."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    }
  ]
}
