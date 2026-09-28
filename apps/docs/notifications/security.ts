/**
 * Security review of the site's own files: the published docs pages, public
 * assets, and deploy config. `security` reviews the diff against origin/main;
 * `securityAudit` audits every included file.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "public/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "webhook-credential-handling",
      title: "Webhook docs keep sink credentials out of urls, errors, logs, and redirect targets",
      threat: "An integrator who copies an overstated webhook page leaks the pager bearer token or basic-auth url to a redirect target, a journal record, or a shared log.",
      lookFor: [
        "The statements that the sink forces `redirect: \"manual\"`, fails a 3xx with `sink_rejected`, and never forwards credentials removed or softened.",
        "The statement that `AlertError` and `sink_misconfigured` name no url and never carry the request removed, or an example that logs the url or headers.",
        "A snippet that hardcodes a real-looking bearer token or embeds credentials in the webhook url instead of a parameter.",
        "Text allowing a non-http(s) endpoint or an injected `HttpClient.followRedirects` client to carry the credential."
      ],
      paths: [
        "src/content/docs/guides/send-alerts-to-a-webhook.md",
        "src/content/docs/installation.md",
        "src/content/docs/reference/api.md",
        "src/content/docs/troubleshooting.md"
      ]
    },
    {
      id: "steer-provenance-and-payloads",
      title: "Steering docs keep untrusted payloads from reaching the model as operator instructions",
      threat: "A webhook sender or other untrusted source that can admit a notification gets its payload rendered to a run's model as an operator steer, hijacking another user's run.",
      lookFor: [
        "Text or a snippet that lets a caller-supplied `provenance.sourceActor` stand in for an authenticated operator without saying the caller must authorize it.",
        "The rule that `SteerPayload.decode` answers `undefined` for webhook bodies and system-event payloads removed, or an example that renders any payload as a Message.",
        "An example that admits a steer from a request body without checking who may steer that run.",
        "The `notification_id_reused` refusal for same id with different content described as an overwrite."
      ],
      paths: [
        "src/content/docs/guides/steer-a-run.md",
        "src/content/docs/guides/drain-at-a-turn-boundary.md",
        "src/content/docs/concepts/admission-and-promotion.md",
        "src/content/docs/reference/api.md"
      ]
    },
    {
      id: "redaction-claims",
      title: "Journal redaction docs never claim redacted values are recoverable or absent from identity",
      threat: "An operator who trusts the page stores a secret in a notification payload and expects it gone, while it still decides id reuse or reaches readers of the journal.",
      lookFor: [
        "The statement that identity hashes canonical JSON before redaction and that redacted originals cannot be recovered removed or contradicted.",
        "A page claiming notification payloads or journal records are safe for credentials without naming the redaction step."
      ],
      paths: [
        "src/content/docs/reference/api.md",
        "src/content/docs/concepts/journal-records.md",
        "src/content/docs/guides/report-pending-notifications.md"
      ]
    },
    {
      id: "site-deploy-no-secrets",
      title: "Published site and deploy config carry no credentials or private endpoints",
      threat: "Anyone browsing notifications.smithers.sh or the public repository reads a Cloudflare or Alchemy credential, or a private host, that lets them take over the site or reach internal services.",
      lookFor: [
        "An inline token, account id paired with a key, or state-store secret in alchemy.run.ts, astro.config.mjs, or package.json scripts.",
        "A file under public/ or a docs page that embeds an API key, bearer token, internal hostname, or local absolute path from a maintainer machine.",
        "A package.json deploy or destroy script that targets prod without the stage flag or passes credentials on the command line."
      ],
      paths: ["alchemy.run.ts", "astro.config.mjs", "package.json", "public/**", "src/content/docs/**"]
    },
    {
      id: "published-page-active-content",
      title: "Synced pages and site styles load no script, frame, or third-party resource",
      threat: "A contributor who edits the upstream package docs ships script or a tracking resource that runs in every notifications.smithers.sh visitor's browser.",
      lookFor: [
        "Raw HTML in a synced page: a `<script>`, `<iframe>`, `on*=` handler attribute, or `javascript:` link outside a code fence.",
        "An `editUrl` frontmatter value that points anywhere but github.com/smithersai/smithers.",
        "A CSS `@import` or `url(...)` in src/styles that loads from a third-party origin.",
        "A content collection loader or schema in src/content.config.ts replaced with one that reads outside src/content/docs."
      ],
      paths: ["src/content/docs/**", "src/styles/**", "src/content.config.ts"]
    }
  ]
}
