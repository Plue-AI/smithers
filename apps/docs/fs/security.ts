/**
 * Security review of the site: `security` reviews the diff against
 * origin/main, `securityAudit` audits every owned file. Content is synced from
 * packages/smithers/agent/fs/docs, whose own reviewer owns the prose source.
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
      threat: "Any reader of fs.smithers.sh copies a live provider key, gateway token, or invoker credential and spends or impersonates the owner's account.",
      lookFor: [
        "A string literal shaped like a real key (sk-, sk-ant-, ghp_, xox, AKIA, long base64/hex) inside a fenced code block or table.",
        "A FlowInvoker or harness snippet that inlines a credential value instead of reading it from a resolver or environment variable."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-unauthenticated-flow-serving",
      title: "Serving guides do not teach exposing flow invocation to the network without an auth layer",
      threat: "A user who copies the HTTP or MCP serving snippet lets any network client invoke every modelInvocable flow, with the flow's capabilities, against their own repository and credentials.",
      lookFor: [
        "A snippet wiring cli.fetch or the /mcp surface into a listening server bound to 0.0.0.0 or a public host with no authentication or origin check in front of it.",
        "Guide prose that presents cli.fetch or --mcp as safe to expose publicly without stating that the caller gains flow-invocation authority."
      ],
      paths: ["src/content/docs/guides/serve-over-cli-http-and-mcp.md", "src/content/docs/guides/expose-flows-to-an-agent.md", "src/content/docs/quickstart.md"]
    },
    {
      id: "docs-security-claims-match-source",
      title: "Security guarantees the docs state hold in @smthrs/fs source",
      threat: "A user relies on a documented guarantee (scan imports no module, hidden routes never mount, %2F cannot invent a path boundary, errors never retain raw input) that the code does not keep, and exposes an agent or HTTP client to hidden flows or leaked input.",
      lookFor: [
        "A claim in contract.md, metadata-routing.md, or the guides that has no matching enforcement in packages/smithers/agent/fs/src (e.g. FileRouter.scan calling import(), Incur mounting a modelInvocable:false route, error messages interpolating argument values).",
        "A resource limit in the contract.md table whose number differs from the constant exported by the source package."
      ],
      paths: ["src/content/docs/contract.md", "src/content/docs/concepts/**", "src/content/docs/guides/**", "src/content/docs/troubleshooting.md", "src/content/docs/reference/api.md"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on fs.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an account id, API token, or state-store secret instead of the shared kit's environment reads."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    }
  ]
}
