/**
 * Security review: `security` reviews the diff against origin/main and
 * `securityAudit` audits every reviewed file. The site is static docs, so the
 * checks target what readers copy and what the deploy config exposes.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "public/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "no-live-secrets-in-examples",
      title: "Examples carry placeholders, never real provider keys or tokens",
      threat: "Anyone reading migrate.smithers.sh uses a leaked ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY to spend the owner's model credit.",
      lookFor: [
        "A `*_API_KEY=` assignment in a code block whose value is anything other than `...` or an angle-bracket placeholder.",
        "An `sk-`, `sk-ant-`, JWT or bearer-token shaped string in a page or an example report excerpt."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "redaction-claims-match-code",
      title: "Pages describe report redaction exactly as packages/smithers/migrate/src/flow/Verify.ts performs it",
      threat: "A user commits `.smithers-migrate/report.json` holding a registry token or `.env` value because a page misstated what the report redacts.",
      lookFor: [
        "A page saying verification output is captured verbatim with nothing redacted, while Verify.ts applies @smthrs/journal/Redaction to every captured stream.",
        "A redaction list naming a pattern (URL credentials, private key blocks, JWTs, provider key shapes) the migrate source does not implement."
      ],
      paths: ["src/content/docs/quickstart.md", "src/content/docs/concepts/report.md", "src/content/docs/concepts/units.md", "src/content/docs/guides/set-verification-commands.md", "src/content/docs/reference/api.md"]
    },
    {
      id: "unsafe-flags-guidance",
      title: "Pages state that --apply runs the project's own commands and that --allow-unsafe all waives unseen constructs",
      threat: "A user runs a documented `smithers-migrate --apply` on a 0.x checkout they do not trust, and its install lifecycle scripts, test script or `repoCommands.test` execute arbitrary code on their machine without any page warning them.",
      lookFor: [
        "No page stating that `--apply` spawns the project's install, format, typecheck and test commands (package manager lifecycle scripts included) on the operator's machine.",
        "A copyable command recommending `--allow-unsafe all` without stating that it also waives constructs the scan finds later.",
        "A page implying `repoCommands.test` or other repository text is run through a shell, contradicting the argv-only rule in guides/set-verification-commands.md.",
        "A `--verify-*` example that pipes, curls or evaluates remote content."
      ],
      paths: ["src/content/docs/guides/**", "src/content/docs/concepts/**", "src/content/docs/index.md", "src/content/docs/quickstart.md", "src/content/docs/troubleshooting.md", "src/content/docs/reference/api.md"]
    },
    {
      id: "static-site-no-active-content",
      title: "The site ships no third-party scripts, raw HTML, or deploy credentials",
      threat: "An attacker who controls an embedded script or link runs JavaScript in readers' browsers on migrate.smithers.sh, or a committed deploy secret lets anyone repoint the site.",
      lookFor: [
        "A `<script>`, `<iframe>`, `javascript:` URL or inline event handler in Markdown or `public/`.",
        "A Cloudflare API token or alchemy state secret written into alchemy.run.ts, astro.config.mjs or package.json instead of read from the environment.",
        "A link or frontmatter `editUrl` whose host is not github.com/smithersai or a smithers.sh domain."
      ]
    }
  ]
}
