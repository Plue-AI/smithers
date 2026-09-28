/**
 * Security review: `security` reviews the diff against origin/main,
 * `securityAudit` audits the whole site. The site is static docs, so the
 * checks target snippets readers copy and the deploy config this package owns.
 * src/content/docs is synced from packages/smithers/flows/sandbox/docs, so a
 * content finding is fixed there and re-synced with contentSync.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "snippet-credentials",
      title: "Doc snippets never embed a real or realistic credential",
      threat: "Anyone reading sandbox.smithers.sh reuses a leaked Vercel, Microsandbox, or model token to run machines billed to its owner.",
      lookFor: [
        "A code block that passes a literal `token`, `oidcToken`, `teamId`, or `MSB_API_KEY` value instead of reading it from `options.env` or a placeholder.",
        "A string shaped like a real key (sk-, ghp_, vercel_, a JWT, a PEM body) anywhere in the content tree."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "snippet-isolation-defaults",
      title: "Copyable snippets keep the sandbox's isolation defaults unless the text names the risk",
      threat: "A developer who copies a snippet runs untrusted agent commands on the host, a hosted backend, or an open network without knowing it.",
      lookFor: [
        "A snippet using `backend: \"any\"`, `DirectorySandbox`, `JustBashSandbox`, or `shell: true` with interpolated caller input and no adjacent sentence stating the weaker boundary.",
        "A snippet that omits `network: \"none\"`, a `network: { allow }` allowlist, or a deny-by-default `networkPolicy` while the prose claims the machine is isolated from the network.",
        "A command line built by string concatenation in an example rather than an argv array."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "security-claims-match-limits",
      title: "Documented security guarantees state their limits",
      threat: "An operator trusts a snapshot scrub or reaper guarantee the code does not provide and ships credentials into every restored machine.",
      lookFor: [
        "Snapshot capture text that drops the stated limits: raw-byte match only, secrets under 8 bytes refused, removal only under /root and /home/*.",
        "Isolation or reap text that claims a boundary (VM, network, owner label) stronger than concepts/isolation.md and reference/api.md assign to that provider."
      ],
      paths: ["src/content/docs/concepts/**", "src/content/docs/reference/**", "src/content/docs/guides/**"]
    },
    {
      id: "deploy-config-no-secrets",
      title: "The site config and Alchemy stack carry no secrets and deploy only static assets",
      threat: "A repository reader obtains Cloudflare or Alchemy state credentials, or a config change ships a worker that exposes more than the built dist.",
      lookFor: [
        "A literal API token or state-store password in alchemy.run.ts or astro.config.mjs rather than in makeDocsSiteStack's environment lookup.",
        "A config option added here that turns the static site into SSR, adds worker vars, or serves files outside dist."
      ],
      paths: ["alchemy.run.ts", "astro.config.mjs", "package.json"]
    }
  ]
}
