/**
 * Security review of the site's own files. The content tree mirrors
 * @smthrs/model's docs, so checks focus on credential handling a reader
 * copies.
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
      title: "Published route and gateway examples carry no real credentials",
      threat: "Any reader of model.smithers.sh copies a live Anthropic, OpenAI, OpenRouter, Gemini, Cerebras, or AI Gateway key and spends the owner's provider credit.",
      lookFor: [
        "A Route.*, Auth.bearer, Auth.apiKeyHeader, or layerVercelGateway snippet whose apiKey or authToken is a literal shaped like a real key (sk-, sk-ant-, AIza, long hex/base64) instead of process.env or Config.Redacted.",
        "A Claude subscription authToken or oauth token value pasted into a guide or reference table."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-credential-handling-snippets",
      title: "Copyable snippets keep credentials redacted and sent only to the intended origin",
      threat: "A user who copies a guide snippet leaks their provider key into logs or sends it in cleartext or to a third-party baseUrl they did not intend.",
      lookFor: [
        "A snippet passing a raw string key where the API takes Redacted, or logging/printing a Route, Auth, or request headers.",
        "A baseUrl example using http:// for a non-localhost host, or a custom route example that forwards the provider key to a different origin than the one named.",
        "An Evaluator.layerScripted or always-yes answer shown as the production default without saying it disables the Jev brake."
      ],
      paths: ["src/content/docs/guides/**", "src/content/docs/quickstart.md", "src/content/docs/index.md", "src/content/docs/reference/api.md"]
    },
    {
      id: "docs-content-raw-html",
      title: "Synced Markdown pages render no raw script, iframe, or javascript: link",
      threat: "A contributor who edits @smthrs/model's colocated docs ships HTML that runs script in every model.smithers.sh visitor's browser, because Astro passes raw HTML in Markdown through to the page.",
      lookFor: [
        "A <script>, <iframe>, <object>, <embed>, or on*= event attribute inside a .md page outside a fenced code block.",
        "A link or image whose URL uses javascript:, data:text/html, or an http:// origin."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on model.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an API token or state-store secret instead of the shared kit's environment reads."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    }
  ]
}
