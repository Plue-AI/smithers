/**
 * Security review of the site's own files: the synced content snippets readers
 * copy, and the config and deploy entry points. `security` reviews the diff
 * against origin/main; `securityAudit` audits every included file.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "astro.config.mjs", "alchemy.run.ts"],
  checks: [
    {
      id: "digest-not-a-secret-primitive",
      title: "Copyable snippets never use a bare SHA-256 digest as a MAC, password hash, KDF, or secret comparison",
      threat: "A developer who copies a snippet ships a forgeable MAC, a brute-forceable password store, or a timing-leaky secret check in their own service.",
      lookFor: [
        "A code block that hashes a secret concatenated with a message, e.g. digest(secret + message) or digestSync(`${key}...`), presented as authentication.",
        "A code block that hashes a password or low-entropy secret with digest or digestSync and stores or compares the result.",
        "A `===` comparison between a digest and a secret-derived value without the warning that it is not constant time, as in guides/validate-a-stored-digest.md."
      ],
      paths: ["src/content/docs/**/*.md"]
    },
    {
      id: "untrusted-digest-validated",
      title: "Snippets decode an untrusted address with the Digest schema before using it as a key, path, or lookup",
      threat: "A caller who controls a URL segment, request body, or database column makes a copied content-addressed store read or write an unintended entry.",
      lookFor: [
        "A code block that passes a request- or database-supplied string to a Map, filesystem path, or object store key without Schema.decodeUnknownEffect(Digest) first.",
        "A code block that slices a digest out of a longer key format instead of using the @smthrs/keys accessor.",
        "A read path that returns stored bytes without re-hashing them against the requested address when the guide claims the bytes are verified."
      ],
      paths: ["src/content/docs/quickstart.md", "src/content/docs/guides/**"]
    },
    {
      id: "site-config-no-secrets-or-raw-html",
      title: "Site config and deploy stack carry no credentials and inject no raw HTML or scripts",
      threat: "Anyone who reads the public repository or the built site obtains a deploy credential, or a content author injects script into crypto.smithers.sh visitors' browsers.",
      lookFor: [
        "A token, account id secret, API key, or password literal in astro.config.mjs or alchemy.run.ts instead of an environment-provided binding.",
        "A head entry, custom component, or markdown with raw <script> or on* handler added to the site config or content.",
        "An alchemy.run.ts slug other than \"crypto\", which would deploy over another site's worker or domain.",
        "An editUrl or install/link target outside github.com/smithersai/smithers, *.smithers.sh, or effect.website, which would send readers to a lookalike repo or package."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "src/content/docs/**"]
    }
  ]
}
