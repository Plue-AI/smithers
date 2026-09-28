/**
 * Security review: `security` reviews the diff against origin/main,
 * `securityAudit` audits every file. The docs prose is a synced copy of
 * @smthrs/chain's colocated docs, so these checks cover what a reader copies
 * and what the deploy config ships.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "public/**", "astro.config.mjs", "alchemy.run.ts", "package.json", "tsconfig.json"],
  checks: [
    {
      id: "copied-snippet-least-authority",
      title: "Authorization snippets readers copy grant no broader authority than the guide explains",
      threat: "A developer copies a documented Authorize rule set or catalog entry and ships an agent chain that can write or execute beyond what they intended.",
      lookFor: [
        "A code block allowing fs:write, exec, or network on a ** or * resource without a comment that it is permissive.",
        "Prose claiming a verdict (deny beats ask beats allow, unmatched claims ask) that contradicts the snippet beside it.",
        "An example catalog entry omitting capabilities while the text implies it is safe, since undeclared entries claim [\"*\"]."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "journal-secret-guidance",
      title: "Docs keep secrets out of the journal and replay examples",
      threat: "A developer following the resume and replay guides persists API keys or tokens in the append-only journal, where later readers of the run recover them.",
      lookFor: [
        "An example passing a credential, bearer token, or env secret as a call argument or payload that the journal records.",
        "A literal key-shaped string (sk-, ghp_, AKIA, xox) in any snippet."
      ],
      paths: ["src/content/docs/guides/**", "src/content/docs/concepts/**", "src/content/docs/reference/**"]
    },
    {
      id: "synced-content-inert",
      title: "Synced docs pages render as inert markup on chain.smithers.sh",
      threat: "A contributor who edits @smthrs/chain's colocated docs runs script on the chain.smithers.sh origin and reads or rewrites what every reader of the site sees.",
      lookFor: [
        "Raw HTML in a synced .md or .mdx page outside a code fence: <script>, <iframe>, an on* handler attribute, or a javascript: or data: URL.",
        "An install or run command naming a package outside the @smthrs or @smithers scopes, or a curl-pipe-to-shell line, that a reader would paste."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "deploy-config-no-secrets",
      title: "Site and deploy config commit no credentials or account state",
      threat: "Anyone reading the public repository takes a Cloudflare token or Alchemy state and deploys over or destroys chain.smithers.sh.",
      lookFor: [
        "A token, account id secret, or password inline in alchemy.run.ts, astro.config.mjs, or package.json scripts.",
        "A package.json script that deploys or destroys prod without the documented stage flag."
      ],
      paths: ["alchemy.run.ts", "astro.config.mjs", "package.json"]
    }
  ]
}
