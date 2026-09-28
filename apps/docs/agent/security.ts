/**
 * Security review of the site's owned config and synced content. Content
 * findings are fixed upstream in packages/smithers/agent/docs, then resynced.
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
      threat: "Any reader of agent.smithers.sh copies a live provider API key, gateway key, or approval token and spends or impersonates the owner's account.",
      lookFor: [
        "A string literal shaped like a real key (sk-, sk-ant-, ghp_, xox, AKIA, long base64/hex) inside a fenced code block or table.",
        "A snippet that inlines a key value instead of reading it from a resolver or environment variable."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-unsafe-snippets",
      title: "Copyable snippets do not teach disabling a safety control",
      threat: "A user who copies a guide snippet runs agents with an always-yes judge, unbounded budget, or bypassed approval against their own repository and credentials.",
      lookFor: [
        "A snippet binding Evaluator.layerScripted or a seat resolver that answers yes to every question without the text calling it a disabled brake.",
        "A budget, quota, or capability example with no ceiling, or an approval/capability grant written as a wildcard, presented as the recommended default.",
        "A shell snippet piping a remote download into sh or passing a dangerous skip-permissions flag."
      ],
      paths: ["src/content/docs/guides/**", "src/content/docs/quickstart.md", "src/content/docs/installation.md"]
    },
    {
      id: "docs-content-markup",
      title: "Synced Markdown renders no active HTML and links only to project-owned origins",
      threat: "A contributor who edits packages/smithers/agent/docs runs script in every agent.smithers.sh visitor's browser, or sends readers to a look-alike domain or package to install malware.",
      lookFor: [
        "Raw HTML in a .md page: a <script>, <iframe>, <object>, inline on*= handler, or a javascript:/data: URL in a link or image.",
        "A link, editUrl, or install instruction pointing at a domain, GitHub org, or npm scope other than smithers.sh, github.com/smithersai, or @smthrs."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on agent.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an API token or state-store secret instead of the shared kit's environment reads."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    }
  ]
}
