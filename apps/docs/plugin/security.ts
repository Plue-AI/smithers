/**
 * Security review: `security` reviews the diff against origin/main,
 * `securityAudit` audits every owned file.
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
      title: "Published plugin docs and examples carry no real credentials",
      threat: "Any reader of plugin.smithers.sh copies a live provider key, endpoint token, or deploy credential and spends or impersonates the owner's account.",
      lookFor: [
        "A string literal shaped like a real key (sk-, sk-ant-, ghp_, xox, AKIA, long base64/hex) inside a fenced code block, config example, or table.",
        "A config or service-contribution snippet that inlines a credential or a non-example.test endpoint instead of reading it from a resolver or environment variable."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-plugin-isolation-claims",
      title: "The docs' plugin isolation claims match @smthrs/plugin behavior",
      threat: "A host author trusts a documented guarantee that plugin code cannot run during reflection or reach durable execution policy, and loads an untrusted plugin that then executes accessors or overrides retry, storage, or concurrency in the host.",
      lookFor: [
        "A claim that reflection is descriptor-only, accessors never execute, or config_invalid is refused without executing user code, that the source package's resolution code does not enforce.",
        "A contribute-services or host-your-own-hooks snippet that registers a plugin-supplied service over a host policy service while the prose says contributions cannot reach durable execution policy."
      ],
      paths: [
        "src/content/docs/index.md",
        "src/content/docs/troubleshooting.md",
        "src/content/docs/concepts/**",
        "src/content/docs/reference/api.md",
        "src/content/docs/guides/contribute-services.md",
        "src/content/docs/guides/host-your-own-hooks.md"
      ]
    },
    {
      id: "docs-raw-html",
      title: "Synced Markdown renders no active HTML on plugin.smithers.sh",
      threat: "A contributor who edits packages/smithers/agent/plugin/docs lands raw HTML that contentSync copies here and Astro renders verbatim, running script in every visitor's browser on plugin.smithers.sh.",
      lookFor: [
        "A <script>, <iframe>, <object>, <embed>, or <style> tag, or an on*= event attribute, in Markdown outside a fenced code block.",
        "A link or image whose target uses javascript:, data:, or vbscript:, or a frontmatter editUrl or link that leaves github.com/smithersai and *.smithers.sh."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on plugin.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an API token or state-store secret instead of the shared kit's environment reads."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    }
  ]
}
