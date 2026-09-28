/**
 * Security review of the site: the synced MCP guides users copy into their own
 * code and config, and the generated deploy and site config.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "public/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "no-real-credentials",
      title: "Published MCP examples carry only placeholder credentials",
      threat: "Any reader of mcp.smithers.sh uses a GitHub token or API key accidentally pasted into a published guide.",
      lookFor: [
        "A token value in an `env` block or JSON config that is not a placeholder such as `ghp_...` or `process.env.X`.",
        "An `alchemy.run.ts` that passes an inline account id, API token, or secret binding to `makeDocsSiteStack` instead of only the slug."
      ],
      paths: ["src/content/docs/**", "alchemy.run.ts"]
    },
    {
      id: "pinned-server-launch",
      title: "Copyable server launch snippets pin the package and keep credentials out of install scripts",
      threat: "A compromised or typosquatted npm release runs with the reader's GitHub token when they copy an unpinned `npx -y` launch from the docs.",
      lookFor: [
        "A `command: \"npx\"` snippet with `-y` and an unversioned package name, contradicting the pinned `npm ci --ignore-scripts` recipe in connect-a-server.md.",
        "An install command that runs lifecycle scripts or keeps `GITHUB_TOKEN` in its environment."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "least-authority-advice",
      title: "Guides never tell users to widen a run's authority to make a tool call work",
      threat: "A reader following a troubleshooting fix grants an untrusted MCP server's tools write or network authority over their repository.",
      lookFor: [
        "Advice or an example envelope of `*:*`, an empty `include`, or a broad capability glob presented as the fix for a refused call.",
        "An untrusted-server guide example whose frame, output, or timeout limits are raised above the documented defaults without saying why."
      ],
      paths: [
        "src/content/docs/troubleshooting.md",
        "src/content/docs/guides/grant-authority-to-mcp-tools.md",
        "src/content/docs/guides/bound-an-untrusted-server.md",
        "src/content/docs/guides/select-the-tools-a-run-sees.md"
      ]
    },
    {
      id: "no-active-content",
      title: "Synced guides publish no script, iframe, or event-handler HTML on mcp.smithers.sh",
      threat: "A contributor who edits @smthrs/mcp's colocated docs runs script on the mcp.smithers.sh origin in every reader's browser, because Starlight renders raw HTML in Markdown.",
      lookFor: [
        "A raw `<script>`, `<iframe>`, `<object>`, or `on*=` attribute in a Markdown page outside a fenced code block.",
        "A link or image with a `javascript:` or plain `http://` URL."
      ],
      paths: ["src/content/docs/**"]
    }
  ]
}
