/**
 * `security` reviews the diff against origin/main; `securityAudit` audits the
 * whole site. The content is a synced copy of
 * packages/smithers/agent/registry/docs, so the checks target what readers
 * copy and what the deploy publishes.
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
      threat: "A reader who copies a snippet from registry.smithers.sh leaks a real key or ships a flow or pack with broader authority than it needs.",
      lookFor: [
        "A token, API key, bearer header, or private URL with a real-looking value in a fenced code block.",
        "An example flow declaring `capabilities: [\"*\"]`, absolute or `..` write paths, or `effects.tier: \"sealed\"` on a writing flow while presenting it as the recommended shape.",
        "A `curl ... | sh` or similar pipe-to-shell install line."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-authority-model-accuracy",
      title: "The authority, pack confinement, and precedence docs match the conservative rules the registry enforces",
      threat: "A flow author who trusts an understated rule ships a flow or pack that runs with authority its host approves as sealed, shadows a trusted flow by name, or has one caller's cached result served to another.",
      lookFor: [
        "Text in concepts/authority.md saying an unreadable declaration, `~`, `$HOME`, `file://`, absolute, or `..` write path can be sealed or compensable.",
        "Text in concepts/authority.md saying a declared tier less conservative than the inference is accepted.",
        "Text in guides/load-packs.md or concepts/sources.md saying a pack's `flows` or `skills` path, or a symlinked entry, may resolve outside the pack root.",
        "Text saying an `installed` pack can shadow a project flow or a `local` pack flow of the same name, or that a project source can shadow a system flow.",
        "Text in guides/reuse-a-flow-result.md saying a non-sealed, `expected`-mode, reads-declaring, or delegate-naming flow has its result reused, or that the idempotency key omits the caller's `Invocation` envelope."
      ],
      paths: [
        "src/content/docs/concepts/authority.md",
        "src/content/docs/guides/load-packs.md",
        "src/content/docs/concepts/sources.md",
        "src/content/docs/guides/reuse-a-flow-result.md"
      ]
    },
    {
      id: "docs-link-integrity",
      title: "Every outbound link and editUrl points at a Smithers-owned https origin",
      threat: "An attacker who controls a typo or lapsed domain linked from the docs serves malware or phishing to readers.",
      lookFor: [
        "An `http://` link or an href to a domain other than smithers.sh subdomains, github.com/smithersai, or a named upstream project.",
        "An `editUrl` frontmatter value outside https://github.com/smithersai/smithers/."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-deploy-scope",
      title: "The site config and deploy stack publish only the static build under the registry slug",
      threat: "A change to the generated config lets a deploy publish unintended files or bind the site to another subdomain or Worker.",
      lookFor: [
        "A `slug`, `sourceDir`, or `contentDir` that differs from `registry` and `packages/smithers/agent/registry`.",
        "A new script in package.json or astro.config.mjs that runs shell commands, reads env secrets, or injects raw HTML."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json"]
    }
  ]
}
