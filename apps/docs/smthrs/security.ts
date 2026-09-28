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
      id: "docs-install-names",
      title: "Install and migrate instructions name only packages and commands Smithers owns",
      threat: "Anyone who registers an unclaimed npm name the smthrs pages tell 0.x users to install or bunx/npx runs their code on those users' machines.",
      lookFor: [
        "An npm install, npx, bunx, or pnpm add line naming an unscoped package other than smthrs, a scope other than @smthrs, or an @smthrs/* name misspelled against the packages listed in index.md.",
        "A migration step telling users to run a command such as `smthrs migrate --apply` without saying which installed package provides the `smthrs` executable."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-link-targets",
      title: "Migration and reference links point only at smithers.sh hosts and the smithersai GitHub org",
      threat: "A contributor who edits a synced page sends migrating users to a look-alike domain that serves a malicious migration script or package.",
      lookFor: [
        "A link or editUrl whose host is not smithers.sh, a *.smithers.sh subdomain, or github.com/smithersai.",
        "A shell snippet that pipes a remote download into sh."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on smthrs.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an API token or state-store secret instead of the shared kit's environment reads."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    }
  ]
}
