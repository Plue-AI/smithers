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
      id: "docs-snippet-safety",
      title: "Published code snippets carry no live credentials and no unsafe patterns readers copy",
      threat: "A reader who copies a snippet from testing.smithers.sh leaks a real key or ships an unsafe test harness into their own repository.",
      lookFor: [
        "A token, API key, bearer header, or private URL with a real-looking value in a fenced code block.",
        "A `curl ... | sh` or similar pipe-to-shell install line.",
        "A host-certification or fault-injection example that binds a non-loopback address or kills processes by name rather than by the spawned pid."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-fixture-secret-guidance",
      title: "Replay-fixture guides warn that recorded model exchanges may hold credentials or user content before telling readers to commit them",
      threat: "A reader following the record-then-commit steps pushes a fixture JSON containing their provider key, auth header, or private prompt content to a public repository.",
      lookFor: [
        "A `git add` or \"Commit the JSON file\" step in guides/replay-a-model.md or concepts/fixtures.md with no note that each recorded call stores the full request (messages, tool inputs), which may carry credentials or user content.",
        "Text claiming fixtures are redacted or secret-free that the @smthrs/testing API reference does not back."
      ],
      paths: ["src/content/docs/guides/replay-a-model.md", "src/content/docs/concepts/fixtures.md", "src/content/docs/reference/api.md"]
    },
    {
      id: "docs-link-integrity",
      title: "Every outbound link and editUrl points at a Smithers-owned https origin",
      threat: "An attacker who controls a typo or lapsed domain linked from the docs serves malware or phishing to readers.",
      lookFor: [
        "An `http://` link outside a loopback example, or an href to a domain other than smithers.sh subdomains, github.com/smithersai, or a named upstream project.",
        "An `editUrl` frontmatter value outside https://github.com/smithersai/smithers/."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-deploy-scope",
      title: "The site config and deploy stack publish only the static build under the testing slug",
      threat: "A change to the generated config lets a deploy publish unintended files or bind the site to another subdomain or Worker.",
      lookFor: [
        "A `slug`, `sourceDir`, or `contentDir` that differs from `testing` and `packages/testing`.",
        "A package.json script other than the astro, sync-content, and alchemy plan/deploy/destroy commands, or a deploy/destroy script whose `--stage` is not `prod`.",
        "A `head` entry, custom component, or remote script/style origin added to astro.config.mjs that the shared defineDocsSite kit does not supply."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json"]
    }
  ]
}
