/**
 * Security review: `security` reviews the diff against origin/main,
 * `securityAudit` audits every included file.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "public/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "docs-example-secrets",
      title: "Published docs and examples carry only synthetic placeholder secrets",
      threat: "Any visitor to canonical.smithers.sh copies a real token, key, or email that a synced page leaked from a maintainer's environment.",
      lookFor: [
        "A string in src/content/docs that looks like a live credential (sk-, ghp_, AKIA, JWT, bearer) instead of a SYNTHETIC_* placeholder.",
        "A link or install command that points at a plain-http URL, a lookalike package name, or a host other than the smithers repo, *.smithers.sh, rfc-editor.org, effect.website, or npm."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-content-injection",
      title: "Synced Markdown renders as inert text with no raw HTML or script",
      threat: "A contributor who edits the upstream colocated docs runs script in every canonical.smithers.sh visitor's browser, because Astro renders raw HTML in .md files verbatim.",
      lookFor: [
        "A <script>, <iframe>, <object>, <embed>, <form>, <style>, or inline on*= event handler in a file under src/content/docs.",
        "A link or image whose URL uses the javascript:, data:, or vbscript: scheme.",
        "A CSS @import or url() in src/styles that loads from a remote host."
      ],
      paths: ["src/content/docs/**", "src/styles/**"]
    },
    {
      id: "docs-redaction-advice",
      title: "Copyable snippets never tell users to log or return canonical error paths unredacted",
      threat: "A developer who copies a snippet exposes their users' sensitive record keys or thrown values, which SchemaError paths and messages embed, in logs or API responses.",
      lookFor: [
        "A snippet that logs, returns, or rethrows error.path or error.message from a canonical failure without the redaction the troubleshooting page requires.",
        "A content-key or digest snippet that hashes JSON.stringify output instead of canonicalize output, so a key-order change silently alters the digest."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "site-deploy-config",
      title: "Site config and deploy stack hold no credentials and ship only static assets",
      threat: "Anyone with repo read access takes over the Cloudflare account or canonical.smithers.sh through an API token or state password inlined in the site config, or a visitor runs script injected through public/.",
      lookFor: [
        "A Cloudflare API token or alchemy state password written literally in alchemy.run.ts, astro.config.mjs, or package.json instead of read from the environment.",
        "A package.json script or dependency that fetches and runs remote code during build or deploy, or an unpinned prerelease beyond the declared alchemy beta.",
        "A file in public/ that is executable content (HTML, JS, SVG with script) rather than the favicon."
      ],
      paths: ["alchemy.run.ts", "astro.config.mjs", "package.json", "public/**"]
    }
  ]
}
