/**
 * Security review of the site's own files: the synced docs users copy from,
 * and the deploy and build config. The patterns source has its own reviewer.
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
      title: "Published docs and examples carry no real credentials or private endpoints",
      threat: "Any reader of the public site copies a live API key, token, or internal host from a code sample and uses it against Smithers accounts.",
      lookFor: [
        "A string in a code fence shaped like a real key (sk-, ghp_, AKIA, xox, a JWT) rather than an obvious placeholder.",
        "A private hostname, account id, or internal dashboard URL in a sample or link."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "delegation-guard-examples",
      title: "Delegation and team examples keep approvals and plan envelopes in force",
      threat: "A user who copies a sample runs a model-authored plan or a risky runbook step with no approval gate or bound, letting a prompt-injected model act on their repository.",
      lookFor: [
        "A Trellis or DelegationChain sample whose envelope or capability bound is omitted, unbounded, or widened by the model-authored plan.",
        "An Intervene, Runbook, or WithApproval sample, or prose, that auto-approves, skips the approval, or claims a guarantee the section does not show."
      ],
      paths: [
        "src/content/docs/delegation.md",
        "src/content/docs/teams.md",
        "src/content/docs/modules.md",
        "src/content/docs/index.md",
        "src/content/docs/reference/api.md"
      ]
    },
    {
      id: "site-markup-injection",
      title: "Synced markdown renders no active content",
      threat: "Anyone who lands a docs change in the source package injects script into smithers-patterns.smithers.sh and runs it in every visitor's browser.",
      lookFor: [
        "Raw <script>, <iframe>, event-handler attributes, or javascript: URLs in markdown or public assets.",
        "A link or editUrl whose host is not smithers.sh, a *.smithers.sh subdomain, or github.com/smithersai."
      ],
      paths: ["src/content/**", "public/**"]
    },
    {
      id: "site-deploy-config",
      title: "Build and deploy config hold no credentials and pin the deploy toolchain",
      threat: "Anyone who can change the site's dependencies or config ships code that runs with the deployer's Cloudflare credentials.",
      lookFor: [
        "An inline token, account id, or secret in alchemy.run.ts, astro.config.mjs, or package.json.",
        "A deploy or destroy script, or a floating dependency range on alchemy, that runs a tool version not pinned in package.json."
      ],
      paths: ["alchemy.run.ts", "astro.config.mjs", "package.json"]
    }
  ]
}
