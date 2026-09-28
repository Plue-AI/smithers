/**
 * Security review of the site's owned config and synced content. Content
 * findings are fixed upstream in packages/smithers/flows/platform-bun/docs,
 * then resynced.
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
      threat: "Any reader of platform-bun.smithers.sh copies a live API key, token, or password from a snippet and uses the owner's account.",
      lookFor: [
        "A string literal shaped like a real key (sk-, ghp_, AKIA, long base64/hex) inside a fenced code block or table.",
        "An argv example such as curl -u, mysql -p, or --token carrying a value that is not an obvious placeholder like hunter2."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-containment-guidance",
      title: "Host composition snippets keep the capability and containment controls on",
      threat: "A user who copies a guide snippet ships a host whose HTTP slot follows redirects past the capability kernel, whose filesystem helper resolves from PATH, or whose children escape the ledger, exposing their machine and repository.",
      lookFor: [
        "A snippet hand-composing the five host slots or an HttpClient without redirect: \"manual\", presented as equivalent to BunHost.layer.",
        "A Layer.merge example that puts the BunFileSystem override first, so the default helper silently wins.",
        "Text claiming smithers-jj-export is found on PATH, or an executable or SMITHERS_WORKSPACE_JJ_EXPORT_BINARY example that is a relative path or a user-writable directory.",
        "Guidance to pass credentials in argv to a contained child, or to use ProcessLedger.layerMemory for a long-lived production host."
      ],
      paths: [
        "src/content/docs/guides/**",
        "src/content/docs/concepts/**",
        "src/content/docs/reference/**",
        "src/content/docs/index.md",
        "src/content/docs/installation.md",
        "src/content/docs/quickstart.md",
        "src/content/docs/troubleshooting.md"
      ]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on platform-bun.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an API token or state-store secret instead of the shared kit's environment reads."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    }
  ]
}
