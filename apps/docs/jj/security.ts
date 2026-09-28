/**
 * Security review of the site's own files: the synced @smthrs/jj guides that
 * make containment and binary-trust claims, the snippets readers paste, and
 * the deploy and build config. The source package has its own review.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "public/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "containment-claims-hold",
      title: "Guides never overclaim what jj binding, spawner containment, or the wasm root confine",
      threat: "An integrator who trusts an overstated guide runs untrusted repositories or concurrent writers and lets jj read or write outside the intended checkout or storage slice.",
      lookFor: [
        "Text calling BrowserJj's `root` a sandbox, or the \"Namespace ownership is required\" caveat (root is not a sandbox for node:fs under concurrent mutation) removed or softened in the browser guide or API reference.",
        "The workspace-lanes claim that re-canonicalizing after the grant checks means a planted symlink \"cannot redirect the lane\", when a swap after the second canonicalization and before jj creates the directory is still a race.",
        "Text claiming `layer` (unspawnered) is contained, reaped, or recorded in the host process ledger.",
        "Text saying `root(from)` or a relative `workspaceAdd` path is confined by `layerAt`, contradicting the stated exemptions.",
        "A statement that the wasm reactor safely snapshots real symlinks, contradicting the symlink guard section."
      ],
      paths: [
        "src/content/docs/guides/bind-and-contain.md",
        "src/content/docs/guides/run-jj-in-a-browser.md",
        "src/content/docs/guides/workspace-lanes.md",
        "src/content/docs/troubleshooting.md",
        "src/content/docs/concepts/**",
        "src/content/docs/reference/api.md"
      ]
    },
    {
      id: "jj-binary-trust-guidance",
      title: "Binary selection and install guidance keeps operators running the jj they chose",
      threat: "A reader following the docs executes an attacker-supplied jj or runs injected shell commands on their own machine.",
      lookFor: [
        "An install snippet that pipes a download into a shell, disables quarantine or signature checks wholesale, or fetches jj from an unofficial URL.",
        "A remediation example that interpolates a SMITHERS_JJ_PATH value into a shell command without the shellQuote quoting the guide requires.",
        "Text claiming a repository working directory, a later PATH change, or a relative override can select the executable, contradicting absolute resolution at layer construction.",
        "Text claiming the package downloads, vendors, or chmods a jj binary."
      ],
      paths: [
        "src/content/docs/installation.md",
        "src/content/docs/guides/choose-the-jj-binary.md",
        "src/content/docs/troubleshooting.md",
        "src/content/docs/quickstart.md"
      ]
    },
    {
      id: "site-deploy-no-secrets",
      title: "Published site and deploy config carry no credentials or private endpoints",
      threat: "Anyone browsing jj.smithers.sh or the public repository reads a Cloudflare or Alchemy credential, or a private host, that lets them take over the site or reach internal services.",
      lookFor: [
        "An inline token, account id paired with a key, or state-store secret in alchemy.run.ts, astro.config.mjs, or package.json scripts.",
        "A file under public/ or a docs page that embeds an API key, bearer token, internal hostname, or local absolute path from a maintainer machine.",
        "A package.json deploy or destroy script that targets prod without the stage flag or passes credentials on the command line."
      ],
      paths: ["alchemy.run.ts", "astro.config.mjs", "package.json", "public/**", "src/content/docs/**"]
    }
  ]
}
