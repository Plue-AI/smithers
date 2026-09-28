/**
 * Security review of the site: diff review (`security`) and full audit
 * (`securityAudit`).
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "public/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "key-not-a-credential",
      title: "Docs never present a derived key as secret, authenticating, or safe for credentials",
      threat: "An integrator who trusts an overstated page uses a flow key as a bearer token or keys a cache on a credential, letting one caller replay or read another caller's work.",
      lookFor: [
        "Text claiming a key authenticates its holder, hides its input, or is safe to derive from a password or other low-entropy secret.",
        "The key-material warning that a Redacted value canonicalizes to \"<redacted>\" and collapses distinct credentials into one key removed or softened.",
        "A snippet that puts a Redacted, token, or password field into key material or accepts a presented key as proof of knowledge."
      ],
      paths: [
        "src/content/docs/concepts/**",
        "src/content/docs/guides/**",
        "src/content/docs/index.md",
        "src/content/docs/reference/api.md"
      ]
    },
    {
      id: "failure-cause-logging",
      title: "Failure-handling guidance keeps secret-bearing causes out of logs",
      threat: "An operator who follows the failure guide logs `cause`, leaking property names or throwing-getter messages that carry a customer's secret into shared logs.",
      lookFor: [
        "Text saying `cause` is always safe to log, or dropping the caveat that it names JSON paths and getter messages.",
        "An example that logs or returns the full error or `cause` to an HTTP client without the redaction decision the guide requires.",
        "Illustrative secrets such as `password=hunter2` presented as real values rather than a marked example."
      ],
      paths: [
        "src/content/docs/guides/handle-a-derivation-failure.md",
        "src/content/docs/guides/validate-a-stored-key.md",
        "src/content/docs/troubleshooting.md"
      ]
    },
    {
      id: "site-deploy-no-secrets",
      title: "Published site and deploy config carry no credentials or private endpoints",
      threat: "Anyone browsing keys.smithers.sh or the public repository reads a Cloudflare or Alchemy credential, or a private host, that lets them take over the site or reach internal services.",
      lookFor: [
        "An inline API token, API key, or state-store secret in alchemy.run.ts, astro.config.mjs, or package.json scripts.",
        "A file under public/ or a docs page that embeds an API key, bearer token, internal hostname, or local absolute path from a maintainer machine.",
        "A package.json deploy or destroy script that targets prod without the stage flag or passes credentials on the command line."
      ],
      paths: ["alchemy.run.ts", "astro.config.mjs", "package.json", "public/**", "src/content/docs/**"]
    }
  ]
}
