/**
 * `security` reviews the diff against origin/main; `securityAudit` audits
 * every reviewed file. Checks cover the synced @smthrs/step-cache docs users
 * copy into shared-cache clients and servers, plus this site's config and
 * deploy stack.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "docs-shared-tier-authz",
      title: "The shared-tier server contract requires authenticating and authorizing every PUT and DELETE",
      threat: "An operator who builds a shared cache server from the guide leaves /ac/{keyDigest} writable by anyone who reaches it, so an outsider publishes a forged step result that every host then replays as its own output, or deletes other teams' entries.",
      lookFor: [
        "implement-a-shared-tier.md describing GET, PUT, and DELETE on /ac/{keyDigest} with no requirement that the server verify the caller's credential before writing or deleting.",
        "The admit or fenceOf server snippets handling a request without any authentication step, while the text presents them as the complete contract.",
        "Text implying the client-side checks (key grammar, keyDigest match, response bounds) protect against a malicious writer, when they only reject malformed or misrouted entries."
      ],
      paths: ["src/content/docs/guides/implement-a-shared-tier.md", "src/content/docs/concepts/tiers.md", "src/content/docs/concepts/admission.md"]
    },
    {
      id: "docs-remote-credential-handling",
      title: "Remote-tier examples keep credentials out of snippets, URLs, keys, and journals",
      threat: "A reader who copies a RemoteCacheStore snippet commits a live bearer token or puts it in the endpoint URL, and anyone with the repository or the logs replays it against the owner's shared cache.",
      lookFor: [
        "A fenced code block with a literal bearer token, API key, or long hex/base64 secret instead of `declare const token` or a configuration read.",
        "An endpoint example with userinfo, a query-string token, or plain http to a non-loopback host.",
        "A claim that headers are redacted from spans or never journaled that the RemoteCacheStore reference contradicts elsewhere on the site."
      ],
      paths: ["src/content/docs/guides/share-results-across-machines.md", "src/content/docs/reference/api.md", "src/content/docs/troubleshooting.md", "src/content/docs/quickstart.md"]
    },
    {
      id: "docs-unredacted-results-shared",
      title: "Docs warn that cached results are unredacted and published verbatim to the shared tier",
      threat: "A flow author caches a step whose result holds a secret or private data, enables a shared tier, and every machine and operator with access to that tier reads the value.",
      lookFor: [
        "admission.md stating results are never redacted without saying a shared tier stores and serves those bytes to other hosts.",
        "share-results-across-machines.md or tiers.md omitting any caution about secrets in step results before enabling inline publication."
      ],
      paths: ["src/content/docs/concepts/admission.md", "src/content/docs/concepts/tiers.md", "src/content/docs/guides/share-results-across-machines.md"]
    },
    {
      id: "docs-fence-snippet-safety",
      title: "Copied eviction-fence code refuses partial or malformed fences before deleting",
      threat: "A server author copies the fenceOf snippet or a fenced evict example, and a request with one parameter or a malformed sequence becomes an unconditional DELETE that drops another run's fresh entry.",
      lookFor: [
        "The fenceOf snippet returning undefined (unconditional delete) when only one of recordedRunId or recordedEventSeq is present, or accepting duplicates, signs, whitespace, leading zeros, or values past Number.MAX_SAFE_INTEGER.",
        "An evict example fencing on the evicting run's own provenance instead of the provenance read off the entry.",
        "Text claiming the client can detect a tier that ignores the fence query parameters."
      ],
      paths: ["src/content/docs/guides/implement-a-shared-tier.md", "src/content/docs/guides/evict-a-poisoned-entry.md", "src/content/docs/quickstart.md", "src/content/docs/reference/api.md"]
    },
    {
      id: "docs-site-deploy-config",
      title: "The site config, deploy stack, and synced pages add no raw script, remote scripts, or inline credentials",
      threat: "A contributor who edits the site config injects script into every visitor's browser on step-cache.smithers.sh, or a committed Cloudflare credential lets anyone redeploy or destroy the site.",
      lookFor: [
        "astro.config.mjs or content.config.ts adding head scripts, set:html, or a remote script origin beyond the shared kit.",
        "alchemy.run.ts or package.json scripts embedding an API token or state-store secret instead of the shared kit's environment reads.",
        "A synced Markdown page carrying raw <script>, <iframe>, an on* event attribute, or a javascript: link that Starlight renders verbatim into step-cache.smithers.sh."
      ],
      paths: ["astro.config.mjs", "alchemy.run.ts", "package.json", "src/content.config.ts", "src/content/docs/**"]
    }
  ]
}
