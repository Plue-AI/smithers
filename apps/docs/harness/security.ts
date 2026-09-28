/**
 * Security review: `security` reviews the diff against origin/main and
 * `securityAudit` audits the whole site. The rendered content mirrors
 * @smthrs/harness's colocated docs, which readers copy into sandbox hosts.
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
      threat: "Any reader of harness.smithers.sh copies a live provider, gateway, or Cloudflare key from a snippet and spends or impersonates the owner's account.",
      lookFor: [
        "A string literal shaped like a real key (sk-, sk-ant-, ghp_, AKIA, long base64 or hex) inside a fenced code block, table, or wrangler config.",
        "A snippet that inlines a key value instead of reading it from an environment variable or resolver."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-sandbox-escape-snippets",
      title: "Copyable sandbox snippets keep the QuickJS realm bounded and host-free",
      threat: "A host author who copies a guide snippet runs model-written cells with unbounded CPU, memory, or calls, or with a Sandbox.Handler that reaches the host filesystem, shell, or network directly.",
      lookFor: [
        "A realm or RealmEvaluation.limits example that raises calls, steps, timeMs, totalMs, or memoryBytes without a ceiling and presents it as a default.",
        "A Sandbox.Handler example that dispatches on the model-supplied flow name or input to fs, child_process, fetch, or eval without a declared FlowProjection.",
        "Text that tells readers to allow cell imports, expose host globals, or skip the variant wiring on workerd as a workaround."
      ],
      paths: ["src/content/docs/guides/run-cells.md", "src/content/docs/guides/workerd.md", "src/content/docs/quickstart.md", "src/content/docs/index.md"]
    },
    {
      id: "docs-flow-capability-grants",
      title: "Flow binding examples grant only the capabilities and effects the handler uses",
      threat: "A host author who copies a FlowBinding or FlowProjection example grants model-written cells read access to the whole host filesystem for a flow that needs none.",
      lookFor: [
        "A flow declaration whose capabilities or effects.reads use a root wildcard such as fs:read:/** or fs:read:** while its handler reads no files.",
        "A publicError example that forwards raw error messages, URLs, headers, or causes of transport, SDK, or OS errors into the call result."
      ],
      paths: ["src/content/docs/guides/bind-flows.md", "src/content/docs/guides/workerd.md", "src/content/docs/guides/drive-the-loop.md", "src/content/docs/concepts.md"]
    },
    {
      id: "docs-rendered-markup",
      title: "Rendered pages carry no raw HTML, script URLs, or links to unowned hosts",
      threat: "A contributor to @smthrs/harness's colocated docs injects script into every harness.smithers.sh visitor's browser, or points readers at a lookalike repository or install source.",
      lookFor: [
        "Raw <script>, <iframe>, <style>, event-handler attributes, or javascript: and data: URLs in a Markdown page.",
        "A link, editUrl, or clone instruction whose host is not smithers.sh, github.com/smithersai, or effect.website.",
        "Install text that pipes a remote script to a shell or names a package outside the @smthrs scope as the harness."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on harness.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an account id, API token, or state-store secret instead of the shared kit's environment reads."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    }
  ]
}
