# ADR 0004: The machine daemon's wire contract

Status: proposed (2026-10-03). Owner: T-COL-03r ([#3626](https://github.com/smithersai/smithers/issues/3626)). Accepted when the golden frames under `packages/backend/internal/compose/testdata/cocontracts/` pass against the Go codec (`packages/backend/internal/machined/wire/`) and the Rust codec (`crates/smithers-machined/src/conn.rs`, `src/msg.rs`).

## Context

`smithers-machined` runs inside every branch machine and keeps one multiplexed connection to the host (spec §9.1.1). That connection carries control RPC, durable change events and their acknowledgements, presence, terminal and SSH sessions, git objects, and in stage 3 live-document frames. Two codecs speak it: Go on the host, Rust in the guest. Their first consumers are T-COL-03 (host registry), T-COL-03a (daemon core), T-COL-03f (Go fake daemon), T-COL-04 and T-COL-04a (watcher and events), T-TRM-07 (sessions) and T-COL-08a/08b (documents, S3).

No daemon wire exists to reuse. The terminal WebSocket (`packages/backend/internal/routes/terminal_session_manager.go`) has no request correlation, acknowledgement or actor envelope. The guest helper's `relay` and `bridge` (`packages/backend/microsandbox/guest/smithers-guest.py:419`, `:441`) are byte pipes with no framing. Both stay the byte transport underneath this contract.

T-COL-01 and T-COL-11 have not chosen between the two transports (C-SPK-03's first run decided nothing). This contract works over both.

The implementation design, module layout and lane split are in [`.specs/engineering/design/machined.md`](../../.specs/engineering/design/machined.md).

## Decision

### One byte stream; the transport is a single seam

The contract starts once an ordered, reliable byte stream exists between the host and the daemon. How the stream is made is the only thing that differs between topologies:

| Topology | Who connects | Guest end | Host end |
| --- | --- | --- | --- |
| `relay` | host | daemon accepts on `127.0.0.1:970`; the root broker binds that port and hands the listening descriptor to the daemon | `Runtime.DialWorkspacePort` (`microsandbox/transport.go:67`) |
| `bridge` | daemon | daemon dials `127.0.0.1:<host relay port>`, served by the guest helper's `bridge` (`transport.go:126`) | the backend's relay-port listener |

The seam is one interface per side: Rust `link::LinkSource` (`next() -> io::Result<TcpStream>`), Go `machined.LinkSource` (`Next(ctx) (net.Conn, error)`). Everything above it, from the first handshake byte on, is identical in both topologies. The boot file (`/run/smithers/machined/boot`, below) names the topology, so switching after T-COL-11 decides is a configuration change.

On `relay` the daemon cannot dial, so the host redials with the §9.1.1 backoff (250 ms doubling to 5 s). On `bridge` the daemon dials with the same schedule. Port 970 is below 1024 so no guest process except root can bind it; the broker holds it across daemon restarts, so no member or agent process can squat it while the daemon is down.

Rejected: a handshake per topology (two code paths to test and secure); TLS on the stream (no PKI in the guest, and the stream never leaves the host).

### Framing

Every frame is a 9-byte header and a payload. All integers are big-endian.

```
offset  size  field
0       4     len     u32, payload length (header excluded)
4       1     kind    u8
5       4     stream  u32
9       len   payload
```

| kind | name | stream | max `len` | direction |
| --- | --- | --- | --- | --- |
| `0x00` | hello | 0 | 8 KiB | both, before `Welcome`; `Goodbye` any time |
| `0x01` | control | 0 | 1,114,112 (1 MiB + 64 KiB) | requests host→daemon, responses daemon→host |
| `0x02` | events | 0 | 4 MiB | `Durable` and `Hint` daemon→host, `Ack` host→daemon |
| `0x03` | presence | 0 | 64 KiB | daemon→host |
| `0x04` | documents (reserved, S3) | ≠ 0 | 4 MiB | both |
| `0x05` | sessions | ≠ 0 | 65,552 (64 KiB + 16) | both |
| `0x06` | objects | ≠ 0 | 65,552 | both |

Stream ids: `0` for the singleton kinds; `1..=0x7FFF_FFFF` allocated by the daemon (sessions, documents, its object streams); `0x8000_0000..=0xFFFF_FFFF` allocated by the host (its object streams). Each side allocates from one counter shared by every kind and never reuses an id within a daemon process's lifetime, so a stream id names one stream whatever its kind (`Error.session`, `attach_session`). A decoder checks, in this order: the header is complete, `kind` is known, `stream` obeys the kind's rule, `len` is within the kind's maximum, the payload is complete. The first failure is the error, so every codec reports the same code for the same bytes.

The content limit is `MaxWorkspaceFileBytes` (1 MiB, `services/workspace_facets.go:27`). Control frames fit one full file plus its envelope; anything larger is refused before it is read.

Rejected: WebSocket framing (needs an HTTP upgrade on a private stream and a non-stdlib Go dependency); HTTP/2 or gRPC (a large dependency in a static musl binary and outside Go's stdlib); varint lengths (no saving that matters at these sizes, and one more way for two codecs to differ).

### Payload encoding: tagged binary structs

Control, events, presence and hello payloads use one canonical tagged encoding. Session, object and document frames use fixed layouts (below).

| type | bytes |
| --- | --- |
| `u8`, `u16`, `u32`, `u64`, `i32` | fixed width, big-endian |
| `bool` | `u8`, 0 or 1 |
| `str` | `u16` length, then UTF-8 without NUL; at most 4,096 bytes |
| `bytes` | `u32` length, then raw bytes |
| `oid` | 20 bytes, a git SHA-1 object id |
| `digest` | 32 bytes, SHA-256 of file content |
| `id128` | 16 bytes |
| `list<T>` | `u16` count, then the items |
| `struct` | `u32` body length, then fields as `u8 tag` + value, tags strictly ascending, each at most once; an optional field is omitted |
| `union` | `u8` variant, then that variant's `struct` |

Canonical means one encoding per value: every encoder emits ascending tags, omits absent optionals, and writes nothing else. Decoders refuse everything else with a typed `ProtocolError`:

| code | name | when |
| --- | --- | --- |
| 1 | `truncated` | input ended inside a frame or value |
| 2 | `frame_too_large` | `len` above the kind's maximum |
| 3 | `unknown_kind` | `kind` not in the table |
| 4 | `bad_stream` | stream id breaks the kind's rule |
| 5 | `unknown_message` | unknown union variant at message level |
| 6 | `unknown_method` | unknown control method |
| 7 | `unknown_field` | a tag the struct does not define |
| 8 | `unordered_field` | a tag not above the previous one, including a repeat |
| 9 | `missing_field` | a required tag absent |
| 10 | `trailing_bytes` | bytes left after a struct body, a payload or a fixed frame |
| 11 | `bad_utf8` | invalid UTF-8 or NUL in a `str` |
| 12 | `bad_value` | out-of-range enum, `bool` not 0/1, a forbidden variant, a length above its bound |
| 13 | `version_mismatch` | handshake protocol differs |
| 14 | `auth_failed` | bad host proof or machine credential |
| 15 | `superseded` | sent only to a live connection that a newer one replaced |
| 16 | `handshake_order` | a non-hello frame before `Welcome`, or hello frames out of order |

Errors 1–4 and 13–16 end the connection: the side that detects one sends `Goodbye{code}` if it can and closes. Errors 5–12 inside a well-framed control request are answered with `Error{malformed, protocol: code}` under that request's `req_id` (the `req_id` is the first field, so it survives a bad body); elsewhere they end the connection.

Rejected: JSON. Go's `encoding/json` matches field names case-insensitively, keeps the last of duplicate keys, always escapes U+2028 and U+2029 and base64-encodes `[]byte`, while `serde_json` does none of these, so byte-exact golden frames and identical refusals would need workarounds in both codecs; file content and terminal bytes would also grow by a third. Rejected: protobuf and CBOR (no stdlib Go implementation, and neither is canonical by default). Rejected: positional encoding without tags (an extra field becomes indistinguishable from trailing garbage, and S3 could not add fields to `open_doc` without renumbering).

### Identity never comes from the machine

No frame the daemon sends carries a branch, machine or uid, and no actor envelope carries one. The host derives the branch and boot from the connection's credential.

```
Actor := union
  1 principal { 1 blob: bytes (≤ 1,024) }   host-resolved participant, opaque to the daemon
  2 session   { 1 id: u32 }                  an outside burst's only active session
  3 run       { 1 run: str }                 a local-socket caller in a registered run
  4 outside   { }                            "changed outside Smithers"
```

Host requests carry only `principal`; any other variant there is `bad_value`. The host's authorizer produces the blob (T-COL-03 defines its encoding and a test that it never contains a uid, branch or machine id). The daemon stores and echoes it, and in stage 3 derives a document client id from it; it never parses it. The daemon reports `session` and `run` actors, and the host resolves them to participants, because only the host knows who opened a session.

One host request names a unix user: `open_session` and `kill_sessions` carry `User {1 login: str, 2 uid: u32}`. The broker checks the pair against the machine's `/etc/passwd` and refuses root, a uid below 20000 other than `agent` (19999), and a login whose uid differs (§9.5.3). The host is the only sender.

### Handshake

The daemon always speaks first, whichever side connected. The relay secret never crosses the stream.

| step | sender | message (`kind 0x00`, union variant) | fields |
| --- | --- | --- | --- |
| 1 | daemon | `1 Challenge` | `1 magic: u32 = 0x534D4D44` ("SMMD"), `2 protocol: u16`, `3 boot_id: id128`, `4 nonce: digest` (32 random bytes) |
| 2 | host | `2 HostProof` | `1 protocol: u16`, `2 mac: digest` = HMAC-SHA256(relay secret, `"smithers-machined/v1 host"` ‖ boot_id ‖ nonce) |
| 3 | daemon | `3 MachineHello` | `1 credential: bytes` (≤ 1,024; the per-boot `machine` token), `2 instance: id128` (this daemon process), `3 next_seq: u64` (lowest unacknowledged seq, or the next seq), `4 sessions: list<u32>` (live sessions open for re-attach) |
| 4 | host | `4 Welcome` | empty |
| any | either | `5 Goodbye` | `1 code: u8` (`ProtocolError`), `2 detail: str` optional |

The host finds the machine, its relay secret and its expected credential by `boot_id`, which works when every machine dials one shared bridge port. It refuses with `auth_failed` when the proof or credential is wrong or the credential belongs to another boot. A newer boot's credential is minted only when the older one is revoked, so an older boot always fails `auth_failed` and "newer replaces older" needs no clock. Otherwise it sends `Goodbye{superseded}` to the branch's live connection, if any, closes it, and sends `Welcome`. `MachineHello.sessions` holds at most 512 ids and `Goodbye.detail` at most 1,024 bytes; longer is `bad_value`. Each step times out after 5 s. After `Welcome`, the host calls `status()` at least every 10 s; a daemon that hears nothing for 30 s treats the connection as lost.

The boot file `/run/smithers/machined/boot` (written by the runtime, T-COL-03; owner `machined`, mode 0400) holds one `key=value` per line: `boot_id` (32 hex), `relay_secret` (64 hex), `credential`, `topology` (`relay` or `bridge`) and, for `bridge`, `bridge_port`.

Rejected: the host presenting the relay secret as a bearer value (§9.5.3's wording). A process that reached the listening port first, or a stale bridge listener, would learn the secret; the HMAC proof costs one extra half round trip and leaks nothing. Rejected: version negotiation. Host and daemon ship in one bundle and the daemon is planted, digest-checked, on every boot (§16.1.1), so a skew lives only until the machine's next boot; one exact `protocol` value keeps one code path.

`protocol` is `1`. Any change to any byte of this contract increments it and regenerates the golden frames.

### Control RPC

```
control payload := union
  1 Request  { 1 req_id: u32, 2 call: Call }
  2 Response { 1 req_id: u32, 2 result: Result }
Call   := union, variant = method id, struct = arguments
Result := union, variant = method id with the method's result struct, or 0xFF Error
```

The host picks `req_id`, unique among its in-flight requests. Responses may arrive in any order. Requests in flight when the connection drops are lost; the daemon finishes any lock job already started, and the host re-issues the call after the next `Welcome` (every method is safe to repeat: `write_file` is guarded by its base, `capture` and `wake_reconcile` are idempotent). The host must keep reading and acknowledging events while any request is outstanding, because `capture()` replies only after the outbox drains. The daemon runs read-only calls concurrently and every working-copy mutation through the mutation lock, in arrival order.

| id | method | arguments | result | S2 owner; until then |
| --- | --- | --- | --- | --- |
| 1 | `status` | — | `1 state: u8` (1 booting, 2 reconciling, 3 ready), `2 protocol: u16`, `3 version: str`, `4 outbox_depth: u32`, `5 acked_head: oid`?, `6 lock_queue: u16` | T-COL-03a |
| 2 | `read_file` | `1 path: str`, `2 at: oid`? | `1 content: bytes`, `2 digest: digest`, `3 mode: u32` | T-COL-03a |
| 3 | `write_file` | `1 path: str`, `2 base: Base`, `3 content: bytes`, `4 actor: Actor` | `1 post_digest: digest` | T-COL-03a |
| 4 | `capture` | — | `1 head: oid`, `2 tree: oid`, `3 flushed_documents: u16` (the flush phase's count; 0 until S3) | T-COL-03a |
| 5 | `wake_reconcile` | `1 head: oid` | `1 outcome: union {1 unchanged {}, 2 moved {1 head: oid}, 3 conflict {1 paths: list<str>}}` | T-COL-03a |
| 6 | `open_session` | `1 user: User`, `2 kind: u8` (1 pty, 2 exec, 3 sftp), `3 argv: list<str>`?, `4 size: Size`? | `1 session: u32` | T-TRM-07; `unsupported` |
| 7 | `tcp_connect` | `1 port: u16` | `1 session: u32` | T-TRM-07; `unsupported` |
| 8 | `close_session` | `1 session: u32` | — | T-TRM-07; `unsupported` |
| 9 | `kill_sessions` | `1 target: union {1 user {1 user: User}, 2 run {1 run: str}}` | `1 killed: u16` | T-TRM-07; `unsupported` |
| 10 | `register_run` | `1 run: str`, `2 session: u32` | — | T-COL-04; `unsupported` |
| 11 | `rebase` | `1 onto: oid`, `2 actor: Actor` | `1 head: oid` | T-STK-08; `unsupported` |
| 12 | `return_to_item` | `1 actor: Actor` | `1 head: oid` | T-COL-05; `unsupported` |
| 13 | `open_doc` | `1 path: str` (T-COL-08b adds tags ≥ 2) | `1 stream: u32` | T-COL-08a (S3); `unsupported` |
| 14 | `close_doc` | `1 stream: u32` | — | T-COL-08a (S3); `unsupported` |
| 15 | `attach_session` | `1 session: u32`, `2 received: u64` | `1 received: u64` | T-TRM-07; `unsupported` |

`?` marks an optional field. `Base := union {1 digest {1 digest: digest}, 2 absent {}}`. `Size := struct {1 cols: u16, 2 rows: u16}`. `rebase` and `return_to_item` carry the actor the rewrite is attributed to ("Rebased onto Tk"). `attach_session` re-attaches a stream after a reconnect (§9.6.4): each side reports how many bytes it received and the other resends from there; unacknowledged bytes never exceed the 256 KiB credit, so that is all either side keeps.

Until `wake_reconcile` succeeds on this boot, every method except `status` and `wake_reconcile` answers `not_ready`.

```
Error := struct { 1 code: u8, 2 detail: str?, 3 current_digest: digest?, 4 session: u32?,
                  5 limit: u32?, 6 protocol: u8?, 7 oids: list<oid>? }
```

| code | name | used by | extra fields |
| --- | --- | --- | --- |
| 1 | `malformed` | any request whose body fails to decode | `protocol` |
| 2 | `unsupported` | a method or stream kind this build does not serve | — |
| 3 | `not_ready` | any mutation before `wake_reconcile` | — |
| 4 | `stale` | `write_file` with a base that is not the current content; `absent` on an existing path | `current_digest` (omitted when the file is absent) |
| 5 | `not_found` | `read_file` of an absent path or unknown `at`; `wake_reconcile` whose head is not in the machine's store | `oids` (for `wake_reconcile`) |
| 6 | `invalid_path` | an absolute path, an escape, a symlink leaf, a cross-device component | — |
| 7 | `not_regular` | a directory, FIFO, socket or device | — |
| 8 | `too_large` | content or file above the limit | `limit` |
| 9 | `busy` | freeze timeout (§9.4.2) | `session` (the blocking one) |
| 10 | `moved_off` | an agent write while the branch is moved off (§9.3.8) | — |
| 11 | `unauthorized` | a local-socket caller outside a registered run; a refused `User` | — |
| 12 | `internal` | anything else | `detail` |

The host maps `stale` to HTTP `409 {code: "stale", current_digest}` (§7.6, T-COL-10).

### Durable events, objects and acknowledgements

```
events payload := union
  1 Durable { 1 seq: u64, 2 event_id: id128, 3 event: Event }      daemon → host
  2 Hint    { 1 hint: Hint }                                        daemon → host, never acknowledged
  3 Ack     { 1 seq: u64, 2 outcome: u8, 3 oids: list<oid>?, 4 error: Error?, 5 haves: list<oid>? }   host → daemon

Event := union
  1 burst      { 1 burst_id: id128, 2 actor: Actor, 3 files: list<BurstFile>, 4 versions_commit: oid, 5 part: u16?, 6 parts: u16? }
  2 captured   { 1 head: oid, 2 tree: oid, 3 base: oid }
  3 reconciled { 1 from: oid, 2 onto: oid, 3 outcome: u8 (1 moved, 2 conflict), 4 paths: list<str>? }
  4 moved_off     reserved for T-COL-05
  5 transcript    reserved for §9.6.6
  6 doc_edit      reserved for T-COL-08a
BurstFile := struct { 1 path: str, 2 change: u8 (1 added, 2 modified, 3 deleted, 4 renamed),
                      3 renamed_to: str?, 4 before_blob: oid?, 5 after_blob: oid?, 6 post_digest: digest? }
Hint := union
  1 file_written { 1 path: str, 2 actor: Actor, 3 post_digest: digest? }
```

`post_digest` is absent only for a deleted file (§7.6 row 6). `captured.base` is the head the host last gave this machine (`wake_reconcile`'s `head`), so the host can tell a capture taken on a base it has since rewritten. When one burst's `Durable` frame would exceed 4 MiB, the daemon sends it as `parts` events with the same `burst_id` and `versions_commit`, `part` 1..=parts, files split in path order; the host writes one activity entry once every part is applied. A single-part burst omits both fields.

Ack outcomes, as bytes after the header (`len`, `kind 0x02`, `stream 0`):

| outcome | meaning | daemon does |
| --- | --- | --- |
| `1 applied` | event applied and receipt `(branch, event_id)` inserted in one transaction | deletes the entry and its pending ref |
| `2 duplicate` | receipt already existed; nothing applied | same as `applied` |
| `3 missing_objects` | `oids` are not in the host store; `haves` lists commits the host holds (its head and main tip) | resends the objects as a bundle with `--not <haves>`, then this event and every later one |
| `5 stale_base` | receipt inserted but the head ref not moved: the `captured` event's `base` is not the head the host last sent this machine | deletes the entry and its pending ref; leaves `refs/smithers/acked/head` alone |
| `4 rejected` | the host will never apply it (`error` says why) | moves the entry to `outbox/dead/`, deletes its pending ref, continues |

For example `Ack{seq 7, applied}` is these 25 bytes:

```
00 00 00 10  02  00 00 00 00      header: len 16, kind events, stream 0
03                                union variant 3 = Ack
00 00 00 0b                       struct body length 11
01 00 00 00 00 00 00 00 07        tag 1 seq = 7
02 01                             tag 2 outcome = applied
```

The host acknowledges in `seq` order. The daemon keeps at most 32 unacknowledged events in flight. After a `missing_objects` or `rejected` ack for seq k, the host ignores every later `Durable` frame until seq k (or k+1 after `rejected`) arrives again. After every `Welcome`, the daemon resends every unacknowledged entry from the lowest seq, each batch preceded by its objects.

**Objects travel as git bundles on object streams.** Spec §9.1.4 says "git push"; the bytes of this contract replace the push with a bundle on the same connection:

1. Before an event enters the outbox, its objects are pinned by `refs/smithers/pending/<event_id hex>` and made durable (`syncfs`), as §9.1.4 step 1 requires.
2. To send events seq a..b, the daemon opens an object stream with a fresh id and writes `git bundle create - refs/smithers/pending/<id>... --not <prerequisites>` as `data` frames, then `eof`. The prerequisites are whichever of `refs/smithers/acked/head` and `refs/smithers/base` exist (`git rev-parse --verify -q`), or the `haves` of the last `missing_objects` ack. Then it sends the `Durable` frames.
3. The host spools the stream, runs `git bundle verify`, and fetches it with refspec `+refs/smithers/pending/*:refs/smithers/branches/<branch>/incoming/*`, so the host alone chooses where machine objects land. It then applies each event: objects present, ref moved (`.../head` for `captured`, `.../bursts/<burst>` for `burst`), receipt inserted, one transaction, then the ack.
4. For `wake_reconcile`, the host sends its head the same way on a host-allocated object stream: `git bundle create - refs/smithers/xfer/<stream> --not <the last head this machine's captures moved the ref to>`, omitting `--not` on a first boot. The daemon fetches the bundle into `refs/smithers/incoming/*` and then sends `close` on that stream (`refused{…}` on failure). The host calls `wake_reconcile{head}` only after that `close`.

`refs/smithers/acked/head` (the last capture whose ack moved the host's head ref) and `refs/smithers/base` (the last head the host sent) are commits the host holds, so the prerequisites verify; if one does not, `missing_objects` carries `haves` to use instead. jj imports only `refs/heads`, `refs/tags` and `refs/remotes`, so `refs/smithers/*` never appears as a bookmark, and `jj util gc` keeps everything they reach.

Rejected: `git push` over HTTP on the relay port (a second authenticated path, a host hook to stop one branch's machine from writing another branch's refs, and a guest→host route `relay` may not have). Rejected: git's `ext::` transport through the connection (a client helper process on the pushing side, plus the same ref-namespace hook). Rejected: the host fetching from the daemon after each event (an extra round trip per event, and C-DUR-04's K3 and K3b kill points stop meaning anything).

### Presence

```
presence payload := union
  1 Snapshot { 1 sessions: list<SessionWhere> }
SessionWhere := struct { 1 session: u32, 2 path: str? }
```

Sent on change, coalesced to at most 4 per second, and every 10 s. `path` is the last file a burst attributed to that session wrote (§8.10.4); the host maps the session to its participant and adds `line` when it has one. Presence and `file_written` skip the outbox (§9.1.4).

### Session, object and document streams

Session (`0x05`) and object (`0x06`) payloads use one fixed layout:

| `msg` | name | layout after `msg` | sessions | objects |
| --- | --- | --- | --- | --- |
| 1 | `data` | `u8 fd` (0 input, 1 output or stdout, 2 stderr), then bytes (≤ 65,536) | yes | yes, `fd` 0 |
| 2 | `eof` | `u8 fd` | yes | yes |
| 3 | `resize` | `u16 cols`, `u16 rows` | pty | no: `bad_value` |
| 4 | `signal` | `u8 sig` (1 INT, 2 TERM, 3 HUP, 4 KILL, 5 QUIT, 6 USR1, 7 USR2) | pty, exec | no |
| 5 | `exit` | `u8 form`; form 0: `i32 code`; form 1: `u8 sig`, `u8 core` (0/1) | yes | no |
| 6 | `window` | `u32 bytes` | yes | yes |
| 7 | `close` | — | yes | yes |
| `0xFF` | `refused` | an `Error` struct | yes | yes |

Each direction of each stream starts with 262,144 bytes (256 KiB) of credit. `data` bytes consume it; `window` returns it. A sender with no credit stops reading its source (§9.6.2). An object stream opens with its first frame from an id in the sender's range and ends with `eof`; the receiver returns credit as it spools.

Document frames (`0x04`) are reserved: the first payload byte is `msg`; `0x01..=0xFE` belong to T-COL-08b, which defines their bodies in S3 without changing the header, the kind number or `0xFF`. Every stage decodes them (header, `msg`, opaque body). The S2 daemon answers each with `refused{unsupported}` on the same kind and stream, and answers `open_doc` and `close_doc` with `unsupported`. Before T-TRM-07, session frames get the same refusal.

### The agent's local socket

`/run/smithers/machined.sock` (`root:agent`, 0660; bound by the broker, served by the daemon) carries the same frames with no handshake: the caller is the peer (`SO_PEERCRED` uid `agent`, cgroup mapped to a registered run). It serves only `read_file`, `write_file` and, from T-TRM-07, `open_session(pty)`. On this socket `write_file`'s schema has no field 4; a request carrying an actor fails with `unknown_field`, and the daemon attributes the write to `run`. The coding agent's TypeScript tools call it through `smithers-machined client read-file|write-file`, which prints one JSON object, so no third codec exists.

Rejected: a TypeScript codec of these frames (a third codec to keep byte-equal); a separate JSON-lines protocol for the socket (a second schema for the same two calls).

### Golden frames

`packages/backend/internal/compose/testdata/cocontracts/` holds `<name>.bin`, `<name>.json` and `MANIFEST.json`. `gen.mjs` (Node, no dependencies) writes every `.bin` from byte tables of its own, never from either codec; `node gen.mjs --check` regenerates into a temporary directory and fails on any difference. `MANIFEST.json` records `protocol`, the `yrs` pin (`=0.27.4`), each frame's direction, SHA-256 and expected result (`ok` or a `ProtocolError` name), and named sequences of frames. T-COL-08b adds document frames and the `yjs` pin.

Each codec's test, for every frame: decodes the `.bin` and compares the value with the `.json`; for `ok` frames, encodes the `.json` value and compares bytes; for refusal frames, asserts the exact error code. The Rust fake host and the Go fake daemon replay the sequences byte for byte.

| group | frames |
| --- | --- |
| handshake | `hello_challenge`, `hello_host_proof`, `hello_machine`, `hello_welcome`, `goodbye_version_mismatch`, `goodbye_auth_failed`, `goodbye_superseded` |
| implemented calls | `req_status`/`res_status`, `req_read_file`/`res_read_file`, `req_read_file_at`, `req_write_file`/`res_write_file`, `req_write_file_absent`, `err_stale`, `err_stale_absent`, `req_capture`/`res_capture`, `req_wake_reconcile`, `res_wake_unchanged`, `res_wake_moved`, `res_wake_conflict` |
| stub calls | `req_open_session`, `req_tcp_connect`, `req_close_session`, `req_kill_sessions_user`, `req_kill_sessions_run`, `req_register_run`, `req_rebase`, `req_return_to_item`, `req_open_doc`, `req_close_doc`, `req_attach_session`, each with `res_unsupported_<method>` |
| errors | `err_not_ready`, `err_not_found`, `err_invalid_path`, `err_not_regular`, `err_too_large`, `err_busy`, `err_moved_off`, `err_unauthorized`, `err_malformed_unknown_field` |
| events | `ev_burst`, `ev_burst_rename_delete`, `ev_burst_part`, `ev_captured`, `ev_reconciled_moved`, `ev_reconciled_conflict`, `hint_file_written`, `presence_snapshot` |
| acks | `ack_applied`, `ack_duplicate`, `ack_missing_objects` (with `haves`), `ack_rejected`, `ack_stale_base` |
| streams | `obj_data`, `obj_eof`, `sess_data_in`, `sess_data_out`, `sess_data_err`, `sess_eof`, `sess_resize`, `sess_signal_int`, `sess_exit_code`, `sess_exit_signal`, `sess_window`, `sess_close`, `sess_refused_unsupported`, `doc_reserved_sync`, `doc_refused_unsupported` |
| refusals | `bad_unknown_field_uid` (`write_file` with tag 9), `bad_actor_names_branch` (a `principal` struct with tag 2), `bad_truncated_header`, `bad_truncated_payload`, `bad_oversized_control`, `bad_unknown_kind`, `bad_stream_on_control`, `bad_trailing_bytes`, `bad_unordered_field`, `bad_missing_field`, `bad_utf8_path`, `bad_actor_variant_from_host`, `local_write_with_actor` |
| sequences | `seq_handshake`, `seq_write_stale`, `seq_capture` (bundle, `captured`, ack), `seq_missing_objects` (ack `missing_objects`, resent bundle, event, ack), `seq_duplicate_receipt` (resent event, `ack_duplicate`), `seq_reconnect_replay` (drop after seq 7; new handshake; seq 7 and 8 resent in order), `seq_reserved_doc_s2`, `seq_newer_boot` (live connection gets `goodbye_superseded`), `seq_wake_objects` (host bundle, daemon `close`, `wake_reconcile`) |

`doc_reserved_sync` decodes successfully in every stage; `seq_reserved_doc_s2` proves the S2 handler answers `doc_refused_unsupported`, not a decode failure.

## Consequences

- One codec per language: Go in `internal/machined/wire` (stdlib only, enforced by a `go list -deps` test), Rust in `smithers-machined`. T-COL-03, T-COL-03f, T-COL-04 and T-COL-08b import the Go one and define no frame types.
- A frame change increments `protocol`, regenerates the fixtures, and fails both codecs until both pass.
- Spec §9.1.4's "git push" is implemented as a bundle on an object stream. §9.5.3's "presents the secret" is implemented as an HMAC proof. Both need the spec edits listed at the end of the design document.
- The transport decision (T-COL-11) changes the boot file and the host's `LinkSource`, nothing else.
- The daemon stays identity-agnostic: it never parses a participant, so M-34 participant changes need no daemon release.
