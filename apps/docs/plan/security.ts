/**
 * `security` reviews this site's diff against origin/main; `securityAudit`
 * audits every owned file. The general check is always appended.
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
      threat: "Any reader of plan.smithers.sh copies a live provider key, database URL, or deploy token from a snippet and spends or impersonates the owner's account.",
      lookFor: [
        "A string literal shaped like a real key (sk-, sk-ant-, ghp_, AKIA, long base64/hex that is not a documented key1_ digest) inside a fenced code block.",
        "A persistence or plan-store snippet that inlines a database connection string with a password instead of reading it from the environment.",
        "A NodeDraft example that puts a token or password in a node body or inputs, which Plan.compile writes as plaintext into node_json and the approval card."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-plan-integrity-claims",
      title: "Docs state plan approval and step-key guarantees no stronger than the code enforces",
      threat: "An integrator trusts a docs claim that baseDigest proves approval or that a sealed key makes results safe to reuse, and executes or reuses work a reviewer never signed off on.",
      lookFor: [
        "Text saying baseDigest or digest authenticates who approved a plan, when it is an unkeyed content hash anyone can recompute.",
        "A snippet teaching kind \"sealed\" for side-effecting work, or dropping inputs/capabilities from key material, so a cached result is reused across runs with different authority.",
        "A claim that Plan.append or plan-store triggers prevent tampering by a database owner rather than detect an edited row."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on plan.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an API token or state-store secret instead of the shared kit's environment reads.",
        "A synced markdown page carrying a raw <script>, <iframe>, or inline event-handler attribute that Starlight renders unescaped."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts", "src/content/docs/**"]
    }
  ]
}
