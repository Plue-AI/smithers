/**
 * Security review of the site's own files: the synced @smthrs/control guides
 * users copy, and the site and deploy config. The macro appends `general`.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "astro.config.mjs", "alchemy.run.ts"],
  checks: [
    {
      id: "rpc-snippet-auth",
      title: "Copyable RPC snippets keep authentication on and the server on loopback",
      threat: "An operator who copies a guide snippet exposes the control plane so any network caller can plan, approve, or run flows.",
      lookFor: [
        "A server snippet that provides layerNoopAuth or a custom layerAuth that succeeds without checking a header.",
        "A server snippet that binds host 0.0.0.0 or a public address instead of 127.0.0.1.",
        "A client snippet that puts the bearer credential in a URL query string or sends it over ws:// or http:// to a non-loopback host.",
        "Prose that claims an empty or missing token authenticates, contradicting fail-closed bearer auth."
      ],
      paths: ["src/content/docs/guides/**", "src/content/docs/quickstart.md", "src/content/docs/troubleshooting.md", "src/content/docs/reference/api.md"]
    },
    {
      id: "webhook-verify-first",
      title: "The webhook guide verifies the signature before decoding and never fingerprints credential headers",
      threat: "A forger who follows a weakened guide gets an unsigned request turned into a control mutation, or replays a delivery past idempotency.",
      lookFor: [
        "A snippet or step order that decodes or trusts the body before `verify` runs on the raw bytes.",
        "A `fingerprintHeaders` example that lists a signature, authorization, cookie, or token header.",
        "A `verify` example that returns success unconditionally or compares signatures with `===`.",
        "A `deliveryId` taken from the request body instead of the platform's delivery header."
      ],
      paths: ["src/content/docs/guides/ingest-a-webhook.md"]
    },
    {
      id: "credential-snippets-no-secrets",
      title: "Credential and approval examples carry references, never secret values",
      threat: "A reader who copies an example leaks a connection secret into flow input, journals, or model context, or treats an approval token as authentication.",
      lookFor: [
        "A literal API key, bearer token, private key, or password in any code block.",
        "An example that passes a resolved secret in flow payload instead of a CredentialRef.",
        "An example that uses `layerNoop` cipher outside a test context.",
        "Prose that presents an approval token as an authentication credential."
      ],
      paths: ["src/content/docs/guides/store-credentials.md", "src/content/docs/guides/durable-storage.md", "src/content/docs/guides/approvals.md", "src/content/docs/concepts/**"]
    },
    {
      id: "no-active-html",
      title: "Synced markdown renders no script, iframe, or event-handler HTML on control.smithers.sh",
      threat: "A contributor who lands raw HTML in @smthrs/control's docs runs script in every reader's browser on the smithers.sh docs origin.",
      lookFor: [
        "A <script>, <iframe>, <object>, <embed>, or <form> element in a markdown file.",
        "An HTML attribute starting with on (onclick, onerror) or a javascript: or data: URL in a link or image."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "site-deploy-config",
      title: "Site and deploy config hold no account secrets and deploy only the prod docs stack",
      threat: "Anyone reading the public repository takes a Cloudflare token or account id, or a changed config deploys over another site's worker.",
      lookFor: [
        "A literal Cloudflare API token, account id, or state-store credential in alchemy.run.ts or astro.config.mjs.",
        "A slug other than \"control\" passed to makeDocsSiteStack or defineDocsSite.",
        "A contentDir or sourceDir that points outside this site or packages/smithers/control."
      ],
      paths: ["alchemy.run.ts", "astro.config.mjs"]
    }
  ]
}
