/**
 * Security review of the site's content, config, and deploy stack: `security`
 * on the diff, `securityAudit` in full.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "alchemy.run.ts", "astro.config.mjs", "package.json"],
  checks: [
    {
      id: "copyable-snippet-safety",
      title: "Code snippets readers copy teach argv spawns and volume-rooted paths, not injectable shells",
      threat: "A developer who copies a guide snippet into a page lets a hostile token or path run as just-bash syntax or reach files outside the mounted volume.",
      lookFor: [
        "A snippet that passes `shell: true` or builds a command string from user or page input instead of a StandardCommand argv.",
        "A snippet that joins an untrusted path onto the mount without the volume-root resolution work-with-files.md describes.",
        "Prose that claims `shell` quotes arguments, contradicting run-a-command.md's verbatim-join statement."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "isolation-attestation-guidance",
      title: "Docs grant the kernel isolation attestation only to a volume the workspace occupies whole",
      threat: "A developer who follows a guide composes BrowserFileSystem.layer over a shared or host filesystem, so a flow's kernel grant reaches files outside its workspace through a symlink or a sibling workspace.",
      lookFor: [
        "A snippet that passes node:fs/promises, a rooted host adapter, or a shared mount to BrowserFileSystem.layer, BrowserServices.layer, or BrowserHost.layer outside a test.",
        "Prose that permits a workspaceRoot or jj.root other than the mount root `/` under the attestation, or several workspaces on one mount.",
        "Prose that says realPath may echo its input or that the kernel skips re-resolution after a grant."
      ],
      paths: ["src/content/docs/concepts/**", "src/content/docs/guides/compose-the-host.md", "src/content/docs/guides/work-with-files.md"]
    },
    {
      id: "no-secrets-in-content",
      title: "Published docs and examples contain no live credentials or private hosts",
      threat: "Anyone reading platform-browser.smithers.sh obtains a real token, key, or internal endpoint pasted into a guide.",
      lookFor: [
        "A string shaped like an API key, bearer token, PAT, or private key in a Markdown page or code fence.",
        "An internal hostname, bucket, or account id in content that should be a placeholder."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "deploy-stack-scope",
      title: "The site builds and deploys as static assets through the shared kit only",
      threat: "A change to the site config or Alchemy stack lets a docs deploy ship server code, secret bindings, or a different slug over another package's site.",
      lookFor: [
        "alchemy.run.ts passing bindings, env, or a slug other than \"platform-browser\" to makeDocsSiteStack.",
        "astro.config.mjs adding an SSR adapter, integration, or remote script beyond defineDocsSite.",
        "package.json scripts that deploy a stage other than prod or run a network fetch outside alchemy and astro."
      ],
      paths: ["alchemy.run.ts", "astro.config.mjs", "package.json"]
    }
  ]
}
