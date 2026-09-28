/**
 * Security review of the site config, deploy stack, and the published error-
 * handling guidance.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "docs-redaction-guidance",
      title: "Error-handling guides never teach logging or showing an unredacted credential",
      threat: "A developer who copies a guide logs or replies with an error whose details, cause, or message holds a bot token, API key, or webhook secret, exposing it to anyone who reads the log or chat.",
      lookFor: [
        "A snippet that attaches a raw provider response, request URL, or fetch cause to details or cause without passing it through redactBotToken or an equivalent redactor first.",
        "A snippet that logs error.message, error.cause, or the whole error object, or sends it to a chat reply, where the surrounding text does not say the value was redacted.",
        "Prose claiming SmithersError or an adapter redacts a field that the redaction-contract section says the class stores verbatim."
      ],
      paths: ["src/content/docs/guides/**", "src/content/docs/concepts/error-shape.md", "src/content/docs/quickstart.md", "src/content/docs/reference/**"]
    },
    {
      id: "docs-forgeable-error-checks",
      title: "Guides present hasSmithersErrorShape as forgeable and never as a trust decision",
      threat: "A developer who follows a guide grants a retry, approval, or privileged branch to any object an attacker-controlled payload shapes like a SmithersError.",
      lookFor: [
        "A snippet that gates retry, authorization, or a side effect on hasSmithersErrorShape or a name/code string check applied to a value decoded from untrusted JSON or a webhook body.",
        "Text that omits the structural check's stated limit that a plain Error with the four fields passes it."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on errors.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or src/content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "Raw HTML in a Markdown page (a <script>, <iframe>, on* handler, or javascript: link) that Astro renders into the page unescaped.",
        "alchemy.run.ts or package.json scripts embedding an API token or state-store secret instead of the shared kit's environment reads.",
        "A fenced code block in src/content/docs holding a string shaped like a real key (a Telegram bot token <digits>:<35 chars>, sk-, ghp_, AKIA)."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts", "src/content/docs/**"]
    }
  ]
}
