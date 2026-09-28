/**
 * Security review: `security` reviews the diff against origin/main,
 * `securityAudit` audits the whole site.
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
      threat: "Any reader of journal.smithers.sh copies a live GitHub token, provider key, or database URL from an example and uses the owner's account.",
      lookFor: [
        "A credential-shaped literal (ghp_, sk-, sk-ant-, AKIA, postgres:// with a password) in a fenced block that is not an obvious placeholder like ghp_0123456789abcdef...",
        "An example run.created payload or log output that shows an unredacted real-looking secret where the text claims [REDACTED]."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-redaction-claims",
      title: "Redaction pages state exactly where scrubbing stops",
      threat: "A developer who trusts an overstated redaction claim persists API tokens in checkpoint state or unredacted fields, and anyone with database or log access reads them.",
      lookFor: [
        "A page that says credentials are scrubbed everywhere without noting that checkpoint and compaction state round-trips verbatim and is never redacted.",
        "A redaction or RedactedLogger guide that omits a channel the journal does not cover (spans, Console, Cause annotations) or claims coverage the concept page denies."
      ],
      paths: ["src/content/docs/concepts/redaction.md", "src/content/docs/concepts/compaction.md", "src/content/docs/guides/redact-log-output.md", "src/content/docs/guides/compact-a-run.md", "src/content/docs/index.md", "src/content/docs/quickstart.md"]
    },
    {
      id: "docs-owner-fence-guidance",
      title: "Owner-fence docs never teach bypassing the fence",
      threat: "A developer following a guide appends lifecycle events from a stale process that lost the run, corrupting another owner's run history.",
      lookFor: [
        "A snippet that retries a fence_lost failure, fabricates an owner token, or switches to the unfenced channel to make a write succeed.",
        "Text presenting the unfenced channel as the default for lifecycle writes rather than the narrow case the owner-fence page allows."
      ],
      paths: ["src/content/docs/concepts/owner-fence.md", "src/content/docs/guides/write-lifecycle-events.md", "src/content/docs/guides/compact-a-run.md", "src/content/docs/troubleshooting.md", "src/content/docs/installation.md"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on journal.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an account id, API token, or state-store secret instead of the shared kit's environment reads."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    }
  ]
}
