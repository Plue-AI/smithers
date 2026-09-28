/**
 * Security review of the site's own sources. The content tree is a synced copy
 * of packages/smithers/flows/platform-node/docs; the checks target what
 * readers copy about the confinement, helper, containment, and liveness
 * boundaries.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "astro.config.mjs", "alchemy.run.ts"],
  checks: [
    {
      id: "confinement-snippets-use-guarded-host",
      title: "Copyable filesystem snippets route workspace access through the guarded host, never the raw Node filesystem",
      threat: "A flow author who copies a snippet runs flows with NodeHost.NodeFileSystem or node:fs directly, letting a flow read or write host files outside its workspace through a symlink.",
      lookFor: [
        "A code block that serves flow file access from NodeHost.NodeFileSystem or node:fs without HostServices.layer wrapping it, outside the quickstart's deliberate escape setup.",
        "Prose claiming a symlink escape, retarget, or root swap is refused that contradicts concepts/descriptor-relative-filesystem.md (no component symlink followed, root identity checked before and after).",
        "A glob snippet in guides/match-files-with-glob.md whose root is a relative or user-supplied path presented as confined."
      ],
      paths: ["src/content/docs/quickstart.md", "src/content/docs/installation.md", "src/content/docs/concepts/**", "src/content/docs/guides/match-files-with-glob.md", "src/content/docs/reference/api.md"]
    },
    {
      id: "helper-executable-trusted-path",
      title: "Helper configuration docs require an absolute helper path outside the workspace with an empty environment",
      threat: "Someone who can write inside a workspace or set PATH or SMITHERS_WORKSPACE_JJ_EXPORT_BINARY on the host plants a smithers-jj-export that runs with the host's pinned root descriptor.",
      lookFor: [
        "An `executable` example or resolution-order entry that is relative, PATH-resolved, or inside the workspace root.",
        "Guidance to set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY from flow- or user-controlled input, or omission of the rule that the binary is re-validated per request.",
        "Advice to raise or remove the byte, process, or timeout ceilings to unbounded values without stating the resource-exhaustion cost."
      ],
      paths: ["src/content/docs/guides/configure-the-filesystem-helper.md", "src/content/docs/concepts/descriptor-relative-filesystem.md", "src/content/docs/installation.md", "src/content/docs/reference/api.md"]
    },
    {
      id: "containment-and-liveness-claims",
      title: "Process containment and run-ownership docs never advise a composition that orphans children or double-runs a run",
      threat: "An operator who follows a guide spawns uncontained children that survive a host crash, or treats a live owner as dead so two hosts execute one run and duplicate its side effects.",
      lookFor: [
        "A snippet that spawns through NodeChildProcessSpawner instead of the contained spawner while the guide claims kill deadlines or reaping.",
        "A rule in guides/answer-run-ownership.md that reports an owner dead on EPERM, a cross-host owner, or an unknown throw, instead of only on ESRCH for a same-host pid.",
        "A substitute isAlive example that returns false by default or on error."
      ],
      paths: ["src/content/docs/guides/contain-child-processes.md", "src/content/docs/concepts/process-containment.md", "src/content/docs/guides/answer-run-ownership.md", "src/content/docs/troubleshooting.md", "src/content/docs/reference/api.md", "src/content/docs/index.md"]
    },
    {
      id: "egress-proxy-http-client",
      title: "HTTP client snippets for sandboxed hosts route through the egress proxy, never a direct Undici pool",
      threat: "An operator who copies a composition that provides NodeHttpClient.layerUndici inside an egress-controlled sandbox lets flow HTTP calls dial any origin directly, bypassing the proxy's allowlist and audit.",
      lookFor: [
        "A complete-host snippet that provides NodeHost.NodeHttpClient.layerUndici without stating it dials every origin directly, or presents it as the bundle default.",
        "A Layer.provide of a plain HTTP client beneath a layer that should inherit EgressHttpClient.layer(process.env), shadowing the proxy-aware client.",
        "Prose presenting EgressHttpClient.layer(process.env) as enforcing egress without stating it is the plain direct pool when HTTP_PROXY, HTTPS_PROXY, and NO_PROXY name no proxy."
      ],
      paths: ["src/content/docs/installation.md", "src/content/docs/concepts/host-bundle.md", "src/content/docs/reference/api.md", "src/content/docs/quickstart.md"]
    },
    {
      id: "site-config-no-secrets-or-raw-html",
      title: "Site config and deploy stack carry no credentials and inject no raw HTML or scripts",
      threat: "Anyone who reads the public repository or the built site obtains a deploy credential, or a content author injects script into platform-node.smithers.sh visitors' browsers.",
      lookFor: [
        "A token, API key, or password literal in astro.config.mjs or alchemy.run.ts instead of an environment-provided binding.",
        "A head entry, custom component, or markdown with raw <script> or on* handler added to the site config or content.",
        "An alchemy.run.ts slug other than \"platform-node\", which would deploy over another site's worker or domain."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "src/content/docs/**"]
    }
  ]
}
