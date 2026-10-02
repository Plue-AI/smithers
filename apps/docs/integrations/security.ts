/**
 * Security review of the site's own files: the copyable adapter snippets in
 * the synced content tree, and the config and deploy stack. The content tree
 * is generated from packages/smithers/agent/integrations/docs, so a finding
 * there is fixed upstream and resynced.
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
      title: "Published docs and examples carry no real provider credentials",
      threat: "Any reader of integrations.smithers.sh copies a live GitHub, Linear, Slack, Telegram, Google, or X token or webhook secret and acts as the owner's bot or account.",
      lookFor: [
        "A string literal shaped like a real credential (ghp_, github_pat_, lin_api_, xoxb-, xapp-, a Telegram <digits>:<35 chars> bot token, ya29., a Google client secret) in a code block or table.",
        "A snippet that inlines a token or webhook secret value instead of reading it from SMITHERS_* environment variables, Config.resolve, or the credential store."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-webhook-ingress-snippets",
      title: "Copyable webhook ingress snippets verify the exact raw bytes before trusting the payload",
      threat: "A user who copies the generic or GitHub ingress handler lets an unauthenticated internet caller forge an event that starts or signals a run, or exhaust the server with an unbounded body.",
      lookFor: [
        "An ingress snippet that routes, dispatches, or keys on a parsed payload before Channels.ingest or Webhook.verify has checked the signature over the received bytes.",
        "An HTTP handler snippet that buffers the request body without a maxBodyBytes cap and 413 refusal.",
        "A snippet or prose that re-serializes the parsed JSON before verifying, disables the timestamp freshness window, or responds 200 on a verification failure."
      ],
      paths: [
        "src/content/docs/guides/webhook-ingress.md",
        "src/content/docs/guides/github.md",
        "src/content/docs/concepts/control-plane.md",
        "src/content/docs/concepts/events-and-signals.md",
        "src/content/docs/index.md",
        "src/content/docs/testing.md",
        "src/content/docs/troubleshooting.md",
        "src/content/docs/reference/api.md"
      ]
    },
    {
      id: "docs-provider-request-snippets",
      title: "Copyable provider request snippets never build API paths or OAuth grants from untrusted strings",
      threat: "A user who copies a GitHub snippet lets a webhook payload or model output redirect an authenticated request to another repository or endpoint, or requests broader OAuth scopes than the operation needs.",
      lookFor: [
        "A snippet that interpolates an owner, repo, issue number, or comment id into a request path instead of using GitHub.Repository.requireRepositoryPath or the typed client.",
        "An OAuth snippet that skips PKCE or state, logs the code verifier or tokens, or requests scopes beyond what the GitHub operation needs."
      ],
      paths: [
        "src/content/docs/guides/github.md",
        "src/content/docs/reference/api.md"
      ]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on integrations.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or src/content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding a Cloudflare account token, API key, or state-store secret instead of reading it from the deploy environment."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    }
  ]
}
