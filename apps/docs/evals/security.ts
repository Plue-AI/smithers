/**
 * Security review of the site's owned config and synced content. Content
 * findings are fixed upstream in packages/smithers/agent/evals/docs, then
 * resynced.
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
      title: "Published eval docs and examples carry no real credentials",
      threat: "Any reader of evals.smithers.sh copies a live provider API key or gateway token from an executor or CI snippet and spends the owner's account.",
      lookFor: [
        "A string literal shaped like a real key (sk-, sk-ant-, ghp_, xox, AKIA, long base64/hex) inside a fenced code block, fixture line, or table.",
        "A CaseExecutor or CI YAML snippet that inlines a key value instead of reading it from an environment variable or CI secret."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "report-output-leak",
      title: "Docs keep warning that reports embed unredacted case output",
      threat: "A user who follows the CI guide prints Report.markdown or Report.json into a public CI log and leaks secrets their cases or agent outputs carried.",
      lookFor: [
        "The 'Nothing redacts the output embedded in a report' warning removed from gate-a-run-in-ci.md, or the 'redacts nothing' notes removed from reference/api.md, troubleshooting.md, or concepts/determinism.md.",
        "A snippet that uploads Report.json as a public artifact or posts it to a PR comment without mentioning that case output is embedded verbatim."
      ],
      paths: [
        "src/content/docs/guides/gate-a-run-in-ci.md",
        "src/content/docs/reference/api.md",
        "src/content/docs/quickstart.md",
        "src/content/docs/troubleshooting.md",
        "src/content/docs/concepts/determinism.md"
      ]
    },
    {
      id: "gate-bypass-snippets",
      title: "Copyable CI snippets cannot silently pass a regressed run",
      threat: "A contributor whose change regresses a flow gets a green CI gate because the documented script re-records the baseline or swallows the verdict.",
      lookFor: [
        "A CI snippet that runs the gate script with --update, or a baseline-recording example without the refuse-on-failed-case guard.",
        "A Gate.check example whose catch maps a ScoreGateError or Inconclusive verdict to exit code 0, or that ignores Gate.ciGrade's exitCode.",
        "A Baseline.load example reading a path taken from the case input or an environment variable rather than the committed baseline file."
      ],
      paths: ["src/content/docs/guides/**", "src/content/docs/quickstart.md", "src/content/docs/index.md"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config and deploy stack add no raw HTML, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on evals.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an account id, API token, or state-store secret instead of the shared kit's environment reads."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts"]
    },
    {
      id: "synced-markdown-html",
      title: "Synced markdown renders no active HTML on evals.smithers.sh",
      threat: "A contributor to packages/smithers/agent/evals/docs gets script executed in every visitor's browser, because Astro renders raw HTML in synced markdown verbatim.",
      lookFor: [
        "A raw <script>, <iframe>, <object>, or <embed> tag, or an on* event attribute, outside a fenced code block in a synced .md file.",
        "A markdown link or image whose target uses a javascript: or data: scheme."
      ],
      paths: ["src/content/docs/**"]
    }
  ]
}
