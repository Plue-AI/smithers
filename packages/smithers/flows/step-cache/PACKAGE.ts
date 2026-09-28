import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { ReviewTagsMigrationsAndKeys } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  testProgram: Smithers.file("//packages/smithers/flows/database/scripts/test-matrix.mjs"),
  deps: [],
  cwd: "packages/smithers/flows/step-cache"
})

/**
 * The durable-identity review: identity strings, migrations, persisted
 * schemas, and durable keys, read out of this package's own changed sources.
 *
 * @since 0.1.0
 * @category lint
 */
const reviewTagsMigrationsAndKeys = ReviewTagsMigrationsAndKeys({ cwd: "packages/smithers/flows/step-cache" })

/**
 * The security review: `security` checks the diff against origin/main and
 * `securityAudit` audits every reviewed file.
 */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/step-cache",
  include: ["src/**", "docs/**", "README.md"],
  checks: [
    {
      id: "remote-entry-trust",
      title: "A shared-tier entry is served only for the key and provenance the caller asked for",
      threat:
        "Anyone who can write to or impersonate the shared cache endpoint makes another host replay a forged step result or plants ledger rows under that host's run ids.",
      lookFor: [
        "RemoteCacheStore.get returning an entry whose keyDigest differs from the requested key.",
        "CombinedCacheStore.get writing a remote entry back through local.put with remote-chosen recordedRunId and recordedEventSeq that a later fenced local replay of that exact event would read.",
        "A fenced lookup accepting a remote entry whose provenance mismatches recordedBy and serving it where the local ledger row was refused or expired.",
        "A remote refusal or malformed body that turns into a hit instead of a miss."
      ],
      paths: ["src/RemoteCacheStore.ts", "src/CombinedCacheStore.ts"]
    },
    {
      id: "remote-credential-exposure",
      title: "Remote cache credentials reach only the configured origin and never logs or errors",
      threat:
        "A network observer, log reader, or hostile redirect target obtains the bearer token an operator configured for the shared cache.",
      lookFor: [
        "An endpoint accepted over plain http: whose hostname is not loopback, or a loopback test fooled by a hostname like 127.0.0.1.evil.com.",
        "An endpoint with userinfo, query, or fragment admitted into requests or error messages.",
        "A CacheStoreError message or span attribute that includes the URL, request, header values, or free-form transport cause text.",
        "A configured header name missing from Headers.CurrentRedactedNames, or a client that follows redirects to another origin with the headers attached."
      ],
      paths: ["src/RemoteCacheStore.ts"]
    },
    {
      id: "cache-key-namespace",
      title: "A cache key cannot escape /ac/ or the SQL key column",
      threat:
        "A flow author or remote tier crafts a key digest that reads, overwrites, or deletes a different remote path or the whole /ac/ collection.",
      lookFor: [
        "The KeyDigest pattern admitting '.', '/', '%', '?', '#', or an empty string.",
        "An acUrl or DELETE issued before validateKey runs on the key.",
        "Run id or event seq placed in the URL path instead of percent-encoded query parameters."
      ],
      paths: ["src/internal/CacheEntry.ts", "src/internal/CacheAdmission.ts", "src/RemoteCacheStore.ts"]
    },
    {
      id: "bounded-untrusted-json",
      title: "Stored and remote JSON is bounded before it is parsed or kept",
      threat:
        "A hostile shared tier or a corrupted database row exhausts memory or CPU on every host that looks up a key.",
      lookFor: [
        "JSON.parse on a response body or row value before a byte bound is enforced.",
        "SqlCacheStore decode bounding result_json or meta_json by string length (UTF-16 units) where the contract promises a byte bound.",
        "readBounded trusting Content-Length alone, or buffering chunks past maxResponseBytes before failing.",
        "A maxResponseBytes, requestTimeout, or depth/node limit that a caller can set above the documented maximum or to a non-finite value.",
        "snapshotEntry reading accessors or prototype properties instead of own data descriptors, so a getter runs during admission."
      ],
      paths: ["src/RemoteCacheStore.ts", "src/internal/CacheAdmission.ts", "src/internal/SqlCacheStore.ts"]
    },
    {
      id: "sql-parameterization-and-fences",
      title: "Every SQL statement binds its values and destructive statements keep their guard in the WHERE clause",
      threat:
        "A caller-controlled key or run id injects SQL, or a racing writer loses a fresh cache row to an unfenced delete.",
      lookFor: [
        "A statement built with sql.unsafe, string concatenation, or a template interpolating an identifier rather than a bound value.",
        "An evict or sweep that reads provenance first and then deletes without the provenance predicate in the same DELETE.",
        "sweepExpired deleting ledger rows without canReclaimRecorded approval or without re-checking created_at_ms in the DELETE."
      ],
      paths: ["src/internal/SqlCacheStore.ts", "src/migrations/**"]
    },
    {
      id: "docs-credential-examples",
      title: "Docs show credentials only as placeholders passed through headers",
      threat: "A user copies an example that embeds a real token, userinfo URL, or plain-http remote endpoint into production.",
      lookFor: [
        "A literal token, key, or password in a docs code block instead of a declared variable.",
        "An example endpoint using http:// for a non-loopback host or user:pass@ userinfo."
      ],
      paths: ["docs/**", "README.md"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, reviewTagsMigrationsAndKeys, fmt, lib, lint, test, ...securityReview }
})
