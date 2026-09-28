/**
 * Targets for the shared kit behind every per-package docs site under
 * apps/docs and the Starlight route middleware apps/site mounts.
 *
 * The kit is an implementation the sites import, not a site: it has no
 * build. Its job here is to be a dependency edge. Every projected site's
 * astro.config.mjs calls `defineDocsSite` from starlight.mjs, which installs
 * release-notice.mjs as route middleware, and apps/site imports the same
 * middleware through scripts/docs-notice.mjs. An edit to either file changes
 * the rendered HTML of every site, so each site's `check` and `build` name
 * the `sources` group below and re-key when the kit moves.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"

const cwd = "apps/docs/shared"

/**
 * The runtime the sites import: the astro config factory, the release
 * notice middleware, the site manifest, the Alchemy factory, the stylesheet
 * and assets the generator copies, and the manifest that pins their versions.
 * The generator and sync scripts are not members: their outputs are committed
 * and drift-checked, so the copies are the inputs.
 */
const sources = Smithers.Filegroup({
  srcs: [
    Smithers.file("starlight.mjs"),
    Smithers.file("starlight.d.ts"),
    Smithers.file("release-notice.mjs"),
    Smithers.file("manifest.mjs"),
    Smithers.file("manifest.d.ts"),
    Smithers.file("alchemy-site.mjs"),
    Smithers.file("alchemy-site.d.ts"),
    Smithers.file("starlight.css"),
    Smithers.glob("assets/**/*"),
    Smithers.file("package.json")
  ],
  cwd
})

/** The generator emits the declared edges and the content sync round-trips against fixtures under a temp dir; the Alchemy factory derives every manifest site's identity from its slug; the llms check rejects Electrobun boilerplate. */
const tests = Smithers.Shell.Test({
  shell: "node --test --test-concurrency=1 apps/docs/shared/gen-sites.test.mjs apps/docs/shared/sync-content.test.mjs apps/docs/shared/alchemy-site.test.mjs apps/docs/shared/check-llms.test.mjs",
  data: [
    Smithers.file("gen-sites.mjs"),
    Smithers.file("gen-sites.test.mjs"),
    Smithers.file("sync-content.mjs"),
    Smithers.file("sync-content.test.mjs"),
    Smithers.file("alchemy-site.mjs"),
    Smithers.file("alchemy-site.test.mjs"),
    Smithers.file("check-llms.mjs"),
    Smithers.file("check-llms.test.mjs"),
    Smithers.file("manifest.mjs"),
    Smithers.file("starlight.css"),
    Smithers.glob("assets/**/*")
  ]
})

/**
 * Security review of the kit. It has no `src/`; the reviewed set is its
 * scripts, config factories, and declarations. The kit writes into every
 * site's committed tree and into package READMEs, emits generated code, and
 * shapes the HTML and Cloudflare deploy of every public docs site.
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["*.mjs", "*.d.ts", "*.d.mts", "starlight.css", "package.json", "AUTHORING.md"],
  checks: [
    {
      id: "sync-read-confinement",
      title: "Content sync publishes only Markdown that lives inside the source package's docs directory",
      threat: "A docs contributor publishes a file from outside <pkg>/docs, such as a local secret or another package's private notes, to a public smithers.sh site.",
      lookFor: [
        "discoverSources or planSite reading a *.md Dirent that is a symlink, so readFileSync follows it outside srcDocs.",
        "A source or output path built from a docs-relative name without checking it stays under srcDocs or the site's src/content/docs.",
        "SMITHERS_DOCS_SLUG or a slug argument selecting a site that is not a manifest row."
      ],
      paths: ["sync-content.mjs", "manifest.mjs"]
    },
    {
      id: "link-rewrite-schemes",
      title: "Rewritten links point only at smithers.sh, its package subdomains, GitHub, or local routes",
      threat: "A docs author ships a javascript:, data:, or look-alike-host link that runs script or phishes readers of a public docs site.",
      lookFor: [
        "rewriteTarget passing a non-http scheme (javascript:, data:, vbscript:) through unchanged instead of turning it into a GitHub URL or rejecting it.",
        "siblingApi or siblingPage minting https://<slug>.smithers.sh from an unvalidated segment that can contain dots or @ and so name another host.",
        "A root-absolute target such as //evil.example/x.js that rule 7 returns unchanged as a protocol-relative link to another host."
      ],
      paths: ["sync-content.mjs"]
    },
    {
      id: "page-html-passthrough",
      title: "Synced pages and frontmatter cannot inject markup or YAML beyond what the author wrote",
      threat: "A package.json description or docs file injects frontmatter keys or raw script into every page of a public docs site.",
      lookFor: [
        "yamlQuote failing to escape a character (newline, backslash, quote) so a description or title adds a frontmatter key.",
        "transform keeping raw <script> or on* attributes from source Markdown with no check before the page ships.",
        "The MDX comment rewrite turning {/* ... */} content containing --> into live HTML."
      ],
      paths: ["sync-content.mjs", "manifest.mjs"]
    },
    {
      id: "generated-code-quoting",
      title: "gen-sites emits every manifest and package.json value into generated code through JSON.stringify",
      threat: "A package description or manifest row injects code into a generated astro.config.mjs, alchemy.run.ts, or PACKAGE.ts that runs on every developer and CI machine.",
      lookFor: [
        "A ${site.*} interpolation inside a string or template in astroConfig, alchemyRun, or packageTs that is not JSON.stringify'd, such as site.name in the contentSync summary.",
        "site.dir flowing into a generated import path without a check that it is a repo-relative package directory.",
        "writeFileSync targets derived from a slug that could contain / or .. and escape apps/docs."
      ],
      paths: ["gen-sites.mjs", "manifest.mjs"]
    },
    {
      id: "repo-write-scope",
      title: "Kit scripts write only generated site files and manifest package READMEs",
      threat: "Running a kit script overwrites or deletes developer files outside the generated site trees.",
      lookFor: [
        "syncSite removing or pruning files outside <site>/src/content/docs.",
        "syncSite writeFileSync following a committed symlink under src/content/docs and overwriting its target.",
        "add-readme-doc-links writing a README for a dir outside repoRoot.",
        "gen-sites writing outside site.siteDir or a sibling directory under apps/docs."
      ],
      paths: ["sync-content.mjs", "gen-sites.mjs", "add-readme-doc-links.mjs"]
    },
    {
      id: "deploy-identity",
      title: "Each docs site deploys to its own Worker and its own smithers.sh subdomain and carries no credentials",
      threat: "A new or renamed manifest slug takes over another live Worker or hostname on the smithers.sh zone, or a token lands in committed deploy code.",
      lookFor: [
        "docsSiteProps deriving name or domain from anything but a validated manifest slug.",
        "An API token, account secret, or state-store credential inlined in alchemy-site.mjs instead of the environment.",
        "workersDev or a route setting that exposes a site on an extra unreviewed hostname."
      ],
      paths: ["alchemy-site.mjs", "manifest.mjs"]
    },
    {
      id: "site-head-third-party",
      title: "Every site loads third-party resources only from the fixed Google Fonts hosts, and the release banner is constant HTML",
      threat: "An edit to the shared head or banner loads attacker-controlled script or markup into every smithers.sh docs site at once.",
      lookFor: [
        "A head tag in defineDocsSite adding a <script> or a stylesheet from a host other than fonts.googleapis.com or fonts.gstatic.com.",
        "An @import or url() in starlight.css that loads from a remote host.",
        "release-notice.mjs building banner.content from request, route, or frontmatter data instead of a literal."
      ],
      paths: ["starlight.mjs", "release-notice.mjs", "starlight.css"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { sources, tests, ...securityReview }
})
