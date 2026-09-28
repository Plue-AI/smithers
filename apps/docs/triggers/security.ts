/**
 * Security review of the site's config, deploy stack, and synced content.
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
      title: "Published docs and examples carry no real webhook secrets or credentials",
      threat: "Any reader of triggers.smithers.sh copies a live webhook signing secret, provider key, or Control token and forges inbound requests or spends the owner's account.",
      lookFor: [
        "A string literal shaped like a real key or signing secret (sk-, ghp_, whsec_, xox, AKIA, long base64/hex) inside a fenced code block or table.",
        "A Webhook.Config credential or SignatureConfig.expected snippet that inlines the secret value instead of resolving it from a credential source."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-webhook-verification-guidance",
      title: "Webhook guidance never teaches weakening signature verification",
      threat: "An integrator who follows the troubleshooting or quickstart text accepts unauthenticated HTTP requests that start or signal their flows.",
      lookFor: [
        "Text or a snippet suggesting an `expected` that returns a constant, the header value itself, or skips the credential to get past verification_failed.",
        "Guidance that contradicts the package contract that zero-length expected bytes are refused and that a verified payload carries no execution authority.",
        "A refusal message documented as echoing the expected signature or credential back to the sender.",
        "An ingest example whose idempotencyKey comes from an unsigned request header, so a captured signed body replayed with a fresh delivery id starts the flow again, with no warning to bind the key or a timestamp into the signed bytes.",
        "A comparison snippet that uses === or Buffer.equals on signature bytes instead of Webhook.constantTimeEqual."
      ],
      paths: [
        "src/content/docs/troubleshooting.md",
        "src/content/docs/index.md",
        "src/content/docs/quickstart.md",
        "src/content/docs/guides/ingest-a-webhook.md",
        "src/content/docs/concepts/channels.md"
      ]
    },
    {
      id: "docs-unbounded-trigger-examples",
      title: "Copyable trigger examples keep catch-up and retries bounded",
      threat: "A user who copies a quickstart trigger replays an unbounded backlog of missed boundaries after downtime and launches runs that spend their model budget.",
      lookFor: [
        "A snippet with catchUp other than \"none\" and no maxCatchUp, or a maxCatchUp presented as unlimited.",
        "A Runner example whose start ignores idempotencyKey, teaching duplicate launches on claim recovery."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on triggers.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an account id, API token, or state-store secret instead of the shared kit's environment reads."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    }
  ]
}
