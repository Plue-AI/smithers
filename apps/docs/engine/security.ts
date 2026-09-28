/**
 * Security review of the site's own sources: the synced content pages users
 * copy serving and tenancy snippets from, the Starlight config, and the
 * Alchemy deploy stack.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "docs-serving-guidance",
      title: "Serving and tenancy guides never present an unauthenticated or client-namespaced server as safe",
      threat: "A reader who copies a FlowProxyServer snippet exposes execute, discard, and resume to any caller, or lets one tenant resume another tenant's run.",
      lookFor: [
        "A serve-flows example that mounts layerRpcHandlers or layerHttpApi without stating the modules ship no authentication policy.",
        "An ExecutionIdScope example that derives the namespace from a client-supplied payload field or skips resume.",
        "Text claiming returning undefined from the scope on resume passes the client id through instead of refusing."
      ],
      paths: ["src/content/docs/guides/serve-flows.md", "src/content/docs/guides/namespace-execution-ids.md", "src/content/docs/concepts/execution-identity.md"]
    },
    {
      id: "docs-snippet-safety",
      title: "Published code snippets carry no live credentials and no unsafe patterns readers copy",
      threat: "A reader who copies a snippet from engine.smithers.sh leaks a real key or ships an unsafe retry of an irreversible action.",
      lookFor: [
        "A token, API key, bearer header, or private URL with a real-looking value in a fenced code block.",
        "A retry or compensable-action example that retries an irreversible action without the declaration the engine requires.",
        "A `curl ... | sh` or similar pipe-to-shell install line.",
        "Raw `<script>`, `<iframe>`, inline event handler, or `javascript:` URL in a content page, which Astro renders unescaped into every reader's browser."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-link-integrity",
      title: "Every outbound link and editUrl points at a Smithers-owned https origin",
      threat: "An attacker who controls a typo or lapsed domain linked from the docs serves malware or phishing to readers.",
      lookFor: [
        "An `http://` link or an href to a domain other than smithers.sh subdomains, github.com/smithersai, or a named upstream project.",
        "An `editUrl` frontmatter value outside https://github.com/smithersai/smithers/."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-deploy-scope",
      title: "The site config and deploy stack publish only the static build under the engine slug",
      threat: "A change to the generated config lets a deploy publish unintended files or bind the site to another subdomain or Worker.",
      lookFor: [
        "A `slug`, `sourceDir`, or `contentDir` that differs from `engine` and `packages/smithers/flows/engine`.",
        "An option passed to `makeDocsSiteStack` in alchemy.run.ts beyond `slug: \"engine\"`, such as a custom domain, Worker name, or asset directory.",
        "A new script in package.json or astro.config.mjs that runs shell commands, reads env secrets, or injects raw HTML."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json"]
    }
  ]
}
