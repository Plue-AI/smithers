---
title: "Fetch admission"
description: "Repo-host fetch process and waiting-work limits."
---

## Limits

Repo-host streams clone and fetch responses. A process slot remains held until
streaming and subprocess cleanup finish, including for slow readers. Slots are
global across repositories.

| Environment variable | Default | Accepted values |
| --- | --- | --- |
| `SMITHERS_REPO_HOST_MAX_CONCURRENT_UPLOAD_PACKS` | `4` | Integers from 1 to 1024 |
| `SMITHERS_REPO_HOST_MAX_QUEUED_UPLOAD_PACKS` | `16` | Integers from 1 to 1024 |
| `SMITHERS_REPO_HOST_UPLOAD_PACK_QUEUE_TIMEOUT` | `30s` | Positive Go duration |

Admission limits the total active and waiting requests to the sum of the two
counts. The deadline covers negotiation reads, reference-export lock waits,
process-slot admission, and repository read-lock waits. Native `ExportGitRefs`
runs synchronously and cannot be interrupted. It holds no process slot; if the
deadline expires, process admission fails when export returns.
Fetch negotiation is buffered with a 10 MiB decompressed cap, lowered by
`Config.MaxGitRequestBytes` when configured. Pack responses are never buffered. Buffered negotiation has a payload budget of
`(concurrent + queued) × limit`: 200 MiB at the defaults, plus buffer allocation
growth and HTTP/gzip overhead. Size memory for this budget and the concurrent
git processes.
Reading negotiation before waiting lets HTTP/1.1 detect disconnected clients and
cancel their queued work. Incomplete negotiation is bounded by the read deadline.

A full queue or expired admission wait returns HTTP 503 with `Retry-After: 1`. Oversized negotiation returns HTTP 413. Malformed negotiation returns HTTP 400. These limits protect process and
request memory; increasing them requires sizing the repo-host memory budget.

## Clone pack cache

Identical clones share one pack. upload-pack still negotiates and checks each
request against the refs its caller may see; only its `pack-objects` step runs
through `uploadpack.packObjectsHook`, which re-executes the repo-host binary.
The hook keys a pack on the repository, the `pack-objects` arguments, and the
revision list. The first request for a key builds the pack under a per-key file
lock, and concurrent requests for that key wait and then stream the same file.
Fetches that send haves bypass the cache.

A shallow clone cannot use reachability bitmaps, so each one walks and
compresses the whole tree. Twenty CI guests cloning one commit cost twenty
packs without the cache and one with it.

| Environment variable | Default | Accepted values |
| --- | --- | --- |
| `SMITHERS_REPO_HOST_PACK_CACHE_DIR` | `<storage>/.pack-objects-cache@` | Directory path, or `off` |
| `SMITHERS_REPO_HOST_PACK_CACHE_MAX_BYTES` | `4294967296` | Positive byte count |
| `SMITHERS_REPO_HOST_PACK_CACHE_TTL` | `10m` | Positive Go duration |

A pack is reused for at most the TTL; a tag created in that window reaches
`--include-tag` clients on their next fetch. A pack larger than the byte budget
is served once and not kept. Eviction removes expired packs first, then the
least recently served.

## Metrics

- `smithers_repo_host_upload_pack_waiting`: requests reading negotiation, synchronizing references, or waiting for a process slot or repository read lock.
- `smithers_repo_host_upload_pack_wait_seconds`: negotiation and admission duration.
- `smithers_repo_host_upload_pack_rejected_total{reason}`: rejected admission, labeled `full`, `body`, or `ended`.
