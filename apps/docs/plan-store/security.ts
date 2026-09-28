/**
 * Security review: `security` reviews the diff against origin/main;
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
      title: "Published docs and examples carry no real credentials or real database paths",
      threat: "Any reader of plan-store.smithers.sh copies a live API key, token, or a real host's database path from a snippet and uses or exposes the owner's data.",
      lookFor: [
        "A string literal shaped like a real key (sk-, sk-ant-, ghp_, AKIA, long base64/hex) inside a fenced code block or table.",
        "A NodeDatabase.layer filename pointing at an absolute user or server path instead of a relative placeholder such as smithers.db."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-plan-integrity-guidance",
      title: "Guides never teach bypassing the plan store's append-only and approval guarantees",
      threat: "A user who follows a guide overwrites or grafts nodes onto an approved plan, so a run executes steps a human never approved against their repository.",
      lookFor: [
        "Text or a snippet that handles a record Conflict or append constraint failure by deleting rows, dropping the append-only triggers, or rewriting baseDigest.",
        "A snippet that writes flows_plans, flows_plan_nodes, or flows_plan_edges with raw SQL instead of PlanStore.record/append.",
        "Guidance to run the plan-store migration set out of order or below an applied high-water mark, which the migrator would silently skip."
      ],
      paths: ["src/content/docs/guides/**", "src/content/docs/troubleshooting.md", "src/content/docs/reference/**"]
    },
    {
      id: "docs-install-and-link-targets",
      title: "Install commands and links send readers only to the pinned packages and domains the project controls",
      threat: "A reader who pastes an install command or follows a link from the site installs a squatted or typo'd npm package, or lands on a lookalike domain, and runs an attacker's code on their machine.",
      lookFor: [
        "A pnpm/npm/yarn add command naming a package outside @smthrs/, @effect/, and effect, a misspelled scope, or an unpinned version where the page pins the others.",
        "A link whose host is not smithers.sh, a *.smithers.sh subdomain, or github.com/smithersai.",
        "A page telling readers to install @smthrs/plan-store from npm while it is still marked \"Not on npm yet\"."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on plan-store.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an API token or state-store secret instead of the shared kit's environment reads."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    }
  ]
}
