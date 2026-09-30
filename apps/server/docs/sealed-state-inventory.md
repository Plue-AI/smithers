# Temporary sealed state inventory

This is a separate maintenance candidate. It does not activate the stateless
edge or alter the ordinary deployment configuration. The campaign explicitly
authorizes this bounded maintenance deployment after root reviews its source,
security tests and exact prepared artifact. Normal deployment rules still apply
to product changes.

`deploy.ts prepare` reads the live version/settings and downloads the deployed
module bytes. It preserves every original module unchanged, exports the same
six Durable Object classes through wrappers, and adds a sealed-export helper.
Every normal fetch and alarm delegates to the original object instance. The
default Worker handler and its other exports remain the downloaded version.
No Durable Object migrations, deletes, alarm changes, queue changes, payment
writes, asset uploads, routes, domains or product authority changes occur.

## Endpoint and envelope

`POST /__maintenance/state-export` accepts exactly:

```json
{"migrationId":"UUID","binding":"MODEL_VAULTS","objectId":"64 lowercase hex characters"}
```

Bindings are the frozen six web Worker namespaces. The object must match its
native ID and binding. Authentication is a separate random 256-bit bearer in
`SMITHERS_EXPORT_TOKEN`; existing user/admin credentials grant no access.
The fixed `SMITHERS_EXPORT_EXPIRES_AT` is generated six hours ahead; absent,
expired, over-24-hour or invalid configuration returns 404. All responses use
`Cache-Control: no-store`. The request is bounded to 2048 bytes.

Each object is read under `blockConcurrencyWhile`; storage keys and structured
values plus the current alarm are serialized without changing storage. A fresh
AES-256-GCM key and 96-bit nonce encrypt each export. RSA-OAEP/SHA-256 wraps that
key for the local recipient (RSA-3072 by the operator generator, minimum 2048).
Only the public key reaches the Worker; private JWK components are rejected.
GCM authenticates migration ID, source commit/version, DO ID/binding, snapshot
schema, source key version and capture time. Wrong recipient or changed metadata
cannot decrypt. Ciphertext is the only successful response payload.

Vault payloads include the original encrypted document and its existing
`MODEL_VAULT_KEY` solely inside the recipient-encrypted `migrationContext`.
The source key version is `model-vault:v1`. This preserves original ciphertext,
AAD identity, pins and receipts; the source key is never returned in metadata,
headers or logs. The future importer must resolve the numeric verified GitHub
identity before decrypting credentials and re-encrypting with canonical
`SecretCodec`, all in memory. Username equality alone cannot authorize import.

Failures return fixed codes without exception details, storage values or keys.
An unavailable recipient, unsupported storage type, serialization/encryption
failure, or over-limit object returns no row payload. The current bound is
8,000,000 encoded bytes / 50,000 keys per object; an oversized object requires a
reviewed paged exporter. It is never skipped or counted as complete. The
operator aborts on archive write/decryption/provenance failure, preserving
partial encrypted files without writing a completion manifest.

## Operator sequence

Run from `apps/server`. The private directory must be outside every repository.
Commands accept paths only; never pass secrets as command-line arguments.

```sh
bun scripts/cutover/keys.ts /absolute/private/new-directory
bun scripts/cutover/deploy.ts prepare /absolute/private/new-directory
# Review plan/module digests, security tests, current live version and rollback.
bun scripts/cutover/deploy.ts apply /absolute/private/new-directory
bun scripts/cutover/export.ts /absolute/private/new-directory
bun scripts/cutover/deploy.ts restore /absolute/private/new-directory
```

The key directory is 0700, all key files, downloaded source, prepared metadata,
receipts, sealed snapshots and manifest are 0600 and created exclusively. The
Cloudflare API token is read from the existing environment and is sent only to
Cloudflare. Requests reject redirects. The exporter bearer is sent only to the
frozen HTTPS canary origin. Decrypted rows/keys exist in memory only; reports
contain aggregate counts and hashes, not logins, prompts, tokens or ciphertext.
Keep this backup and its private key until canonical import and reconciliation
are verified; do not erase the old namespaces.

Apply refuses drift from the prepared deployment/settings and checks every
module and metadata digest. It preserves old secrets by `keep_bindings` and
assets by `keep_assets`; original binding identities are checked again after
upload. Root must serialize this short maintenance window against the normal
deployment pipeline, because the Cloudflare upload API has no compare-and-swap
in this tool. Restore refuses an intervening deployment and uploads the exact
original bytes.

Each upload first writes `prepared/apply-intent.json` or
`prepared/restore-intent.json`. If Cloudflare accepts an upload but its
response is lost, rerun the same command (or run `restore` after a lost
`apply`). It adopts the live version, without uploading again, only when that
version is the newest upload, carries the prepared `workers/message`, and matches
the prepared entry, module digests and original bindings exactly. The receipt
then records `"reconciled": true`. Any other live version is refused as an
unrelated deployment. The temporary route then ceases to exist. Temporary secret
bindings can be removed after restoration; their fixed expiry also disables
the route even if restoration is delayed.

Cloudflare documents asset retention in
[multipart upload metadata](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/)
and cursor pagination in
[Durable Object listing](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/subresources/objects/methods/list/).

## What this proves

The resulting manifest authenticates each saved object's source and content
hash and reports actual vault, journal, tombstone, setup and live-turn counts.
It records `globallyQuiescent: false`: the service remains live, alarms remain
enabled, and a per-object inventory is not a global drain or final migration.
Object enumeration is eventually consistent; empty-at-listing objects are
counted separately. A final drain and re-export must occur before authority
changes, including explicit reconciliation of billing reservations/metering.

Identity/billing Workers are outside these six namespaces. Their verified
numeric identity rows and ledger/metering reconciliation still require their
own sealed inventory and migration. This tool reports zero verified canonical
identity mappings until that evidence exists. It adds no anonymous account,
permanent history endpoint, fallback, or dual write.

## Fixed legacy identity inventory

`SMITHERS_EXPORT_TARGET=identity` selects only `smithers-cloud-identity`, its
`identity.smithers.sh` domain and its original `IDENTITY` /
`IdentityDurableObject` namespace. Other target values refuse. The web target
remains the default. The normal Worker entry/configuration is unchanged.
Every prepare/apply/restore/export command must use the same selected target;
plans bind that target and the live deployment version explicitly.

The legacy identity deployment has no source annotation. Its existing official
`workers/identity/deploy-receipts` record must name the exact live version and
immutable source revision. That label alone is insufficient: reproduce every
downloaded module from the immutable source with the recorded deploy script's
pinned Wrangler, and require exact byte hashes. Put the reviewed proof in the
private key directory as owner-only `source-proof.json`:

```json
{
  "receipt": {
    "worker": "smithers-cloud-identity",
    "source": "workers/identity",
    "dryRun": false,
    "gitSha": "40-digit immutable source revision",
    "timestamp": "ISO deployment time",
    "wranglerVersionId": "exact live version UUID"
  },
  "modules": [{"name":"index.js","file":"reproduced-index.js","sha256":"exact downloaded/reproduced digest"}]
}
```

Copy the reproduced module into the named owner-only file beside this proof.
Prepare validates the official receipt's identity/version, exact module set,
each actual reproduced file digest and each downloaded live digest, then retains
the proof with the prepared artifact. A source/bundle discrepancy blocks this
path. Original identity annotations/settings are restored exactly; the operator
does not invent a new production source annotation.

Use a new recipient/directory and run the existing sequence with
`SMITHERS_EXPORT_TARGET=identity` on every command. Snapshots go into
`identity-snapshots`. Original OAuth/session/token methods, native RPC hooks,
alarms and bindings remain intact. Only the temporary authenticated export fetch
path changes. No token is used, refreshed, reset or printed by inventory.

The offline classifier requires a positive safe numeric GitHub ID in both the
`account:<id>` key and row, a verified binding timestamp, and the matching
current `loginid:<login>` back-reference. Duplicate accounts/aliases or multiple
account rows retaining the same login refuse a legacy ownership binding. Only
aggregate counts are reported. These are verified legacy provider bindings;
canonical identity mappings remain zero until a separate authorized canonical
provider-ID join and migration validates them. This does not assign anonymous
history or authorize an account from matching usernames alone.
