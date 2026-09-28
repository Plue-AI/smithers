/**
 * Security review: `security` reviews the diff against origin/main and
 * `securityAudit` audits every reviewed file. The site is static docs, so the
 * checks cover what readers copy: credentials in examples, gateway exposure
 * guidance, and the deploy stack.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: [
    "src/**",
    "public/**",
    "astro.config.mjs",
    "alchemy.run.ts",
    "package.json",
    "tsconfig.json"
  ],
  checks: [
    {
      id: "example-credentials",
      title: "Examples carry only placeholder bearer tokens and read real ones from the environment",
      threat: "A reader who copies an example ships a real or guessable gateway bearer, letting anyone who reads the docs call their gateway.",
      lookFor: [
        "A literal bearer, API key, or token value in a curl `Authorization` header instead of `$SMITHERS_TOKEN` or `<token>`.",
        "A `credential:` value in a TypeScript example that is a string literal rather than `process.env.SMITHERS_TOKEN`.",
        "A token passed as a command-line argument in a `smthrs serve` example, where it lands in shell history and `ps` output."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "exposure-guidance",
      title: "Gateway hosting guidance keeps a non-loopback bind behind listen opt-in, a bearer, and TLS",
      threat: "An operator who follows a guide exposes their workspace gateway, its runs, and its approvals to the network without authentication or over cleartext.",
      lookFor: [
        "An example that binds `0.0.0.0` or a LAN address without both `listen` opt-in and a bearer credential.",
        "A curl or WebSocket example that sends a bearer over `http://` or `ws://` to a non-loopback host.",
        "Text that tells readers to delegate approve or deny to `gateway/bearer` without stating that every bearer holder then approves.",
        "Text that says the Host or Origin checks can be disabled, or that `/health` exposes a token, run, or path."
      ],
      paths: [
        "src/content/docs/guides/serve-beyond-loopback.md",
        "src/content/docs/guides/host-the-gateway.md",
        "src/content/docs/guides/follow-a-run.md",
        "src/content/docs/guides/submit-an-approval.md",
        "src/content/docs/concepts/trust-boundary.md",
        "src/content/docs/troubleshooting.md",
        "src/content/docs/quickstart.md",
        "src/content/docs/index.md"
      ]
    },
    {
      id: "security-claims-match-code",
      title: "Every security guarantee the docs state holds in @smthrs/gateway's code",
      threat: "An operator relies on a documented guarantee the gateway does not enforce, and exposes runs, approvals, or backend errors to a network caller.",
      lookFor: [
        "A claim that the bearer cannot approve or deny by default that `packages/smithers/gateway/src` or the control ApprovalAuthority default contradicts.",
        "A claim that `/health` returns identity only, or that projection logs omit backend messages, SQL, credentials, and paths, that the handler or logger code contradicts.",
        "A claim that a cursor resumes only the exact selector, run, and partition that issued it, where the cursor decoder accepts a forged or cross-run cursor.",
        "A claim that a credential-less gateway accepts only loopback Host and Origin values where the ingress check allows another host."
      ],
      paths: [
        "src/content/docs/concepts/**",
        "src/content/docs/guides/**",
        "src/content/docs/troubleshooting.md",
        "src/content/docs/quickstart.md",
        "src/content/docs/reference/api.md"
      ]
    },
    {
      id: "static-deploy-stack",
      title: "The site deploys as a static bundle with no inlined secrets or dynamic endpoints",
      threat: "A committer or compromised dependency gets account credentials or server-side code into the public gateway.smithers.sh deploy.",
      lookFor: [
        "A Cloudflare or Alchemy token or password literal in `alchemy.run.ts`, `astro.config.mjs`, or `package.json` scripts.",
        "A `makeDocsSiteStack` or `defineDocsSite` call whose slug or source directory differs from `gateway`, publishing another package's content under this domain.",
        "A new dependency, script hook, or Astro adapter that adds server-side rendering or runs code at install time."
      ],
      paths: ["alchemy.run.ts", "astro.config.mjs", "package.json"]
    }
  ]
}
