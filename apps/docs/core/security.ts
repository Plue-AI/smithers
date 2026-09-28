/**
 * Security review of the site's own sources: the synced content pages users
 * copy snippets from, the Starlight config, and the Alchemy deploy stack.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "docs-snippet-safety",
      title: "Published code snippets carry no live credentials and no unsafe patterns readers copy",
      threat: "A reader who copies a snippet from core.smithers.sh leaks a real key or ships an unsafe effect declaration into their own flow.",
      lookFor: [
        "A token, API key, bearer header, or private URL with a real-looking value in a fenced code block.",
        "An install command naming a package outside the @smthrs scope, or a lookalike of an @smthrs name.",
        "A `curl ... | sh` or similar pipe-to-shell install line."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-raw-html",
      title: "Synced Markdown pages render no raw HTML, script, or event handler on the smithers.sh origin",
      threat: "A contributor who edits packages/smithers/flows/core/docs injects script that contentSync copies verbatim into core.smithers.sh, running in readers' browsers on a smithers.sh subdomain.",
      lookFor: [
        "A raw `<script>`, `<iframe>`, `<object>`, `<embed>`, or `<style>` tag outside a fenced code block.",
        "An `on*=` attribute or a `javascript:` or `data:` URL in a link, image, or HTML tag."
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
      title: "The site config and deploy stack publish only the static build under the core slug",
      threat: "A change to the generated config lets a deploy publish unintended files or bind the site to another subdomain or Worker.",
      lookFor: [
        "A `slug`, `sourceDir`, or `contentDir` that differs from `core` and `packages/smithers/flows/core`.",
        "A new script in package.json or astro.config.mjs that runs shell commands, reads env secrets, or injects raw HTML."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json"]
    }
  ]
}
