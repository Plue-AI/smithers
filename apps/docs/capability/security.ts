/**
 * Security review: `security` reviews the diff against origin/main and
 * `securityAudit` audits every included file. The content tree is security
 * guidance for the permission kernel, so a wrong snippet here becomes an over-
 * broad grant in every integrator that copies it.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "astro.config.mjs", "alchemy.run.ts"],
  checks: [
    {
      id: "grant-snippet-over-grants",
      title: "Every copyable grant or parse snippet grants no more than its prose claims",
      threat: "An integrator copies a docs snippet and ships a pattern that lets an agent write, spawn, or fetch resources the approving user never approved.",
      lookFor: [
        "A code block that builds a CapabilityPattern resource by interpolating agent- or user-supplied text outside the explicit What not to do example.",
        "A snippet using `*` for a subtree or `fs:*`/bare `*` whole-authority without saying it is deliberately wide.",
        "A stated `// true` or `// false` result for matches, subsumes, parse, or patternFromCapability that contradicts //packages/smithers/flows/capability/src.",
        "Guidance that tells a caller to fall back to matches when subsumes returns false, or to treat Option.none() as anything but a rejection.",
        "A proc:spawn command grant such as `npm *` called safe without warning that `*` matches spaces, `;`, `&&`, newlines, and subcommands like `npm exec` or `npm run` (see //packages/smithers/flows/capability/src/matches.ts)."
      ],
      paths: [
        "src/content/docs/guides/**",
        "src/content/docs/concepts/**",
        "src/content/docs/reference/**",
        "src/content/docs/quickstart.md",
        "src/content/docs/index.md"
      ]
    },
    {
      id: "permission-failure-handling-advice",
      title: "Permission-failure guidance never advises retrying, widening, or trusting forged failures",
      threat: "An integrator following the troubleshooting or failure guide auto-approves a denied request or accepts a forged PermissionError from an untrusted payload.",
      lookFor: [
        "Advice to catch a permission failure and retry with a wider pattern or a wildcard grant.",
        "Advice to accept an unknown value as a permission failure without Permission.isPermissionError or schema decode."
      ],
      paths: ["src/content/docs/guides/handle-a-permission-failure.md", "src/content/docs/troubleshooting.md"]
    },
    {
      id: "site-content-safe-and-secret-free",
      title: "Rendered pages and deploy config carry no secrets, raw script, or off-site redirects",
      threat: "A contributor leaks a credential in an example or deploy file, or injects HTML that runs script or phishes readers of capability.smithers.sh.",
      lookFor: [
        "An API key, token, account id, or password literal in content, astro.config.mjs, or alchemy.run.ts rather than a placeholder.",
        "Raw <script>, <iframe>, inline event handlers, or javascript: URLs in markdown content.",
        "An editUrl or link pointing to a domain other than smithers.sh and its subdomains, github.com/smithersai, effect.website, or the reserved example.test."
      ]
    }
  ]
}
