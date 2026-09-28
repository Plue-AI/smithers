/**
 * Security review of the site: the rendered guides users copy into deployed
 * Workers, and the config and IaC that publish create-app.smithers.sh.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "public/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "public-model-route-auth",
      title: "Deploy guidance never ships a model-calling route to the public internet without a guard",
      threat:
        "An anonymous internet caller drives POST /api/turn on a reader's deployed app and spends the reader's provider key.",
      lookFor: [
        "A deploy or quickstart page that has the reader run `pnpm deploy` for the default template without requiring an auth guard on /api/turn.",
        "A statement that only the aomi template needs APP_API_TOKEN while the default template's /api/turn also runs a paid seat.",
        "A host-a-turn snippet that wires turnResponse to a public route with no caller check or rate limit."
      ],
      paths: [
        "src/content/docs/guides/deploy-to-cloudflare.md",
        "src/content/docs/guides/host-a-turn.md",
        "src/content/docs/reference/templates.md",
        "src/content/docs/reference/api.md",
        "src/content/docs/quickstart.md"
      ]
    },
    {
      id: "copied-secret-handling",
      title: "Copyable snippets keep provider keys and API tokens out of committed files",
      threat:
        "A reader who copies a snippet commits ANTHROPIC_API_KEY, OPENAI_API_KEY, or APP_API_TOKEN to git or ships APP_API_OPEN=1 to production.",
      lookFor: [
        "A key or token placed in wrangler.jsonc `vars`, PACKAGE.ts, AGENT.ts, or a committed .env instead of `wrangler secret put` or the gitignored .dev.vars.",
        "APP_API_OPEN presented as anything but a local .dev.vars opt-in.",
        "A literal credential-shaped string (sk-, sk-ant-, a 32+ char hex token) in a code block."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "site-content-injection",
      title: "The static site renders only first-party content and assets",
      threat:
        "A contributor or a poisoned source doc injects script into create-app.smithers.sh and runs it in every reader's browser.",
      lookFor: [
        "A raw <script>, <iframe>, inline event handler, or javascript: link inside a Markdown page.",
        "A third-party script, font, or analytics host added to astro.config.mjs or starlight.css.",
        "An SVG or HTML file under public/ that carries script."
      ],
      paths: ["src/content/docs/**", "src/styles/**", "public/**", "astro.config.mjs"]
    },
    {
      id: "deploy-stack-scope",
      title: "The IaC stack publishes only this site's Worker and domain",
      threat:
        "A change to alchemy.run.ts rebinds another smithers.sh hostname or embeds a Cloudflare credential in source.",
      lookFor: [
        "alchemy.run.ts passing a slug, domain, or zone other than create-app, or an inline API token.",
        "A package.json script that deploys a stage other than prod or runs an unpinned remote script."
      ],
      paths: ["alchemy.run.ts", "package.json"]
    }
  ]
}
