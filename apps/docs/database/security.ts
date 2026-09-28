/**
 * `security` reviews the diff against origin/main; `securityAudit` audits the
 * whole site on demand. The site ships copied docs, a Starlight config, and an
 * Alchemy deploy stack; the checks target what a reader copies or what
 * deploys.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "public/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "copyable-sql-parameterized",
      title: "SQL snippets readers copy bind values through tagged-template parameters",
      threat: "A reader who copies a guide snippet ships SQL injection that lets an attacker read or delete rows in the reader's database.",
      lookFor: [
        "A SQL snippet that concatenates or `${}`-interpolates a value into a plain string, or uses sql.unsafe/sql.literal, instead of the sql`...` tag.",
        "A guide that passes caller input to a table or column name without an allowlist."
      ],
      paths: ["src/content/docs/**/*.md"]
    },
    {
      id: "copyable-install-pinned",
      title: "Install commands readers copy name the real published packages at pinned versions",
      threat: "A reader who copies an install line installs a typosquatted or unpinned package that runs attacker code on their machine.",
      lookFor: [
        "A `pnpm add`/`npm install` line whose package name differs from the peers declared by packages/smithers/flows/database/package.json.",
        "An install line without an exact version, or a `curl | sh`/npx line fetching code from an unowned host."
      ],
      paths: ["src/content/docs/**/*.md"]
    },
    {
      id: "docs-no-secrets",
      title: "Published pages and assets carry no credentials, private hosts, or local paths",
      threat: "Anyone browsing database.smithers.sh reads a maintainer's token, database URL, or machine path leaked into public docs.",
      lookFor: [
        "A connection string with a password, an API key, bearer token, or Cloudflare account id in a page or asset.",
        "An absolute path under /Users/ or a private hostname copied from a maintainer's machine."
      ],
      paths: ["src/content/docs/**", "public/**"]
    },
    {
      id: "deploy-stack-scoped",
      title: "The deploy stack targets only the database docs site and prod stage",
      threat: "A change to the generated deploy entry points lets a deploy overwrite or destroy another docs site or run unreviewed dependency code with Cloudflare credentials.",
      lookFor: [
        "alchemy.run.ts passing a slug other than \"database\" to makeDocsSiteStack.",
        "astro.config.mjs passing a slug or sourceDir other than \"database\" and packages/smithers/flows/database, which publishes another package's docs under this host.",
        "A package.json script that runs a network-fetched binary (npx/dlx) or an unpinned deploy tool beside the Cloudflare credentials."
      ],
      paths: ["alchemy.run.ts", "astro.config.mjs", "package.json"]
    }
  ]
}
