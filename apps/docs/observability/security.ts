/**
 * Security review of the site's config, deploy stack, and synced content.
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
      title: "Published docs and examples carry no real collector or vendor credentials",
      threat: "Any reader of observability.smithers.sh copies a live OTLP vendor token or collector credential and exports to, or reads from, the owner's telemetry account.",
      lookFor: [
        "A headers example whose authorization value is a real-looking token instead of the YOUR_TOKEN placeholder.",
        "A baseUrl or endpoint example naming a real internal collector host or tenant path instead of localhost, collector, or example.com."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-telemetry-credential-guidance",
      title: "Export guides keep tokens out of URLs, plaintext remote hosts, and printed payloads",
      threat: "A user who follows a guide sends a vendor bearer token over plain http to a remote collector, or prints telemetry bodies carrying secrets and prompts into shared logs.",
      lookFor: [
        "A snippet pairing an authorization header with an http:// endpoint that is not localhost or a test host.",
        "A snippet that inlines a token string instead of reading it from process.env or a secret store.",
        "A doc claim that credentials in the URL, redaction before journal admission, or header handling behave differently from //packages/smithers/flows/observability/src.",
        "A quickstart or testing snippet that logs whole request bodies or headers rather than top-level keys."
      ],
      paths: ["src/content/docs/quickstart.md", "src/content/docs/guides/**", "src/content/docs/concepts/validated-acquisition.md", "src/content/docs/troubleshooting.md", "src/content/docs/reference/api.md"]
    },
    {
      id: "docs-content-raw-html",
      title: "Synced markdown renders no raw script, iframe, event handler, or javascript: link",
      threat: "A contributor to the upstream observability docs injects script that runs in every visitor's browser on observability.smithers.sh, because Starlight passes raw HTML in markdown through.",
      lookFor: [
        "A <script>, <iframe>, <object>, <embed>, or <style> element in a markdown file.",
        "An inline on*= event handler attribute or a javascript: or data: URL in a link or image."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on observability.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an API token or state-store secret instead of the shared kit's environment reads."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    }
  ]
}
