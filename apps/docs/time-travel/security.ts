/**
 * Security review of the site's own files: `security` reviews the diff against
 * origin/main, `securityAudit` audits every included file.
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
      threat: "Any reader of time-travel.smithers.sh copies a live provider key, GitHub token, or database URL from an example and uses the owner's account.",
      lookFor: [
        "A credential-shaped literal (ghp_, sk-, sk-ant-, AKIA, postgres:// or libsql:// with a password or authToken) in a fenced block that is not an obvious placeholder.",
        "A store or compensation handler example that reads a key from a literal instead of a Config or environment value."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-receipt-credential-guidance",
      title: "Compensation guidance never teaches storing credentials in unredacted receipts",
      threat: "A developer following a guide returns a token or connection string from revert, and anyone with read access to the audit rows reads it verbatim.",
      lookFor: [
        "A revert or rollback snippet whose returned receipt includes a token, header, connection string, or whole client object.",
        "A page that claims receipts or audit rows are redacted like journal payloads, contradicting compensate-an-effect.md."
      ],
      paths: ["src/content/docs/guides/compensate-an-effect.md", "src/content/docs/concepts/effect-tiers.md", "src/content/docs/concepts/rewind-protocol.md", "src/content/docs/reference/api.md"]
    },
    {
      id: "docs-rewind-safety-guidance",
      title: "Rewind and fork docs never teach bypassing ownership, liveness, or irreversibility refusals",
      threat: "A developer following a guide rewinds a run another process still owns or reverts an effect with no handler, corrupting another owner's run history or silently re-sending an external side effect.",
      lookFor: [
        "A snippet that retries busy, fence_lost, or live_child in a loop, supplies an always-true isAlive, or registers a no-op revert to silence irreversible.",
        "A fork example whose workspaceRoot or retainWorkspace guidance places the lane outside the repository or leaves retained workspaces with no stated cleanup owner.",
        "A reference to @smthrs/time-travel/internal/* imports presented as a supported way to skip the claim or audit steps.",
        "An example passing Ownership.sameHostPidProbe as isAlive without stating it is only valid when every owner runs on one host, so a multi-host deployment takes over a live run.",
        "A page that exposes rewind to other users' requests without a rateLimit, when the reference documents the default as no limiter."
      ],
      paths: ["src/content/docs/guides/**", "src/content/docs/concepts/**", "src/content/docs/reference/api.md", "src/content/docs/quickstart.md", "src/content/docs/troubleshooting.md", "src/content/docs/installation.md"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on time-travel.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an API token or state-store secret instead of the shared kit's environment reads."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    }
  ]
}
