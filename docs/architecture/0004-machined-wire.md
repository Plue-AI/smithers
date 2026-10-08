# ADR 0004: The machine daemon's wire contract

Status: accepted at protocol 6 (2026-10-07; smithers-8a rulings 820aa0d89b, 94715a1b07, 7f11af21a8, 02fe2e50a2; smithers-3f independent wire sign-off on #3626, corpus 13de9c59b7). Protocol 7 (36e1705ca0, #3508) is under 3f delta review on #3626; protocol 8 (0e17d29b83, #3567: `status` fields 7 `bursts_idle` and 8 `documents_flushed`) is under 3f delta review on #3567; protocol 9 (f478219e32, #3532: `inspect_conflict` method 18, `status` back to fields 1–8 with no arguments) is under 3f delta review on #3532; protocol 10 (#3532: optional Rebase `source_base` for the fenced whole-TODO delta) awaits 3f post hoc delta review under the parallel-build directive, with approval not claimed; protocol 11 covers the pre-ready host recovery `inspect_conflict` admission rule from 627e54fae3 and the object-stream-free variant-5 `transcript` Durable delivery and rejected-transcript outbox removal rules from bf59372efd, under [smithers-8a’s ruling on #3532](https://github.com/smithersai/smithers/issues/3532#issuecomment-6064535416); protocol 12 adds variant-5 field 10 `skipped` under [smithers-8a’s option A ruling](https://github.com/smithersai/smithers/issues/3622#issuecomment-6064967768); every later bump takes a recorded 3f delta review and does not reopen this acceptance. Owner: T-COL-03r ([#3626](https://github.com/smithersai/smithers/issues/3626)). The golden frames under `packages/backend/internal/compose/testdata/cocontracts/` gate the Go codec (`packages/backend/internal/machined/wire/`) and the Rust codec (`crates/smithers-machined/src/conn.rs`, `src/msg.rs`).

## Context

`smithers-machined` runs inside every branch machine and keeps one multiplexed connection to the host (spec §9.1.1). That connection carries control RPC, durable change events and their acknowledgements, presence, terminal and SSH sessions, git objects, and in stage 3 live-document frames. Two codecs speak it: Go on the host, Rust in the guest. Their first consumers are T-COL-03 (host registry), T-COL-03a (daemon core), T-COL-03f (Go fake daemon), T-COL-04 and T-COL-04a (watcher and events), T-TRM-07 (sessions) and T-COL-08a/08b (documents, S3).

No surviving daemon wire exists to reuse. The deleted Go guest protocol (`4a9e413dbd^:packages/backend/sandbox/guest/protocol.go`) used length-prefixed JSON RPC with `Hello` and `Authenticate`. It was a single stream without credit, object streams or outbox acknowledgements, so restoring its format would not meet this contract. The terminal WebSocket (`packages/backend/internal/routes/terminal_session_manager.go`) has no request correlation, acknowledgement or actor envelope. The guest helper's `relay` and `bridge` (`packages/backend/microsandbox/guest/smithers-guest.py:419`, `:441`) are byte pipes with no framing. Both stay the byte transport underneath this contract.

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
| 2 | host | `2 HostProof` | `1 protocol: u16`, `2 mac: digest` = HMAC-SHA256(relay secret, `"smithers-machined host"` ‖ protocol (u16, big-endian, the HostProof's field 1) ‖ boot_id ‖ nonce) |
| 3 | daemon | `3 MachineHello` | `1 credential: bytes` (≤ 1,024; the per-boot `machine` token), `2 instance: id128` (this daemon process), `3 next_seq: u64` (lowest unacknowledged seq, or the next seq), `4 sessions: list<u32>` (live sessions open for re-attach) |
| 4 | host | `4 Welcome` | empty |
| any | either | `5 Goodbye` | `1 code: u8` (`ProtocolError`), `2 detail: str` optional |

The host finds the machine, its relay secret and its expected credential by `boot_id`, which works when every machine dials one shared bridge port. It refuses with `auth_failed` when the proof or credential is wrong or the credential belongs to another boot. A newer boot's credential is minted only when the older one is revoked, so an older boot always fails `auth_failed` and "newer replaces older" needs no clock. Otherwise it sends `Goodbye{superseded}` to the branch's live connection, if any, closes it, and sends `Welcome`. `MachineHello.sessions` holds at most 512 ids and `Goodbye.detail` at most 1,024 bytes; longer is `bad_value`. Each step times out after 5 s. After `Welcome`, the host calls `status()` at least every 10 s; a daemon that hears nothing for 30 s treats the connection as lost.

The boot file `/run/smithers/machined/boot` (written by the runtime, T-COL-03; owner `machined`, mode 0400) holds one `key=value` per line: `boot_id` (32 hex), `relay_secret` (64 hex), `credential`, `topology` (`relay` or `bridge`) and, for `bridge`, `bridge_port`.

Rejected: the host presenting the relay secret as a bearer value (§9.5.3's wording). A process that reached the listening port first, or a stale bridge listener, would learn the secret; the HMAC proof costs one extra half round trip and leaks nothing. Rejected: version negotiation. Host and daemon ship in one bundle and the daemon is planted, digest-checked, on every boot (§16.1.1), so a skew lives only until the machine's next boot; one exact `protocol` value keeps one code path.

`protocol` is `12`: protocol 5's exact live-connection rule (8a, 2026-10-07,
#3626) continues. Protocol 8 adds optional status observations 7 `bursts_idle`
and 8 `documents_flushed` (T-MCH-06, #3567). Protocol 9 moves conflict inspection to method 18 with two required OIDs and a required paths list ([owner ruling](https://github.com/smithersai/smithers/issues/3532#issuecomment-6052691254)). `status()` takes no arguments, returns only fields 1–8, and never freezes writers. `inspect_conflict` requires ready admission for ordinary consumers, validates the retained change and target, and freezes writers while draining the watcher and inspecting resolution. Protocol 11 records pre-ready host recovery inspection (627e54fae3), variant-5 `transcript` Durable delivery without a preceding object stream, and removal of rejected transcripts from the outbox rather than retention as refused change events (bf59372efd). Protocol 12 adds optional transcript field 10 `skipped: u64` for a daemon-written skipped-line note. There is no negotiation or older live protocol accepted. Host and daemon
ship in the same verified install bundle (spec §17.3); a different handshake
version ends the connection with `version_mismatch` (error 13) before credentials
or operations. Any wire change increments the version and regenerates the golden
frames for both codecs. A wire change includes any change to the admission, ordering or refusal rules this record states, such as which methods a daemon admits before `wake_reconcile`, even when frame bytes are unchanged; `Wire-Unchanged:` covers only changes that alter neither bytes nor stated behavior (8a, 2026-10-08, after 627e54fae3). A bump changes one value in four places in the same commit: this section, Go `wire.Protocol`, Rust `conn::PROTOCOL` and `MANIFEST.json` `protocol`; the version-refusal fixtures are always protocol − 1 and protocol + 1, and the cross-language test fails if any of the four differ. After acceptance, each bump lands with smithers-3f's delta review of the new or changed frames recorded on the change's issue; it does not reopen acceptance (8a, 2026-10-07). Existing persisted history remains readable as required
by the repository's permanent interaction rules; historical decoding never
admits an older live connection. The amendment sections record earlier formats.


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
| 1 | `status` | empty | `1 state: u8` (1 booting, 2 reconciling, 3 ready), `2 protocol: u16`, `3 version: str`, `4 outbox_depth: u32`, `5 acked_head: oid`?, `6 lock_queue: u16`, `7 bursts_idle: bool`?, `8 documents_flushed: bool`? | T-COL-03a, T-MCH-06 |
| 2 | `read_file` | `1 path: str`, `2 at: oid`? | `1 content: bytes`, `2 digest: digest`, `3 mode: u32` | T-COL-03a |
| 3 | `write_file` | `1 path: str`, `2 base: Base`, `3 content: bytes`, `4 actor: Actor` | `1 post_digest: digest`, `2 raced: Raced`? | T-COL-03a |
| 4 | `capture` | — | `1 head: oid`, `2 tree: oid`, `3 flushed_documents: u16` (the flush phase's count; 0 until S3) | T-COL-03a |
| 5 | `wake_reconcile` | `1 head: oid` | `1 outcome: union {1 unchanged {}, 2 moved {1 head: oid}, 3 conflict {1 paths: list<str>}}` | T-COL-03a |
| 6 | `open_session` | `1 user: User`, `2 kind: u8` (1 pty, 2 exec, 3 sftp), `3 argv: list<str>`?, `4 size: Size`?, `5 principal: id128`?, `6 run: str`? | `1 session: u32` | T-TRM-07; `unsupported` |
| 7 | `tcp_connect` | `1 port: u16`, `2 principal: id128`?, `3 run: str`? | `1 session: u32` | T-TRM-07; `unsupported` |
| 8 | `close_session` | `1 session: u32` | — | T-TRM-07; `unsupported` |
| 9 | `kill_sessions` | `1 target: union {1 user {1 user: User}, 2 run {1 run: str}, 3 session {1 session: u32}}` | `1 killed: u16` | T-TRM-07; `unsupported` |
| 10 | `register_run` | `1 run: str`, `2 session: u32` | — | T-COL-04; `unsupported` |
| 11 | `rebase` | `1 onto: oid`, `2 actor: Actor`, `3? source_base: oid` | `1 head: oid`, `2? paths: list<str>` | T-STK-08; native paths inspected under the rewrite lock |
| 12 | `return_to_item` | `1 actor: Actor` | `1 head: oid` | T-COL-05; `unsupported` |
| 13 | `open_doc` | `1 path: str`, `2 actor: Actor.principal` | `1 stream: u32` | T-COL-08a (S3); `unsupported` |
| 14 | `close_doc` | `1 stream: u32` | — | T-COL-08a (S3); `unsupported` |
| 15 | `attach_session` | `1 session: u32`, `2 received: u64` | `1 received: u64` | T-TRM-07; `unsupported` |
| 16 | `set_roster` | `1 members: list<User>` | — | working-together W5; `unsupported` until broker ready |
| 17 | `write_files` | `1 changes: list<{1 path: str, 2 base: Base, 3 content: bytes?}>` (content absent deletes), `2 actor: Actor.principal` | `1 writes: list<{1 post: Base, 2 raced: Raced?}>`, `2 failure: BatchFailure`? | T-COL-10 (see Compared text batches; Delete and move batches) |
| 18 | `inspect_conflict` | `1 conflict_change: oid`, `2 onto_revision: oid` | `1 paths: list<str>` | T-STK-08 |

`Raced := struct {1 path: str, 2 displaced_digest: digest}`. A write success
without tag 2 is `applied`; with tag 2 it applied while preserving the displaced
outside version. The existing `stale` error is unchanged. No rollback follows
an exchange race. The roster is replaced atomically, including an empty roster;
unlisted users' sessions are killed before the reply. Send it after Welcome,
before ready, and after every roster change. A missing/unsupported roster hook
must prevent session admission, not grant access. `set_roster` is host-only.

`?` marks an optional field. `Base := union {1 digest {1 digest: digest}, 2 absent {}}`. `Size := struct {1 cols: u16, 2 rows: u16}`. `rebase` and `return_to_item` carry the actor the rewrite is attributed to ("Rebased onto Tk"). `attach_session` re-attaches a stream after a reconnect (§9.6.4): each side reports how many bytes it received and the other resends from there; unacknowledged bytes never exceed the 256 KiB credit, so that is all either side keeps.

T-MCH-06 adds optional status observations 7 and 8 without changing existing frames. The native core reads them on the mutation lock after draining watcher events. An unavailable watcher or document provider omits its observation. A peer with a different protocol is refused. Capture still flushes, snapshots, publishes and drains before stop.

Rebase field 3 carries the stack-fenced verified base when a native Bring-in changed the physical parent. The daemon merges the whole captured item delta from that immutable base, keeping the bound logical change. Missing base objects refuse before capture; older schemas reject the unknown field before dispatch. The base is unprivileged object data and never reaches the root broker. Requests without field 3 retain their existing decoding.

T-STK-08 also reuses `inspect_conflict` (18), with its unchanged two required OIDs and paths result, to recover an existing stack-owned rebase conflict before writer admission. Only the authenticated host's internal admission path can issue this call before ready. It first verifies that the daemon's acknowledged head is the host-selected head; native inspection then verifies the boot's item authority, retained conflict and exact target under the existing barrier. A successful inspection restores maintenance admission, subject to the current roster and actual daemon status. Ordinary wake conflicts remain unready. The method, fields and frame bytes are unchanged; protocol 11 records this admission-rule change.

T-STK-08 uses `inspect_conflict` (18) for native conflict inspection. With the required retained change and onto revision, the daemon freezes broker writers with the fixed one-second deadline, flushes documents and inspects the same logical change under its mutation lock. A changed target is refused; every inspection outcome thaws. Result field 1 `paths` is required even when empty; a missing result is never successful Done. `status()` remains observational and never enters this barrier.

Until ordinary `wake_reconcile` or the bound retained-conflict admission succeeds on this boot, every method except `status`, `wake_reconcile`, authenticated host recovery inspection and handshake roster synchronization
(`set_roster`) answers `not_ready`.

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
  4 moved_off  { 1 actor: Actor, 2 item: u64, 3 pre_move_commit: oid, 4 returned: bool? }
  5 transcript    defined by wire review ruling 2 (below)
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

A `transcript` event (variant 5, ruling 2) is text and names no git object. It has no pending ref, so steps 1 to 3 do not apply to it: the daemon sends its `Durable` frame with no object stream before it, in queue order with the events around it, and the host applies it with no bundle to verify. A `rejected` transcript record is removed from the daemon's outbox; it is a member's own text and is not kept as a refused change event is. Transcript refusal (protocol 11, d64cae2a43; smithers-8a ruling 2026-10-08): the host answers a variant-5 `Durable` with a `rejected` receipt when the install has no import, when the adapter faults, or when the session has no receipt after 2 s; it never closes the link for these.

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

`/run/smithers/machined.sock` (`root:agent`, 0660; bound by the broker, served by the daemon) carries the same frames with no handshake: the caller is the peer (`SO_PEERCRED` uid `agent`, cgroup mapped to a registered run). It serves only `read_file`, `write_file` and, from T-TRM-07, `open_session(pty)`. On this socket `write_file`'s schema has no field 4; a request carrying an actor fails with `unknown_field`, and the daemon attributes the write to the parent session’s committed principal reference. Both the reference and run are inherited from the root broker’s kernel cgroup binding, never from request fields. The coding agent's TypeScript tools call it through `smithers-machined client read-file|write-file`, which prints one JSON object, so no third codec exists.

Rejected: a TypeScript codec of these frames (a third codec to keep byte-equal); a separate JSON-lines protocol for the socket (a second schema for the same two calls).

### Golden frames

`packages/backend/internal/compose/testdata/cocontracts/` holds `<name>.bin`, `<name>.json` and `MANIFEST.json`. `gen.mjs` (Node, no dependencies) writes every `.bin` from byte tables of its own, never from either codec; `node gen.mjs --check` regenerates into a temporary directory and fails on any difference. `MANIFEST.json` records `protocol`, the `yrs` pin (`=0.27.4`), the HostProof `handshake_vectors` (secret, boot_id, nonce, protocol, the exact MAC input bytes and the mac, computed with Python's `hmac`), each frame's direction, SHA-256, expected decode result (`ok` or a `ProtocolError` name), for handshake frames the vector they answer and, when decoding accepts a frame the handshake must refuse, its `handshake` outcome (`auth_failed`, `version_mismatch`); named `sequences` whose steps are `{conn, frame}`; and `refusal_sequences`, each naming the side whose production handshake must refuse (`by: daemon` runs Rust `link::authenticate`, `by: host` runs Go `Registry.Connect`) and the expected error, after which that side must send `goodbye_<expected>`. T-COL-08b adds document frames and the `yjs` pin.

Each codec's test, for every frame: decodes the `.bin` and compares the kind, stream and canonical tagged payload with the `.json`; for `ok` frames, encodes the `.json` value and compares bytes; for refusal frames, asserts the exact error code; for proofs, checks the production verifier against the vector. The Rust fake host and the Go fake daemon replay the sequences byte for byte, one stream per connection.

| group | frames |
| --- | --- |
| handshake | `hello_challenge`, `hello_host_proof` (vector `a`), `hello_challenge_b`, `hello_host_proof_b` (vector `b`), `hello_challenge_c`, `hello_host_proof_c` (vector `c`: `b`'s boot, a fresh nonce), `hello_machine`, `hello_machine_b`, `hello_welcome`, `goodbye_version_mismatch`, `goodbye_auth_failed`, `goodbye_superseded`, `goodbye_handshake_order`, `goodbye_detail` |
| handshake refusals | `hello_host_proof_bad_mac` (decodes; handshake `auth_failed`), `hello_challenge_older`, `hello_host_proof_older` (`protocol` − 1: decodes as history; handshake `version_mismatch`), `hello_challenge_newer`, `hello_host_proof_newer` (`protocol` + 1: decoder `version_mismatch`); the proofs carry the current mac, so the version check precedes the MAC |
| implemented calls | `req_status`/`res_status`, `res_status_no_acked_head`, `req_read_file`/`res_read_file`, `req_read_file_at`, `req_write_file`/`res_write_file`, `res_write_file_raced`, `req_write_file_absent`, `err_stale`, `err_stale_absent`, `req_capture`/`res_capture`, `req_wake_reconcile`, `res_wake_unchanged`, `res_wake_moved`, `res_wake_conflict`, `req_set_roster`, `req_set_roster_empty`, `res_set_roster`, `req_write_files`, `res_write_files`, `res_write_files_stale` (`current_digest`), `res_write_files_partial`, `local_write_files`, `local_write_files_actor` (`unknown_field`), `req_delete_files`, `res_delete_files`, `local_delete_files`, `req_move_files`, `res_move_files` (receipts `absent`, then `digest`), `req_delete_files_dotdot`, `req_delete_files_absolute` (decode; answered by `res_write_files_invalid_path`, a preflight `invalid_path` with no receipts), `res_write_files_busy` (an application `busy` failure, not preflight) |
| stub calls | `req_open_session`, `req_open_session_admitted` (tags 5, 6), `req_tcp_connect`, `req_tcp_connect_admitted` (tags 2, 3), `req_close_session`, `req_kill_sessions` (session target), `req_kill_sessions_user`, `req_kill_sessions_run`, `res_kill_sessions` (`killed` 1), `res_kill_sessions_none` (`killed` 0), `local_open_session`, `local_open_session_admitted` (decodes; the local socket refuses it), `req_register_run`, `req_rebase`, `req_return_to_item`, `req_open_doc`, `req_open_doc_s3`, `req_close_doc`, `req_close_doc_s3`, `req_attach_session`, each method with `res_unsupported_<method>` |
| errors | `err_not_ready`, `err_not_found`, `err_invalid_path`, `err_not_regular`, `err_too_large`, `err_busy`, `err_moved_off`, `err_unauthorized`, `err_internal`, `err_malformed_unknown_field` |
| events | `ev_burst`, `ev_burst_rename_delete`, `ev_burst_part`, `ev_captured`, `ev_reconciled_moved`, `ev_reconciled_conflict`, `ev_moved_off`, `ev_moved_off_returned` (tag 4 `returned` = 1: `ok`), `bad_value_moved_off_returned` (tag 4 = 2: `bad_value`), `ev_reserved_moved_off` (`missing_field`), `ev_reserved_doc_edit`, `ev_reserved_doc_edit_body` (`bad_value`), `ev_transcript`, `ev_transcript_skipped`, `ev_transcript_skipped_5mib`, `ev_transcript_skipped_{both,note_over_1kib,span,overflow}` (`bad_value`), `ev_transcript_bad_utf8` (`bad_utf8`), `ev_transcript_partial` (a newline in the record: `bad_value`), `bad_value_transcript_{version, session_zero, session_over, participant_zero, source_zero, profile_empty, generation_zero, end_not_after_start, span, record_empty, record_over_1mib}` (ruling 2's bounds), `ev_transcript_record_at_limit` (1 MiB record: `ok`), `ev_transcript_bad_utf8_nul` (NUL in the record: `bad_utf8`), `hint_file_written`, `presence_snapshot`; every event has its own `event_id` |
| acks | `ack_applied`, `ack_duplicate`, `ack_missing_objects` (with `haves`), `ack_rejected`, `ack_stale_base`, `ack_captured` |
| streams | `obj_data`, `obj_eof`, `obj_close`, `obj_window` (stream 1), `obj_resend_data`, `obj_resend_eof` (stream 2), `obj_replay_data`, `obj_replay_eof` (stream 3), `obj_host_data`, `obj_host_eof`, `obj_host_close` (stream `0x80000001`), `sess_data_in`, `sess_data_out`, `sess_data_err`, `sess_eof`, `sess_resize`, `sess_signal_int`, `sess_exit_code`, `sess_exit_signal`, `sess_window`, `sess_close`, `sess_refused_unsupported`, `doc_reserved_sync`, `doc_refused_unsupported` |
| documents | `doc-*` (the 11 browser tables in `doc-daemon.json`), `doc-input-v2`, `doc-saved-v2`, `doc-input-v2-zero`, `doc-saved-v2-max` |
| refusals | `bad_unknown_field_uid` (`write_file` with tag 9), `bad_actor_names_branch` (a `principal` struct with tag 2), `bad_actor_variant_from_host`, `local_write_with_actor`, `local_write_without_actor` (`ok`), `bad_truncated_header`, `bad_truncated_payload`, `bad_unknown_kind`, `bad_stream_on_control`, `bad_stream_zero_documents`, `bad_stream_zero_sessions`, `bad_stream_zero_objects`, `bad_oversized_control`, `bad_oversized_hello`, `bad_oversized_events`, `bad_oversized_presence`, `bad_oversized_documents`, `bad_oversized_sessions`, `bad_oversized_objects` (each the kind's maximum + 1), `bad_trailing_bytes` (one byte after `Welcome` inside `len`), `bad_unknown_message_hello`, `bad_unknown_message_events`, `bad_unknown_message_presence`, `bad_unknown_method`, `bad_unordered_field`, `bad_missing_field`, `bad_roster_missing_uid`, `bad_raced_missing_digest`, `bad_utf8_path`, `bad_utf8_write_files_path_nul`, `bad_value_str_over_4096`, `bad_value_write_files_path_over_4096`, `bad_value_principal_over_1024`, `bad_value_credential_over_1024`, `bad_value_sessions_over_512`, `bad_value_goodbye_detail_over_1024`, `bad_value_sess_data_over_65536`, `bad_value_obj_resize`, `bad_value_obj_data_fd`, `bad_value_sess_exit_form`, `bad_value_ack_outcome`, `bad_value_obj_signal`, `bad_value_obj_exit`, `bad_unknown_message_sessions`, `bad_unknown_message_objects`, `bad_value_sess_window_zero`, `bad_value_sess_window_over` (ruling 5's bounds), `content_at_limit` (`ok`), `content_over_limit` |
| sequences | `seq_handshake`, `seq_write_stale`, `seq_capture` (bundle, `captured`, ack), `seq_missing_objects` (ack `missing_objects`, bundle resent on a fresh stream, event, ack), `seq_duplicate_receipt` (resent event, `ack_duplicate`), `seq_reconnect_replay` (drop after seq 7; new handshake; the batch's bundle, then seq 7 and 8), `seq_reserved_doc_s2`, `seq_newer_boot` (connections `a`, `b`, `c`: ruling 4), `seq_wake_objects` (host bundle, daemon `close`, `wake_reconcile`), `seq_working_together`, `seq_move_files`, `seq_delete_dotdot`, `seq_delete_absolute` (`invalid_path`), `seq_delete_busy` |
| refusal sequences | `seq_order_daemon`, `seq_order_host` (`handshake_order`), `seq_version_older_daemon`, `seq_version_newer_daemon`, `seq_version_older_host`, `seq_version_newer_host` (`version_mismatch`), `seq_bad_mac_daemon` (`auth_failed`) |

`doc_reserved_sync` decodes successfully in every stage; `seq_reserved_doc_s2` proves the S2 handler answers `doc_refused_unsupported`, not a decode failure.

## Consequences

- One codec per language: Go in `internal/machined/wire` (stdlib only, enforced by a `go list -deps` test), Rust in `smithers-machined`. T-COL-03, T-COL-03f, T-COL-04 and T-COL-08b import the Go one and define no frame types.
- A frame change increments `protocol`, regenerates the fixtures, and fails both codecs until both pass.
- Spec §9.1.4's "git push" is implemented as a bundle on an object stream. §9.5.3's "presents the secret" is implemented as an HMAC proof. Both need the spec edits listed at the end of the design document.
- The transport decision (T-COL-11) changes the boot file and the host's `LinkSource`, nothing else.
- The daemon stays identity-agnostic: it never parses a participant, so M-34 participant changes need no daemon release.

## Implementation evidence (2026-10-05)

The exported Go `Read`, `Decode`, `DecodeLocal`, `Encode`, `EncodeLocal` and
`RequestFrame` and Rust `Frame::{read,decode,decode_local,encode,encode_local}`
share the framing above. `msg` exposes method and error discriminants; tagged
payload builders construct requests without a second framing implementation.
The 224 literal frames (14 sequences, 7 refusal sequences) include 1 MiB and 1 MiB + 1 content fixtures and preserve
the browser document fixtures. The JSON companion records kind, stream and the
canonical payload as hex and, for tagged payloads, a `literal` tree of
`[tag, value]` fields that `gen.mjs` builds alongside the bytes; it never
records JSON sent over the connection. `gen.mjs` also fails when this ADR's
`protocol`, Go `wire.Protocol` or Rust `conn::PROTOCOL` differs from its own.
`gen.mjs --check` verifies the independent byte tables and manifest hashes.

The compiled executable exits 78 before opening a connection or invoking a
hook. Fake-host tests feed literal frames through the production decoder and
dispatcher, including correlated malformed replies and S2 document refusals.
The FIFO executor supports asynchronous waiting, drains admitted mutations,
retains jobs when a waiter disappears and continues after a job panics.
These are component receipts, not C-DUR-04 or real-machine confinement evidence.
No acceptance or security approval is inferred from passing tests.

### S3 document payloads (T-COL-08b)

The kind remains `0x04`, with the daemon-allocated `open_doc(path)` stream;
`close_doc(stream)` closes that exact stream. S3 adds required tag 2
`actor: Actor.principal` to `open_doc` so the epoch notice can bind a client id
before the first browser update. No branch selector is accepted
inside a payload: the authenticated connection supplies it. The following
fixed bodies follow `msg`; all fixed integers are big-endian. The existing
`0xFF refused` Error struct remains unchanged.

| msg | direction | body |
| --- | --- | --- |
| 1 input sync | host → daemon | canonical `Actor.principal`, `seq: u64`, then unchanged y-protocols sync bytes |
| 2 input awareness | host → daemon | canonical `Actor.principal`, then unchanged awareness bytes |
| 3 sync | daemon → host | unchanged y-protocols sync bytes |
| 4 awareness | daemon → host | unchanged awareness bytes |
| 5 epoch | daemon → host | epoch `id128`, client id `u32` (nonzero) |
| 6 saved | daemon → host | Unix milliseconds `u64`, `through_seq: u64`, then saved state-vector bytes |
| 7 gone | daemon → host | form `u8` (1 deleted, 2 renamed), `by: str`, then `to: str` for renamed |

The actor comes exclusively from the host authorizer, never a browser payload.
The daemon rejects client-id and authors-map spoofing before applying updates.
The host opens one stream per open code path as the daemon's trusted peer and
fans the daemon's frames out to that path's subscribers (ADR 0003: it relays
document bytes unparsed and keeps no replica). Browser subscriptions and their
client ids belong to the host. The opener takes the epoch notice's client id;
for every other subscriber the host sends one authors-map registration
(`authors[client] = actor key`, written by a one-use registrar client) under
that subscriber's actor, and the daemon accepts it only as one new author for
the envelope's actor. A client id stays bound to its actor for the epoch: a
subscriber that resubscribes after a gap keeps it, so its unsaved updates
resend as the same author. After a host restart the host has no record of a
requested id, so it asks the daemon: it sends an awareness removal notice for
that client under the subscriber's actor, which the daemon echoes only when
its authors map assigns the client to that actor. The host admits the id on
the echo and assigns a new one on `refused`; another member cannot claim it. The daemon answers each input with exactly one
frame, in order (sync step 2, the update's echo, or `refused`), so the host
answers sync step 1 only to the subscriber that asked, fans an echo out to the
others, and ends only the subscriber whose input was refused. The host
enforces the browser's 2 MiB send budget per subscriber and gaps only that
subscriber.

Open documents per link are bounded by `MaxOpenDocuments` = 16 open code paths.
The host refuses a further `open_doc` itself with `busy` ("open document
limit"), sends nothing to the daemon, and the subscription is refused
`unsupported`. A daemon stream whose reader falls behind its 2 MiB queue gaps
alone; neither an overflow nor a refused `open_doc` or `close_doc` closes the
link. Epoch precedes sync; the host never manufactures code durability receipts.
Sequences are monotonic per stream; repeating a sequence with different update
bytes is refused. `through_seq` covers every input through that sequence,
including delete-only updates that do not advance a state vector. Reconnect
requires resync and remapping pending browser receipts to the new stream.

Document frame bodies retain the existing 4 MiB daemon framing maximum; the
browser connection has the stricter 2 MiB unsent budget. Missing topology,
authenticated connection or document handler returns unsupported.

### Working-together I1 compatibility (2026-10-06)

The amended document bodies above are **document protocol 2**. They have no
in-band discriminator: do not guess the layout from length or Yjs bytes.
Go `EncodeDocumentV2`/`DecodeDocumentV2` and Rust
`Document::encode_v2`/`decode_v2` select it explicitly. Existing unversioned
entry points continue decoding and encoding protocol 1 recordings byte for byte
(actor then sync bytes; milliseconds then state-vector bytes). All other document
messages and `open_doc{path, actor}` are unchanged. The optional actor accepted
by the envelope decoder exists only to retain S2 recordings; a live document
handler still requires the authenticated actor.

Document protocol 2 was introduced on connection protocol 2; connection protocol 3 retains those document bodies. The host and daemon require a
matching protocol in the handshake before selecting these entry points and
fail closed on mismatches; never fall back to a protocol 1 save receipt for
pending sequenced edits. Protocol 1 remains available for decoding recordings.
I1 supplies the codec contract and golden proof, not real-machine qualification
of the document host or daemon process.
Control method 16 and optional write-result tag 2 are additive; old frame bytes,
old malformed-frame outcomes, and old document interpretations are unchanged.

The §10 I1 exact shape takes precedence over §3's shorthand `applied{raced:[path]}`:
the single-file RPC carries one optional `Raced` record; I3 aggregates those
records into `raced[]`, and I7 resolves the saved version for the HTTP reply.

### Durable session admission (connection protocol 3, 2026-10-07)

Live session launches require protocol 3 and a nonzero 16-byte principal
reference committed by the host before sending the request. `open_session`
carries it in tag 5 and an agent's run in tag 6. An agent session requires its
run at admission; member sessions cannot claim a run. `tcp_connect` carries its
reference in tag 2 and optional run in tag 3. TCP remains a fixed unprivileged
relay, with no caller-selected executable. The fields remain optional in the
record decoder solely to retain existing frames and local PTY requests; the
live host and root broker refuse unattributed host launches.

The broker reserves the reference and run before spawn, retains them through
close and failed cleanup, and uses that reference for observed-write events.
A local PTY inherits the parent's entire binding. Local requests carrying
admission fields decode, and the daemon answers them with `Error{unauthorized}` (control error 11) without acting (8a, 2026-10-07). `register_run` may confirm an already admitted
run, but cannot bind or replace one after execution starts. Older actor variants
remain decodable; they do not authorize reconstructing identity from a reused
session number. See the [recovery contract](../../.specs/engineering/design/session-attribution-recovery.md)
for the remaining direct-write/document/rewrite and historical migration work.

### Individual command cancellation (connection protocol 4, 2026-10-07)

`kill_sessions` target 3 names one existing session ID. The broker kills and
reaps that session's entire cgroup, including detached descendants, before
answering `killed=1`. An already reaped ID returns `killed=0`, making a lost
reply retryable. Other sessions sharing its run or unix user stay alive.
A failed cleanup is an error, never a termination receipt: the broker retains
the original attribution and ownership, fences further input/local commands
and reattachment, and retries cleanup when requested.

The host requires protocol 4 before sending this target and keeps the request
bound to the admitted connection. Retained protocol 1–3 recordings still decode;
older live peers refuse this operation instead of falling back to closing stdin
or signaling only a process group. Target 3 is host-only: the local socket's
method set is unchanged. `close_session` retains its ordinary stream-close
semantics and does not certify that an exec command or its descendants stopped.

### Opaque document authors (connection protocol 5, 2026-10-07)

Principal envelopes carry opaque bytes, including the binary committed actor
references. Document author maps and awareness IDs encode those bytes as lowercase
hexadecimal, without a prefix. Go mirrors and the Rust authority use the same
lossless representation. Decoding bytes as UTF-8, replacing invalid characters,
or using a member's display name is not an identity conversion.

The shared document peer uses the admitting actor for open and synchronization;
there is no synthetic `host` principal. Individual edits retain each subscriber's
own admitted actor. The mirror is scoped to the authenticated boot: reconnect to
the same boot retries only unreceipted edits; a replacement boot emits a gap and
requires fresh subscription instead of replaying another machine's actor/cache.

Hosts require protocol 5 for live document opens. Older wire recordings and
stored CRDT author maps remain readable and are not rewritten; freshly allocated
clients use the new key format. `SMTHDOC2` records persist the retired client IDs
from a decoded `SMTHDOC1` record. Those clients retain their historical labels,
but cannot authorize new edits or presence, even when an old label happens to
equal a new actor's hexadecimal key. Host writes allocate a current client
instead of extending a retired clock. The metadata survives save and reopen. This does not by itself bind the production
SQL authorizer, activate the document subsystem, or complete the coding-launcher
and other producer migrations.

### Wire review rulings (8a, 2026-10-07, #3626; 3f's independent review)

1. **The version is authenticated.** The HostProof MAC covers `protocol` (row 2 above), so a relay cannot rewrite it unseen. The daemon checks `protocol` equality first (`version_mismatch`), then the MAC (`auth_failed`). The corpus carries committed vectors (secret, boot_id, nonce, protocol 7, mac), the two vectors introduced at bc7887554b regenerated for protocol 7, and a wrong-mac frame expecting `auth_failed`; both codecs must compute each exact mac.
2. **Durable event variant 5 (transcripts) is defined, not reserved** (superseding this ruling's first version: #3622 ships it, in both codecs). `5 transcript` payload: `1 version: u16` (must be 1), `2 session: u32` (1..=0x7FFFFFFF), `3 participant: id128` (non-zero), `4 source: id128` (non-zero; survives reconnects), `5 profile: str` (non-empty; names the pinned host adapter), `6 generation: u64` (≥ 1; changes only when the identified source is replaced or truncated), `7 start: u64`, `8 end: u64` (end > start, and end − start = length of record + 1, the omitted newline, unless `skipped` is present), `9 record: bytes` (length-prefixed, as #3622 encodes it: one transcript record without its newline. It must be UTF-8 without NUL, else `bad_utf8`; contain no newline, else `bad_value`; and be 1 byte to 1 MiB long, else `bad_value`, so an empty record is refused. Its length is `end − start − 1` unless `skipped` is present), `10 skipped: u64` (optional). When present, `record` is a daemon-written UTF-8 note of at most 1 KiB and `end − start = skipped + 1`; `skipped` counts the file bytes passed over before the newline (at least 1 MiB, including any carried blank lines). The host shows ONE failed, read-only entry, calls no decoder, and admits the next record at this record’s end. A record carrying both a normal agent line and `skipped` is refused as `bad_value`. To keep the note disjoint from agent JSON records, a note whose first byte after ASCII space, tab or carriage return is `{` or `[` is refused as `bad_value`, even with a valid skipped span. There is no in-band text marker. `record` is a display rendering of the range; invalid UTF-8 or NUL bytes become `?` one-for-one; an empty line is carried as the next record’s leading space; the ranges, not the bytes, identify the file content. Any violated bound is `bad_value`; no path, home, uid or executable crosses this event. The transcript frames stay in the manifest under these bounds; an expectation of `bad_utf8` on valid UTF-8 is a fixture bug.
3. **One rule for reserved variants:** a reserved union variant is refused with `bad_value` (a forbidden variant) whatever its body, before the body is decoded. Event variant 6 follows it (variant 5 is defined, ruling 2); document `msg` bytes keep their own §documents rule until T-COL-08b defines them.
4. **Sequences that span connections** name each connection: every sequence step carries `conn` (`a`, `b`, …; default `a`). `seq_newer_boot` is: `a` completes its handshake; `b` (newer boot, same machine) completes its handshake and is accepted; `a` receives `Goodbye{superseded}`; a third connection `c` presenting the older boot's credential receives `auth_failed`.

5. **Named bounds** the contract had left silent (8a, 2026-10-07):
   - an object-stream `data` frame with a non-zero fd, and an `exit` with a form other than 0 (code) or 1 (signal): `bad_value`;
   - a `signal` or `exit` message on an object stream: `bad_value` (a forbidden variant for that stream kind);
   - an unknown `msg` byte on a session or object stream: `unknown_message`, in both codecs;
   - a session `window` grant of 0 or above 262,144 bytes: `bad_value` (credit is 1..=262,144 per grant, and a side's outstanding credit never exceeds 262,144).

6. **`moved_off` tag 4** (8a, 2026-10-07): `returned: bool`, optional. It was added by #3562 (0029cff154) before the bump rule existed and is part of protocol 7's surface. `true` means the branch has been returned to its item (§9.3.8 Return); absent or `false` means it is still moved off. A value other than 0 or 1 is `bad_value`. Fixture `ev_moved_off_returned` uses its own `event_id`, not one shared with another frame.

### Compared text batches (connection protocol 6, 2026-10-07)

Method **17 `write_files`** replaces the host client's serial loop over method
3. It runs as one FIFO mutation job. Args are `{1 changes: list<local_write>,
2 actor: host_actor}`; each change uses the existing `{1 path: str, 2 base: Base,
3 content: bytes}`. The agent-local form has only field 1; its actor comes from
kernel peer credentials and the broker's committed admission, rechecked after
queueing. Client-provided local actors are refused. Rewrite fencing applies to
the whole batch. Method 3 uses the same document batch engine with one change.

The engine validates all paths, UTF-8 content, duplicate/ancestor paths, 1–256
entries and at most 1 MiB combined content before preparing documents. Closed
files are prepared from read snapshots without activating recovery or publishing
versions. Retained closed-document snapshots are bounded to 8 MiB of encoded
CRDT state plus baseline and read bytes. Every base is compared before any
write starts. Open files compare against current document text. A stale base
leaves the entire batch unchanged, including timers and recovery records.

Result 17 is `{1 writes: list<result3>, 2? failure: BatchFailure}`. Receipts
are the durable successful prefix in input order. `BatchFailure` is
`{1 index: u16, 2 preflight: bool, 3 error: Error}`, with a zero-based input
index. A preflight failure has zero receipts; only a preflight `stale` error
means the batch did nothing. After application starts, errors retain the
successful prefix and identify the first write whose completion is uncertain;
that write may also have changed bytes. Later writes are not started. There is
no rollback on I/O failure. A swap-window outside race retains displaced bytes
and returns the ordinary `raced` receipt, without re-comparing later files and
misreporting a partially applied batch as stale. Hosts check receipt counts,
indices, requested post-digests and raced paths before accepting them.

Live connections require protocol 6; hosts do not fall back to the serial
loop. Earlier persisted recordings remain decodable. This capability writes text files;
empty content creates an empty file. Delete/move support and provider
qualification are still required before it can implement the public
`WorkspaceCompareWriter` contract. This addition does not enable that provider
or claim installed-machine acceptance.

### Absent document predecessors (disk record 3, 2026-10-07)

`SMTHDOC3` distinguishes an absent predecessor from a present empty file. It
retains the record-2 layout and adds one byte after the retired-client list,
before the checksum: `0` for absent, `1` for present. An absent predecessor has
empty baseline text and the SHA-256 of empty bytes in the legacy digest slot;
all other flag values and noncanonical absent baselines are refused. The flag
is covered by the checksum. Record-1 and record-2 files remain readable and keep
their predecessor digest as present, including the digest of empty bytes.

This prevents an outside empty-file creation from being mistaken for the base
of an interrupted creation. A live create that displaces an empty outside file
retains it and reports `raced`, even when the requested file is also empty.
Creating an empty file is an attributed mutation. This is a disk-only migration;
the connection protocol remains 6. Delete/move support and the public mutation
provider still require their own implementation and installed qualification.


### Delete and move batches (connection protocol 7, disk record 4, 2026-10-07)

This supersedes method 17's protocol-6 text-only shape above. Its changes are
`local_mutation {1 path, 2 base, 3? content}`. Missing content deletes a path;
present zero-length content creates an empty file. A move submits a source
deletion and destination write in the same batch. Both bases are compared before
any mutation, with the same bounded text validation and successful-prefix rules.
Each receipt is `mutation_result {1 post: Base, 2? raced}`: absent for a deletion,
digest for a write. Method 3 retains its required content and digest receipt.
The host validates deletion versus empty-file receipts against the encoded input.
Only protocol 7 is admitted on live connections; persisted history stays readable.

Deletion renames the original inode to a confined recovery name, persists the
parent directory and checkpoints the attributed absent result before success.
The document becomes Gone, and its save timers cannot recreate the path. Existing
pending text swaps must settle before deletion; busy is an application failure,
never a stale whole-batch no-op. Outside bytes displaced during deletion are
versioned before success and reported as raced. Late writes to the retained inode
are versioned after the existing quiet window, without merging into a recreated
or restored path. Errors after rename do not roll it back or claim completion.

`SMTHDOC4` extends record 3 with a checksum-covered `u16` UTF-8 path length and
path after the presence byte. Zero length means an ordinary save; a nonempty,
validated relative path marks deletion recovery metadata. Startup reads that
private metadata and reopens retained inodes even when the original path is
absent. It never repeats a deletion intent. Records 1, 2 and 3 remain readable.
Restore compares a Gone document's physical path, distinguishing absence from an
outside recreation, before using the existing document save path.

This is daemon and client component support. The public `WorkspaceCompareWriter`
remains unmounted pending its remaining receipt/mode contracts and installed
machine qualification; component tests do not establish full ticket acceptance.
