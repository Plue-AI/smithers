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
      id: "copyable-restore-fenced",
      title: "Restore snippets readers copy fence the restored store before an engine adopts it",
      threat: "A reader who copies a restore snippet lets a surviving pre-backup owner resume writing into the restored store and corrupt its runs.",
      lookFor: [
        "A snippet that calls DisasterRecovery.restore and opens an engine on the target without DisasterRecovery.fence or restoreAndFence.",
        "Prose in back-up-and-restore.md or reclaim-runs-from-a-dead-host.md that calls fencing optional after a restore."
      ],
      paths: ["src/content/docs/guides/back-up-and-restore.md", "src/content/docs/guides/reclaim-runs-from-a-dead-host.md", "src/content/docs/concepts/ownership-and-fencing.md"]
    },
    {
      id: "copyable-shared-cache-trust",
      title: "Shared-cache guidance keeps write access to trusted producers and tiers per tenant",
      threat: "A reader who follows the shared-cache guide lets an untrusted machine or tenant poison cache entries that replay into every consumer's workspace.",
      lookFor: [
        "A snippet or step that gives every consumer write credentials to the shared step-result tier.",
        "Removal of the read-only-consumer or separate-tier-per-tenant guidance from share-a-cache-across-machines.md."
      ],
      paths: ["src/content/docs/guides/share-a-cache-across-machines.md", "src/content/docs/concepts/cache-admission.md"]
    },
    {
      id: "copyable-liveness-check",
      title: "isAlive examples never admit a steal of a run whose owner is alive",
      threat: "A reader who copies an isAlive example lets a second engine steal a live run and execute an irreversible step twice.",
      lookFor: [
        "An isAlive example that always answers false, or a same-host PID probe recommended for owners on other hosts.",
        "A snippet that disables fencing or heartbeat checks to force a takeover."
      ],
      paths: ["src/content/docs/**/*.md"]
    },
    {
      id: "copyable-observation-not-authority",
      title: "Observation guidance never treats a read wait token or cursor as permission to act",
      threat: "A reader who follows the observation guide lets any caller who can list executions resolve another run's approval or signal wait with the token it read.",
      lookFor: [
        "Removal of the sentence that reading a token is not permission to resolve it, or a snippet that resolves a wait using only a token read from observation.",
        "Prose or a snippet that treats an observation cursor as an authorization token or scopes access by cursor alone."
      ],
      paths: ["src/content/docs/guides/observe-executions.md", "src/content/docs/concepts/durable-waits.md"]
    },
    {
      id: "rendered-markup-and-links",
      title: "Pages render no raw scripts or embeds, and source and edit links point at smithersai/smithers",
      threat: "A content change makes engine-store.smithers.sh run attacker script in readers' browsers or send readers who click a source or edit link to a look-alike repository.",
      lookFor: [
        "A <script>, <iframe>, inline event handler, or javascript: URL in a Markdown page or in src/styles.",
        "An editUrl or GitHub source link whose host or owner is not github.com/smithersai/smithers."
      ],
      paths: ["src/content/docs/**", "src/styles/**", "src/content.config.ts"]
    },
    {
      id: "docs-no-secrets",
      title: "Published pages and assets carry no credentials, private hosts, or local paths",
      threat: "Anyone browsing engine-store.smithers.sh reads a maintainer's token, cache-tier credential, or machine path leaked into public docs.",
      lookFor: [
        "An API key, bearer token, bucket credential, or Cloudflare account id in a page or asset.",
        "An absolute path under /Users/ or a private hostname copied from a maintainer's machine."
      ],
      paths: ["src/content/docs/**", "public/**"]
    },
    {
      id: "deploy-stack-scoped",
      title: "The deploy stack targets only the engine-store docs site and prod stage",
      threat: "A change to the generated deploy entry points lets a deploy overwrite or destroy another docs site or run unreviewed dependency code with Cloudflare credentials.",
      lookFor: [
        "alchemy.run.ts passing a slug other than \"engine-store\" to makeDocsSiteStack.",
        "A package.json script that runs a network-fetched binary (npx/dlx) or an unpinned deploy tool beside the Cloudflare credentials."
      ],
      paths: ["alchemy.run.ts", "package.json"]
    }
  ]
}
