/**
 * `security` reviews the diff against origin/main; `securityAudit` audits the
 * whole site. The content tree is a synced copy of @smthrs/flow's docs, so a
 * finding there is fixed in packages/smithers/flows/flow/docs and resynced.
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
      title: "Published docs and examples carry no real credentials",
      threat: "Any reader of flow.smithers.sh copies a live API key, gateway key, or signing secret from a snippet and spends or impersonates the owner's account.",
      lookFor: [
        "A string literal shaped like a real key (sk-, sk-ant-, ghp_, xox, AKIA, long base64 or hex) inside a fenced code block or table.",
        "A layer or runtime snippet that inlines a credential value instead of reading it from configuration."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-completion-token-authority",
      title: "Docs never present a derivable completion token as proof of authority",
      threat: "An integrator who follows the guides exposes an endpoint that completes any run's approval or wait point for anyone who knows the flow name and execution id, letting an outsider approve a release on the owner's behalf.",
      lookFor: [
        "A guide showing DurableDeferred.tokenFromExecutionId or tokenFromPayload feeding HumanTask.answer or DurableDeferred.succeed from caller input with no statement that the caller must be authenticated and authorized first.",
        "Text calling a completion token secret, unguessable, or sufficient to authorize an answer, when it encodes only the flow name, execution id, and deferred name."
      ],
      paths: [
        "src/content/docs/guides/ask-a-person.md",
        "src/content/docs/guides/wait-for-an-external-signal.md",
        "src/content/docs/guides/queue-work-to-a-worker.md",
        "src/content/docs/testing.md",
        "src/content/docs/reference/**"
      ]
    },
    {
      id: "docs-authority-envelope-claims",
      title: "Documented capability and effect enforcement matches what Graph.build actually refuses",
      threat: "A flow author trusts a documented capability or effect ceiling to confine a model-invocable flow, and a composition the docs call refused runs with the wider authority against the author's repository or credentials.",
      lookFor: [
        "A claim that capability_outside_grant blocks a call, when the reference says it is advisory and the call runs with the capability dropped.",
        "A snippet declaring modelInvocable, capabilities, or effects as computed values instead of literals, or omitting modelInvocable where the text says a model cannot invoke the flow (the default is true)."
      ],
      paths: ["src/content/docs/reference/**", "src/content/docs/concepts/flows-and-actions.md", "src/content/docs/guides/implement-an-action.md"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on flow.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an API token or state-store secret instead of the shared kit's environment reads.",
        "src/styles CSS pulling a remote @import or url() from an origin outside the site, which lets that origin track or restyle every visitor."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts", "src/styles/**"]
    }
  ]
}
