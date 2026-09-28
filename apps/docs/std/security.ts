/**
 * Security review of the std site: published snippets, security-claim
 * fidelity, links, and the deploy stack.
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
      title: "Published shell, network, and file snippets carry no live credentials and no unsafe defaults readers copy",
      threat: "A reader who copies a std.smithers.sh snippet leaks a real key or runs a flow that exposes host secrets or writes outside its workspace.",
      lookFor: [
        "A token, API key, bearer header, or private URL with a real-looking value in a fenced code block.",
        "A `Bash.run` or `shell_command` example that declares a credential-shaped name in `env` or uses `mode: \"unhermetic\"` without saying why.",
        "A `fetch`/HTTP example that sends an `authorization` or `cookie` header to a non-example host, or a `curl ... | sh` line."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-security-claims",
      title: "Security guarantees stated in the docs match the @smthrs/std behavior and never overstate isolation",
      threat: "A flow author trusts a documented guarantee the code does not provide and runs an untrusted command or URL against host secrets or internal networks.",
      lookFor: [
        "Text calling hermetic mode a sandbox, or dropping the \"lexical pre-check, not a sandbox\" caveat in effects-and-capabilities.md or run-a-shell-command.md.",
        "An env allowlist in run-a-shell-command.md that differs from PATH, HOME, USER, LANG, LC_*, TERM, TMPDIR, SHELL, or omits that undeclared provider keys are withheld.",
        "A redirect claim in reach-the-network.md other than: at most 10 redirects, and a cross-origin hop drops `authorization` and `cookie`.",
        "A limit or timeout in limits-and-disclosure.md that is larger or unbounded compared to the stated constants."
      ],
      paths: ["src/content/docs/concepts/**", "src/content/docs/reference/**", "src/content/docs/guides/run-a-shell-command.md", "src/content/docs/guides/reach-the-network.md", "src/content/docs/troubleshooting.md"]
    },
    {
      id: "docs-link-integrity",
      title: "Every outbound link and editUrl points at a Smithers-owned or named upstream https origin",
      threat: "An attacker who controls a typo or lapsed domain linked from the docs serves malware or phishing to readers.",
      lookFor: [
        "An `http://` link or an href to a domain other than smithers.sh subdomains, github.com/smithersai, effect.website, or example.com placeholders.",
        "An `editUrl` frontmatter value outside https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/std/docs/."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-raw-html",
      title: "Synced Markdown renders no script, event handler, iframe, or javascript: URL on std.smithers.sh",
      threat: "A contributor to packages/smithers/agent/std/docs lands raw HTML that Astro renders unescaped, running script in every reader's browser on a smithers.sh origin.",
      lookFor: [
        "A `<script>`, `<iframe>`, `<object>`, `<embed>`, or `<form>` tag outside a fenced code block.",
        "An `on*=` attribute or a `javascript:`/`data:` URL in inline HTML or a Markdown link target."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "docs-deploy-scope",
      title: "The site config and deploy stack publish only the static build under the std slug",
      threat: "A change to the generated config lets a deploy publish unintended files or bind the site to another subdomain or Worker.",
      lookFor: [
        "A `slug`, `sourceDir`, or `contentDir` that differs from `std` and `packages/smithers/agent/std`.",
        "A package.json script beyond astro, alchemy, and ../shared/sync-content.mjs, or one that reads env secrets or pipes a download into a shell.",
        "A `head` entry, integration, or plugin added in astro.config.mjs that loads a third-party script or injects raw HTML into every page."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json"]
    }
  ]
}
