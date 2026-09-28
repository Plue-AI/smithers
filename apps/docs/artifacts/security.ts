/**
 * Security review of the published site: the snippets readers copy and the
 * config that builds and deploys it. `security` reviews the diff against
 * origin/main; `securityAudit` audits every included file.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "copied-snippet-credentials",
      title: "Remote store examples keep credentials out of source, URLs, and logs",
      threat: "A reader who copies a remote artifact store example ships a live bearer token or leaks it through a URL or log line.",
      lookFor: [
        "A code block that assigns a literal token, key, or password instead of a declared or environment-sourced value.",
        "An example remote URL carrying userinfo (`user:secret@host`) or a token in the query string.",
        "Prose claiming a credential is redacted from logs or errors that the @smthrs/artifacts API reference does not state.",
        "A stated endpoint, scheme, or redaction rule that contradicts //packages/smithers/flows/artifacts/src/RemoteArtifacts.ts (for example the loopback `http:` exemption)."
      ],
      paths: ["src/content/docs/guides/share-artifacts-across-machines.md", "src/content/docs/guides/serve-the-artifact-protocol.md", "src/content/docs/reference/api.md"]
    },
    {
      id: "store-safety-guidance",
      title: "Store guidance never tells readers to weaken integrity, locking, or transport checks",
      threat: "A reader following a guide serves or consumes artifacts over plaintext or unverified channels, letting a network attacker or another host process substitute content.",
      lookFor: [
        "An example remote endpoint using `http://` for a non-loopback host.",
        "Advice to skip digest verification, delete lock or claim files by hand, or run the protocol server without authentication on a shared network.",
        "A troubleshooting fix that widens store directory permissions (for example `chmod 777`) or disables the stale-lock fence.",
        "The test-guide fetch override that rewrites an HTTPS authority to loopback `http:` presented as usable outside a test layer."
      ],
      paths: ["src/content/docs/guides/**", "src/content/docs/troubleshooting.md", "src/content/docs/concepts/**"]
    },
    {
      id: "site-deploy-config",
      title: "Site build and deploy config ship only static content with no secrets or server-side execution",
      threat: "A change to the generated site config or Alchemy stack exposes deploy credentials or adds worker code that runs attacker-reachable logic on artifacts.smithers.sh.",
      lookFor: [
        "A literal API token or secret in alchemy.run.ts, astro.config.mjs, or package.json scripts.",
        "A config option that enables SSR, a worker route, or `run_worker_first` beyond the shared makeDocsSiteStack defaults.",
        "A package.json script that pipes a remote download into a shell, or a dependency moved off a pinned registry version to a URL or git source."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json"]
    },
    {
      id: "rendered-markup-injection",
      title: "Synced markdown renders no author-controlled script or off-site redirect on artifacts.smithers.sh",
      threat: "A contributor to packages/smithers/flows/artifacts/docs gets script, an iframe, or a phishing link published on the smithers.sh origin through contentSync.",
      lookFor: [
        "Raw HTML in a .md file outside code fences: `<script>`, `<iframe>`, event-handler attributes, or `style` that overlays page chrome.",
        "A link or image with a `javascript:` or `data:` URL, or an install/download link pointing off github.com/smithersai or *.smithers.sh.",
        "An `editUrl` or `head` frontmatter entry that points outside github.com/smithersai/smithers or injects tags."
      ],
      paths: ["src/content/docs/**"]
    }
  ]
}
