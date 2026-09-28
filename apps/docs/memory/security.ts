/**
 * Security review of the site's config, deploy stack, and synced content.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "public/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "memory-trust-boundary-claims",
      title: "Guides keep stored memory untrusted and the fence a delimiter, not a trust boundary",
      threat: "An integrator who trusts an overstated guide feeds model-written memory rows into later runs as instructions, letting one poisoned row steer every later agent run.",
      lookFor: [
        "Text calling the `<flows_memory_context>` fence a trust or security boundary, or removing the statement that a host must not treat fenced text as instructions.",
        "An escape list for `Source.render` that omits `\\`, `<`, `[`, or a line terminator (CR, LF, NEL, LS, PS), or omits `]`, `:`, `/` for labels.",
        "Text claiming `RecallFts` passes user query syntax through to FTS5 operators, contradicting per-term quoting."
      ],
      paths: [
        "src/content/docs/guides/agent-opening-context.md",
        "src/content/docs/concepts/recall.md",
        "src/content/docs/reference/api.md"
      ]
    },
    {
      id: "memory-policy-scope-claims",
      title: "Guides state exactly which memory APIs enforce the namespace policy",
      threat: "A host author who believes bare handlers are scoped exposes `runRecall`, `runRemember`, or store methods to a model, which then reads or writes another flow's or tenant's memory banks.",
      lookFor: [
        "Text claiming bare handlers, `runRecall`, `runRemember`, recall services, or store methods enforce `WithMemory` policies.",
        "Text saying a request mixing allowed and foreign banks returns the allowed rows instead of failing whole with `invalid_namespace`.",
        "An example wiring model-facing memory access through unscoped `Flows.runRecall` or `runRemember` without calling out that it has no policy boundary.",
        "Text claiming `retain: \"never\"` or `recall: \"none\"` still reaches the store or recall service."
      ],
      paths: [
        "src/content/docs/concepts/policies.md",
        "src/content/docs/guides/scope-a-flow-tree.md",
        "src/content/docs/guides/recall-memory.md",
        "src/content/docs/guides/store-facts.md",
        "src/content/docs/index.md",
        "src/content/docs/quickstart.md",
        "src/content/docs/reference/api.md",
        "src/content/docs/troubleshooting.md"
      ]
    },
    {
      id: "site-deploy-no-secrets",
      title: "Published site and deploy config carry no credentials or private endpoints",
      threat: "Anyone browsing memory.smithers.sh or the public repository reads a Cloudflare, Alchemy, or embedding-provider credential, or a private host, that lets them take over the site or bill the owner's account.",
      lookFor: [
        "An inline token, account id paired with a key, or state-store secret in alchemy.run.ts, astro.config.mjs, or package.json scripts.",
        "A docs example for `Embedding.layer` or a semantic recall setup that embeds a real provider API key or connection string instead of a placeholder or environment read.",
        "A file under public/ or a docs page that embeds a bearer token, internal hostname, or local absolute path from a maintainer machine.",
        "A package.json deploy or destroy script that targets prod without the stage flag or passes credentials on the command line."
      ],
      paths: ["alchemy.run.ts", "astro.config.mjs", "package.json", "public/**", "src/content/docs/**"]
    },
    {
      id: "site-no-active-content",
      title: "Synced docs pages ship no script or active HTML to memory.smithers.sh",
      threat: "An agent or contributor who edits the source package's colocated docs runs script in every visitor's browser on memory.smithers.sh, because contentSync copies the markdown verbatim into the built site.",
      lookFor: [
        "Raw `<script>`, `<iframe>`, `<object>`, `<embed>`, or `<form>` tags, or `on*=` event attributes, in a markdown page.",
        "A `javascript:` or `data:text/html` link target in a markdown link or HTML anchor.",
        "A stylesheet or content collection config that loads a remote script or stylesheet from a non-first-party host."
      ],
      paths: ["src/content/docs/**", "src/styles/**", "src/content.config.ts"]
    }
  ]
}
