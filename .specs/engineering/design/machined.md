# `smithers-machined` design: crate, processes, hooks, tests and lanes

Status: design for T-COL-03r ([#3626](https://github.com/smithersai/smithers/issues/3626)) and T-COL-03a ([#3624](https://github.com/smithersai/smithers/issues/3624)), 2026-10-03. The wire bytes are fixed by [ADR 0004](../../../docs/architecture/0004-machined-wire.md); this document fixes everything else an implementation lane would otherwise have to choose.

**Summary.** One static binary runs as two processes: a root broker that owns cgroups, privileged sockets and process spawning, and an unprivileged `machined` daemon that owns the host connection, the working copy, git and jj. All working-copy mutations run on one lock thread in arrival order. Durable events sit in a file-per-entry outbox, and their objects travel to the host as git bundles on the same connection. Core, watcher, documents and sessions meet only through five traits in `src/hooks.rs`, each with a no-op default, so every component lands dark and builds against fixtures. T-COL-03r splits into 3 lanes and T-COL-03a into 5, with disjoint files.

## 1. Reuse ledger

Order of preference: use as is, enable, restore, reshape, new (delta.md §0).

| What | Class | Source | Use |
| --- | --- | --- | --- |
| Guest byte transports | Reuse | `packages/backend/microsandbox/transport.go:67` (`DialWorkspacePort`, `msb exec` + helper `relay`), `:126` (`startBridges`, helper `bridge`) | The stream under ADR 0004 for `relay` and `bridge`. Unchanged. |
| Content limit | Reuse | `MaxWorkspaceFileBytes = 1 << 20`, `packages/backend/internal/services/workspace_facets.go:27` | `write_file` and `read_file` bound; the Rust constant `MAX_FILE_BYTES` equals it, asserted by a golden frame (`err_too_large.limit`). |
| `cgroup_kill`, `drop_to` | Reshape (port) | `microsandbox/guest/smithers-guest.py:78`, `:124` | Ported to Rust in `broker.rs`; supplementary groups `[team]` instead of `[]`, and uid 19999 for `agent` instead of the helper's 1500 (T-MCH-11). Reference only, never invoked. The helper's `fs_read`/`fs_write` confine by `realpath` and so race; `confine.rs` replaces them with `openat2`. |
| Yrs pin | Reuse | `crates/smithers-ffi/Cargo.toml` `yrs = "=0.27.4"` | Pinned in the new crate and `MANIFEST.json`; not compiled until T-COL-08a. |
| Workspace `Cargo.toml`, `PACKAGE.ts` pattern | Reuse | `Cargo.toml` members, `crates/flows-jj/PACKAGE.ts` | Same `Smithers.Cargo.*` targets; the root `PACKAGE.ts` already globs `crates/*/PACKAGE.ts`. |
| jj and git | Reuse | the guest rootfs `jj` and `git` (spec §16.1.1) | The daemon shells out to both. `jj-lib` in-process is rejected: the workspace pins a jj fork (`Cargo.toml` `jj-lib` rev `47589ad`) that need not match the rootfs `jj` members run, and a store-format skew between the daemon and a member's `jj` would corrupt `.jj/`. |
| Head reporter | Reshape (absorb) | `packages/backend/internal/services/workspace_head.go:30-171` (bash loop: snapshot on tick, push head ref, report `{change_id, commit_id, ahead, behind}`), `ReportWorkspaceHead` `:697` | Its duty moves to `capture` and the `captured` event; the host keeps computing `ahead`/`behind` from the head. T-COL-03 deletes the loop. |
| One-shot Rust codec | Rejected | `crates/smithers-ffi/src/atomic_protocol.rs` (text length header + JSON body, one request per process) | Its bounds-before-read discipline and `{code, message}` error shape carry over; the format cannot multiplex streams. |
| Expected test paths | Reuse | `scripts/check-commands.json:170-212` names `tests/barrier.rs` (C-COL-03), `tests/confinement.rs` (C-COL-04), `tests/versions.rs`, `tests/overflow.rs`, `internal/machined/fault_test.go` | Lanes use these names. |
| Terminal WebSocket frames | Rejected | `internal/routes/terminal_session_manager.go` | No correlation, ack or actor (ADR 0004 context). |
| Pair session and presence code | Rejected | deleted in `2753d2e3` | Host-side SQL and HTTP routes for share sessions; no daemon, frame codec or guest code. T-COL-06 restores only its lease SQL shape. |
| Daemon, codec, outbox | New | — | delta.md §4 "Net new [S2]" row. |

## 2. Processes

```
 guest init (PID 1, msb)
   └─ smithers-machined broker            uid 0, cgroup /smithers/broker
        │  fd: relay listener 127.0.0.1:970 (relay topology only)
        │  fd: /run/smithers/machined.sock  (root:agent 0660)
        │  socketpair SOCK_SEQPACKET ─────────────┐
        ├─ smithers-machined daemon       uid 19998 machined, groups {team}, umask 002,
        │     fds 3 = socketpair, 4 = relay listener or none, 5 = local socket
        │     cgroup /smithers/daemon
        └─ session processes (T-TRM-07)   uid agent or member, /smithers/sessions/s<id>
```

### 2.1 Broker (`src/broker.rs`, `src/brokerproto.rs`)

Started by the guest init (T-COL-03 plants the binary at `/opt/smithers/bin/smithers-machined` and the init entry). On start, in this order:

1. Kernel checks: `openat2` with `RESOLVE_BENEATH`, `renameat2(RENAME_EXCHANGE)` on `/workspace`, cgroup v2 with `cgroup.freeze` and `cgroup.kill`. Any missing: log one line naming it and exit 78 (`EX_CONFIG`). The init does not restart on 78, so the machine never reports awake and the host's wake fails with the logged reason.
2. Create `/sys/fs/cgroup/smithers/{broker,daemon,sessions}` (root, 0755), enable `+cpu +pids` in `smithers/cgroup.subtree_control`, move itself into `broker`.
3. Startup barrier (§9.6.4, T-TRM-06): write `1` to `cgroup.kill` of every child of `sessions/`, wait until each reports `populated 0`, `rmdir` it. Bound 5 s; on timeout exit 75 (`EX_TEMPFAIL`) so the init restarts it.
4. Read the boot file (ADR 0004). For `relay`, bind `127.0.0.1:970` with `SO_REUSEADDR`. Bind `/run/smithers/machined.sock`, `chown root:agent`, `chmod 0660`.
5. `socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC)`. Fork the daemon: move to `daemon` cgroup, `setgroups([team])`, `setresgid(machined)`, `setresuid(19998)`, `umask(002)`, `PR_SET_NO_NEW_PRIVS`, `PR_SET_DUMPABLE 0`, `dup2` the three descriptors to 3, 4, 5, `execve("/opt/smithers/bin/smithers-machined", ["smithers-machined", "daemon"])`.
6. Serve the socketpair until the daemon exits. Then run the step-3 barrier, wait the backoff (250 ms doubling to 5 s; reset after 60 s of daemon uptime), and go to 5.

The broker never reads the working copy, never talks to the host, and accepts requests only from its socketpair end.

### 2.2 Socketpair protocol

`SOCK_SEQPACKET`, one message per packet, at most 65,536 bytes, encoded with the ADR 0004 primitives (`src/conn.rs`): `u32 id` then a union. The broker answers every request with the same `id`. Descriptors travel as `SCM_RIGHTS` on responses. Same binary on both ends, so this protocol has no version and no golden frames; `brokerproto.rs` unit tests round-trip it.

| variant | request | response | stage |
| --- | --- | --- | --- |
| 1 | `Freeze { 1 timeout_ms: u32 }` | `{ 1 frozen: bool, 2 blocking: u32? }` (session id of a child not frozen) | S2, T-COL-03a |
| 2 | `Thaw {}` | `{}` | S2, T-COL-03a |
| 3 | `KillSessions { 1 sessions: list<u32>? }` (absent = all) | `{ 1 killed: u16 }` after `populated 0` | S2, T-COL-03a (all); T-TRM-07 (list) |
| 4 | `Spawn { 1 session: u32, 2 user: User, 3 kind: u8, 4 argv: list<str>?, 5 size: Size? }` | `{ 1 pid: u32 }` + fds (pty master, or stdin/stdout/stderr pipes) | T-TRM-07; S2 answers `unsupported` |
| 5 | `Signal { 1 session: u32, 2 sig: u8 }` | `{}` | T-TRM-07 |
| 6 | `WriteEnv { 1 content: bytes }` | `{}` | T-MCH-12 |
| 7 | `HomeRead { 1 uid: u32, 2 path: str }` / 8 `HomeWrite { … 3 content: bytes }` | `{ content }` / `{}` | T-TRM-02, §9.6.6 |
| 0xFF | — | `Error` (ADR 0004) | all |

`Freeze` writes `1` to `sessions/cgroup.freeze` and polls `sessions/cgroup.events` every 10 ms for `frozen 1`. At the timeout it writes `0`, reads each child's `cgroup.events`, and returns the first child (`s<id>`) with `frozen 0`. `Spawn` performs the §9.5.3 identity checks itself, so a compromised daemon still cannot start a root or wrong-uid process.

### 2.3 Daemon lifecycle (`src/daemon.rs`)

```
 start ──► read boot file, open /workspace dirfd (O_PATH), recover outbox
   │
   ▼
 booting ──Welcome──► reconciling ──wake_reconcile ok──► ready
   ▲                                                       │
   └────────────── connection lost (state kept) ◄──────────┘
```

- `booting`, `reconciling`: every RPC except `status` and `wake_reconcile` answers `not_ready`; the local socket accepts and immediately closes; session frames get `refused{not_ready}`.
- `ready` is in memory. A daemon restart starts at `booting`, and the host runs `wake_reconcile` again (a no-op when nothing moved). A reconnect without a restart keeps `ready`.
- The host's sequence after `Welcome`: object stream with its head (skipped when the head equals the machine's last acked capture), `wake_reconcile{head}`, `status()`; it reports the machine awake when `status.state == ready`.
- Internal timers start at `ready`: capture coalescer (after each burst close, at most one per 5 s; and every 5 min), weekly op-log job, presence every 10 s.

Runtime: `tokio` multi-thread with 2 workers for IO; one dedicated OS thread for the mutation lock (§3). Release dependencies: `tokio`, `rustix` (openat2, renameat2, inotify, cgroups, `SCM_RIGHTS`, credentials), `sha2`, `hmac`, `getrandom`. No serde in the release binary; `serde_json` is a dev-dependency for fixtures.

### 2.4 Link (`src/link.rs`)

```rust
pub trait LinkSource: Send {
    /// The next byte stream to the host: an accepted connection (relay) or a dialed one (bridge).
    async fn next(&mut self) -> io::Result<TcpStream>;
}
pub struct RelayListener { listener: TcpListener }        // fd 4 from the broker
pub struct BridgeDialer { port: u16, backoff: Backoff }    // 127.0.0.1:<bridge_port>
```

`Backoff`: 250 ms, ×2, cap 5 s, no jitter, reset after a `Welcome`. On `relay`, a new connection that completes the handshake replaces the live one; one that fails is closed and never disturbs the live one. After `Welcome`, the link task splits the stream into a reader that dispatches by kind and a writer that drains four bounded queues in strict priority: (1) hello, control responses and acks, (2) events, (3) presence, (4) stream data, round-robin across streams. Only queue 4 applies backpressure to its producers (credit already bounds it), so stream data can never stall an ack.

### 2.5 Local socket (`src/local.rs`, `src/client.rs`)

Accepts on fd 5 only in `ready`. Per connection: `SO_PEERCRED`; refuse unless uid is `agent` (19999); read `/proc/<pid>/cgroup`; `Sessions::run_of_cgroup` maps it to a run or refuses `unauthorized`. Requests use ADR 0004 control frames without a handshake; `write_file` without field 4 (an actor field fails `unknown_field`); the actor is `Actor::Run`.

`smithers-machined client read-file <path> [--at <oid>]` prints `{"digest":"<hex>","mode":<n>,"content_b64":"…"}`. `client write-file <path> --base <hex|absent>` reads content from stdin and prints `{"post_digest":"<hex>"}`. On a refusal it exits 1 and prints `{"error":{"code":"stale","current_digest":"<hex>"}}` (`current_digest` only for `stale`). The JSON is written by hand; T-COL-10's std tools call these two commands in S2.

## 3. The mutation lock (`src/lock.rs`)

The lock is a FIFO job queue drained by one OS thread, `machined-lock`. Arrival order is enqueue order. Every §9.4.1 mutation is a job: `write_file`, document saves (S3), burst closes, `capture_local`, `rebase`, `return_to_item`, `wake_reconcile`, the overflow resync and the weekly op-log job. Reads never enter it.

```rust
pub struct Lock { tx: std::sync::mpsc::Sender<Job> }
impl Lock {
    /// Runs `f` on the lock thread after every earlier job; records the hold time under `name`.
    pub async fn run<T: Send + 'static>(
        &self, name: &'static str, f: impl FnOnce(&mut LockCx) -> T + Send + 'static,
    ) -> T;
}
pub struct LockCx<'a> {
    pub ws: &'a Workspace,          // /workspace dirfd, openat2 helpers (confine.rs)
    pub vcs: &'a Vcs,               // jj/git runner (jj.rs)
    pub events: &'a dyn EventSink,  // outbox (hooks.rs)
    pub hooks: &'a Hooks,
    pub clock: &'a dyn Clock,
}
```

Hooks run on the lock thread and may block; nothing in a job awaits the network. Hold times go to the daemon log as `lock_hold{name, ms}` and the last 1,000 per name feed `status` (C-PERF-06 reads the log).

**Freeze sequence** (`src/freeze.rs`, §9.4.2), one job:

```
freeze_then(cx, actor, rewrite):
  broker.freeze(1000 ms)        timeout → (broker already thawed) Err(busy{session})
  watcher.drain; watcher.close_bursts
  capture_local(cx)             snapshot pinned and queued; does not wait for the host
  rewrite(cx)                   jj rebase -d <onto> | jj edit <op @>   (T-STK-08, T-COL-05 supply it)
  documents.reconcile_all(cx, actor)
  broker.thaw()                 always, also when any step above fails
```

`busy` carries the blocking session; the host shows "Waiting for a write in Ben's terminal" and retries (§9.4.2a). C-COL-03's forced timeout uses a fixture `Broker` that never reports frozen.

## 4. Capture (`src/capture.rs`)

```
capture_local(cx) -> (head, tree, flushed):           one lock job
  1 flushed = documents.flush_all(cx)                   no-op (0) until T-COL-08a
  2 watcher.drain(cx); watcher.close_bursts(cx)         no-op until T-COL-04a; appends burst events
  3 jj util snapshot                                    killpoint K5a after
    head = jj log -r @ --no-graph -T commit_id ; tree = git rev-parse head^{tree}
  4 if head == refs/smithers/acked/head or a queued `captured` names head: return
  5 events.append(captured{head, tree, base = refs/smithers/base}, pin = head)
      append mints event_id, writes refs/smithers/pending/<event_id> = head, syncfs, then the entry
capture() RPC = lock.run(capture_local) then outbox.wait_empty() (outside the lock) then reply
```

The host's acknowledgement of `captured` is the "head ref equals the snapshot commit" verification: the host moves `refs/smithers/branches/<id>/head` to `head` in the same transaction as the receipt, only after the objects are in its store. `capture()` returns only when the outbox is empty, so sleep and cleanup never drop an event (§9.1.4). Every jj and git command runs as `machined` with `umask 002`, `cwd=/workspace`, `JJ_CONFIG=/opt/smithers/machined/jj.toml` (author `Smithers <machined@smithers.invalid>`), and a 60 s timeout that fails the job with `internal`.

## 5. Outbox (`src/outbox.rs`, `src/objects.rs`)

```
/var/lib/smithers-machined/                 machined:machined 0700
  outbox/<seq, 20 digits>.ev                the Durable payload bytes, exactly as sent
  outbox/SEQ                                highest seq assigned; written only when the directory empties
  outbox/dead/<seq>.ev                      rejected entries; deleted after 30 days
```

| step | action | crash after it |
| --- | --- | --- |
| append 1 | `git update-ref refs/smithers/pending/<event_id hex> <oid>` per pinned object | orphan ref; deleted at startup |
| append 2 | `syncfs(/workspace)` | same |
| append 3 | write `<seq>.ev.tmp`, `fsync`, `rename`, `fsync(outbox/)` | entry durable; replayed |
| send 1 | object stream: `git bundle create - <pending refs of the batch> --not refs/smithers/acked/head refs/smithers/base` | resent after reconnect |
| send 2 | `Durable` frames, at most 32 unacknowledged | resent; host dedups by receipt |
| ack 1 | `captured` only: `git update-ref refs/smithers/acked/head <head>` | harmless repeat |
| ack 2 | if last entry: write `SEQ`; unlink `<seq>.ev`; `fsync(outbox/)` | entry gone; ref orphaned |
| ack 3 | `git update-ref -d refs/smithers/pending/<event_id>` | done |

Startup: next seq = max(highest entry, `SEQ`) + 1; delete every `refs/smithers/pending/*` whose event id is in no entry. Acks follow ADR 0004: `applied` and `duplicate` run the ack steps; `missing_objects` rewinds the send cursor to that seq and builds its next bundle with `--not <haves>` from the ack; `stale_base` deletes the entry and pending ref without moving `acked/head`; `rejected` moves the entry to `dead/`, deletes its pending ref and logs `outbox_rejected{seq, code}`.

`EventSink::hint` (file_written) and presence bypass the outbox and are dropped when the link is down.

**Incoming objects.** A host-allocated object stream is spooled to `/var/lib/smithers-machined/incoming/<stream>.bundle` (bounded by free disk minus 1 GiB; above that the daemon sends `refused{too_large}`), then `git bundle verify` and `git fetch <bundle> '+refs/*:refs/smithers/incoming/*'` run as one lock job, then the file is deleted and the daemon sends `close` on the stream (`refused{…}` on failure). The host waits for that `close` before calling `wake_reconcile`, so the import job is always ahead of the reconcile job in the lock queue.

## 6. `wake_reconcile` (`src/reconcile.rs`)

One lock job; input `H` = the host's head ref.

```
0 H not a commit in the object store → Err(not_found{oids:[H]})        host sends objects, retries
1 A = refs/smithers/acked/head: the last capture whose ack moved the host's head ref
      (unacked or stale_base captures never move it, so A is host-confirmed even after a crash)
  S = jj util snapshot → @
2 A absent (first boot):           base := H; acked/head := H; → unchanged
3 H == A:                          base := H; → unchanged      (S ≠ A is normal work; queued and later captures carry it)
4 H ≠ A, tree(S) == tree(A):       make H the working-copy commit:
                                     git update-ref refs/heads/smithers-wake H; jj git import
                                     jj edit H; jj abandon A S (whichever are not H's ancestors)
                                     jj bookmark forget smithers-wake
                                   base := H; acked/head := H; emit reconciled{A, H, moved}; → moved{H}
5 H ≠ A, tree(S) ≠ tree(A):        X = git commit-tree tree(S) -p A
                                   git update-ref refs/heads/smithers-wake-x X; jj git import
                                   jj rebase -r X -d H   (merge base A, so only post-A edits move)
                                   jj edit X'; jj abandon A S; jj bookmark forget smithers-wake-x
                                   base := H; acked/head := H
                                   X' conflicted → emit reconciled{A, H, conflict, paths}; → conflict{paths}
                                   else           emit reconciled{A, H, moved};          → moved{X'}
```

The host writes "Rebased onto Tk" or raises `needs_you{kind: conflict, paths}` from the `reconciled` event, never from the RPC reply, so a lost reply loses nothing. Case 5 occurs after a crash left work the host never confirmed while the host rebased the sleeping branch. Captures still queued from before the wake carry the old `base`, so the host answers them `stale_base` and keeps `H` (gap 11). The order of wake and outbox replay therefore does not matter. jj sees only commits reachable from refs it imports, which is why `H` and `X` pass through a temporary `refs/heads/` ref.

## 7. Op-log policy (`src/oplog.rs`)

A lock job when `now - last_run >= 7 days` (`/var/lib/smithers-machined/oplog.last`, checked hourly and at `ready`): find the newest operation whose end time is older than `now - 7 d` (`jj op log --no-graph -T 'id ++ " " ++ time.end() ++ "\n"'`), `jj op abandon ..<that id>`, `jj util gc`, write `oplog.last`. Objects behind `refs/smithers/*` survive because they are refs. Time comes from `Clock`, so the 8-day test uses a fake clock.

## 8. Hook traits (`src/hooks.rs`, fixed by T-COL-03r)

Each trait has a no-op default (`hooks::none`) and a fixture (`testing::fixtures`). `src/wiring.rs::hooks()` (L3) names the real types from the start: L3 creates each as a stub struct in its lane's file (`broker::SocketpairBroker`, `local::serve`, …) whose methods answer `unsupported`, so 03a lanes fill bodies without touching `wiring.rs`, `daemon.rs` or `main.rs`. Later tickets (T-COL-04a, T-TRM-07, T-COL-08a) each edit one line of `wiring.rs` to replace a `None*` default. L3 also declares every release dependency 03a needs in `Cargo.toml` (`tokio`, `rustix` with `fs,net,process,pty,termios,thread,mount`, `sha2`, `hmac`, `getrandom`), so 03a lanes never edit `Cargo.toml` or `Cargo.lock`.

```rust
pub struct Hooks {
    pub watcher: Arc<dyn Watcher>,       // NoWatcher → T-COL-04a InotifyWatcher
    pub documents: Arc<dyn Documents>,   // NoDocuments → T-COL-08a DocHost
    pub sessions: Arc<dyn Sessions>,     // NoSessions → T-TRM-07 BrokerSessions
    pub broker: Arc<dyn Broker>,         // T-COL-03a SocketpairBroker; FakeBroker in tests
}

/// Lock-thread only. T-COL-04a.
pub trait Watcher: Send + Sync {
    fn drain(&self, cx: &mut LockCx) -> Result<(), Error>;                       // §9.3.4 drain before write
    fn before_write(&self, cx: &mut LockCx, path: &str, actor: &Actor) -> Result<(), Error>; // close other key's burst
    fn after_write(&self, cx: &mut LockCx, w: &WriteRecord) -> Result<(), Error>;  // record version, own event, file_written
    fn close_bursts(&self, cx: &mut LockCx) -> Result<(), Error>;                 // appends burst events
    fn resync(&self, cx: &mut LockCx) -> Result<(), Error>;                       // §9.3.2; also at daemon start
    fn burst_open(&self) -> bool;                                                 // safe-idle
}
pub struct WriteRecord { pub path: String, pub actor: Actor, pub before: Option<Oid>, pub after: Oid, pub post_digest: Digest }

/// T-COL-08a (S3).
pub trait Documents: Send + Sync {
    fn flush_all(&self, cx: &mut LockCx) -> Result<u16, Error>;
    /// Some when `path` is open: the write applies as one document transaction (§9.4.1).
    fn write_through(&self, cx: &mut LockCx, path: &str, base: &Base, content: &[u8], actor: &Actor)
        -> Option<Result<Digest, Error>>;
    fn reconcile_all(&self, cx: &mut LockCx, actor: &Actor) -> Result<(), Error>;
    fn open(&self, path: &str) -> Result<u32, Error>;                             // NoDocuments: unsupported
    fn close(&self, stream: u32) -> Result<(), Error>;
    fn frame(&self, stream: u32, msg: u8, body: &[u8], out: &FrameTx);            // NoDocuments: refused{unsupported}
    fn all_flushed(&self) -> bool;
}

/// T-TRM-07; register_run and the cgroup map also feed T-COL-04a attribution.
pub trait Sessions: Send + Sync {
    fn open(&self, req: OpenSession, out: &FrameTx) -> Result<u32, Error>;
    fn tcp_connect(&self, port: u16, out: &FrameTx) -> Result<u32, Error>;
    fn close(&self, session: u32) -> Result<(), Error>;
    fn kill(&self, target: &KillTarget) -> Result<u16, Error>;
    fn register_run(&self, run: &str, session: u32) -> Result<(), Error>;
    fn attach(&self, session: u32, received: u64, out: &FrameTx) -> Result<u64, Error>;
    fn frame(&self, session: u32, frame: StreamFrame);                            // NoSessions: refused{unsupported}
    fn run_of_cgroup(&self, cgroup: &str) -> Option<String>;                      // local socket, §9.5.3
    fn active_since(&self, since: Instant) -> Vec<u32>;                           // cpu.stat usage_usec grew
    fn live(&self) -> Vec<u32>;
    fn last_path(&self, session: u32) -> Option<String>;                          // presence where
}

/// Socketpair client. T-COL-03a.
pub trait Broker: Send + Sync {
    fn freeze(&self, timeout: Duration) -> Result<Frozen, Error>;                 // Frozen::Yes | Frozen::TimedOut{blocking}
    fn thaw(&self) -> Result<(), Error>;
    fn kill_sessions(&self, sessions: Option<&[u32]>) -> Result<u16, Error>;
}

/// Outbox front. T-COL-03a implements; watcher and documents call it.
pub trait EventSink: Send + Sync {
    /// Mints event_id, pins `pin` at refs/smithers/pending/<event_id>, syncfs, writes the entry.
    fn append(&self, event: Event, pin: Option<Oid>) -> Result<(u64, [u8; 16]), Error>;
    fn hint(&self, hint: Hint);
}
pub trait Clock: Send + Sync { fn now(&self) -> SystemTime; fn mono(&self) -> Instant; }
```

`Error`, `Actor`, `Base`, `Event`, `Hint`, `Oid`, `Digest`, `StreamFrame` are the ADR 0004 types in `src/msg.rs`. `FrameTx` is the link writer handle (`src/stream.rs`).

## 9. Crate layout and ownership

```
crates/smithers-machined/
  Cargo.toml          features: testing (fake host, fixtures), killpoints (C-DUR-04 hooks)
  PACKAGE.ts          cargoFmt, cargoClippy, cargoTest, muslBuild (aarch64-unknown-linux-musl via cargo-zigbuild)
  src/main.rs         subcommands: broker | daemon | client
  src/lib.rs
  src/conn.rs         frame header, TLV primitives, ProtocolError                  03r
  src/msg.rs          every ADR 0004 message type, encode/decode                    03r
  src/rpc.rs          dispatch, readiness gate, unsupported stubs                   03r
  src/hooks.rs        traits, Hooks, defaults                                       03r
  src/lock.rs         FIFO lock thread, LockCx                                      03r
  src/jj.rs           Vcs: jj/git runner (machined, umask 002, timeout)             03r
  src/killpoint.rs    killpoint!(name): abort when SMITHERS_MACHINED_KILL_AT == name; empty without `killpoints`   03r
  src/stream.rs       credit-based stream pipe (sessions, objects)                  stub 03r → A4
  src/wiring.rs       hooks(): which implementation backs each trait                03r
  src/daemon.rs       lifecycle, timers                                             stub 03r → A4
  src/link.rs         LinkSource, handshake, reconnect, writer scheduling           stub 03r → A4
  src/broker.rs       broker process                                                stub 03r → A1
  src/brokerproto.rs  socketpair messages, SocketpairBroker                         types 03r → A1
  src/confine.rs      openat2 resolution, regular-file checks                       stub 03r → A2
  src/files.rs        read_file, write_file (RENAME_EXCHANGE swap)                  stub 03r → A2
  src/local.rs        agent socket                                                  stub 03r → A2
  src/client.rs       `client` subcommand                                           stub 03r → A2
  src/outbox.rs       outbox, ack handling                                          stub 03r → A3
  src/objects.rs      bundles out and in                                            stub 03r → A3
  src/capture.rs      capture_local, capture, cadence                               stub 03r → A3
  src/freeze.rs       §9.4.2 sequence                                               stub 03r → A5
  src/reconcile.rs    wake_reconcile                                                stub 03r → A5
  src/oplog.rs        weekly abandon + gc                                           stub 03r → A5
  src/testing/fake_host.rs, src/testing/fixtures.rs                                 03r
  tests/golden.rs, tests/fake_host.rs                                               03r
  tests/broker.rs                                                                   A1
  tests/confinement.rs, tests/write_file.rs, tests/local.rs                         A2
  tests/outbox.rs, tests/capture.rs                                                 A3
  tests/link.rs                                                                     A4
  tests/barrier.rs, tests/reconcile.rs, tests/oplog.rs                                 A5
```

Later owners add files only: `watch.rs ignore.rs attrib.rs session.rs burst.rs versions.rs events.rs resync.rs` (T-COL-04a), `broker/sessions.rs` (T-TRM-07), `doc/` (T-COL-08a).

Go side, for the record (T-COL-03r lane L2 and T-COL-03): `packages/backend/internal/machined/wire/{frame.go,tlv.go,msg.go,errors.go}` + `golden_test.go`, `deps_test.go`; `machined.LinkSource` in `packages/backend/internal/machined/link.go` (T-COL-03).

## 10. Rust fake host (`src/testing/fake_host.rs`)

An in-process host speaking ADR 0004 through the real codec, with a real bare git repository as its store.

```rust
pub struct FakeHost {
    pub relay_secret: [u8; 32], pub boot_id: [u8; 16], pub credential: Vec<u8>,
    pub store: TempDir,                  // bare repo; bundles fetched with real git
    pub receipts: HashSet<[u8; 16]>,     // (branch, event_id) model, applied with the ref move
    pub heads: Option<Oid>,              // refs/smithers/branches/<id>/head model
    pub script: Script,
}
pub enum Fault {
    DropAck { seq: u64 }, AckDuplicate { seq: u64 }, MissingObjects { seq: u64, times: u8 },
    Reject { seq: u64 }, DisconnectAfterFrames(usize), BadProof, NewerBoot, Silence(Duration),
}
impl FakeHost {
    pub async fn relay(addr: SocketAddr) -> Self;        // dials like DialWorkspacePort
    pub async fn bridge(listener: TcpListener) -> Self;  // accepts like the backend relay port
    pub async fn handshake(&mut self) -> Result<MachineHello, ProtocolError>;
    pub async fn call(&mut self, call: Call) -> Result<CallResult, Error>;
    pub async fn send_head(&mut self, head: Oid) -> io::Result<()>;   // host bundle + wake path
    pub async fn pump(&mut self, until: Until) -> Vec<Event>;         // spool bundles, verify objects, apply, ack per script
    pub async fn replay(&mut self, seq: &Sequence) -> Result<(), Mismatch>; // golden sequence, byte for byte
}
```

It checks objects with `git cat-file -e` before acknowledging and inserts the receipt together with the head move, so a `duplicate` is a real second delivery. It proves the daemon's behavior against the contract, not the Go host's transactions (T-COL-03 proves those with PostgreSQL).

## 11. Test plan

### T-COL-03r

| Test | Where | Proves |
| --- | --- | --- |
| `node gen.mjs --check` | `packages/backend/internal/compose/testdata/cocontracts/` | fixtures equal the independent generator; `MANIFEST.json` hashes match |
| Go golden | `internal/machined/wire/golden_test.go` | decode = `.json`, encode = `.bin`, each refusal's exact code |
| Go stdlib-only | `internal/machined/wire/deps_test.go` | `go list -deps` lists only stdlib |
| Rust golden | `crates/smithers-machined/tests/golden.rs` | same three assertions |
| Fake host sequences | `tests/fake_host.rs` | every ADR 0004 sequence replays byte for byte against the real `rpc.rs` with default hooks: stubs answer `unsupported`, `seq_reserved_doc_s2` answers `doc_refused_unsupported`, handshake refusals |
| Fixture hooks compile | `tests/fake_host.rs` | a `Daemon` built from every fixture answers `status` |
| Contract rows | `internal/compose/cocontracts_test.go` | row 1: `write_file` without `base` is `missing_field`, `err_stale` round-trips; row 5: kind `0x04` decodes and is refused `unsupported`, `res_capture` carries `flushed_documents` |

### T-COL-03a

| Test | Env | Cases (ticket) |
| --- | --- | --- |
| unit `conn.rs`, `msg.rs` | any | round-trips; property test: decode∘encode = id over random values; random bytes never panic |
| unit `outbox.rs` | tmpdir + git | replay in order after restart; acked entries and refs gone; `SEQ` survives empty; orphan refs deleted |
| unit `link.rs` | any | backoff 250, 500, 1000, 2000, 4000, 5000, 5000 ms |
| `tests/write_file.rs` | Linux, real fs | stale base → `stale`, file unchanged; `absent` on existing → `stale`; C-COL-03 step 5 with the `pause_before_swap` test hook, 100 runs |
| `tests/confinement.rs` | Linux | C-COL-04 steps 1–2 and 5 (paths, 10,000 swaps, FIFO/socket/dir within 100 ms, `ps` uids, `ptrace` refused) |
| `tests/local.rs` | Linux, cgroups | unregistered caller refused; uid ≠ agent refused; actor field → `unknown_field` |
| `tests/broker.rs` | Linux, cgroup v2, root | barrier kills a SIGKILLed daemon's sessions before restart; restart backoff; freeze timeout thaws within 1 s and names the blocker |
| `tests/capture.rs` | Linux runner or microVM, real jj | ref equals snapshot after ack; interrupted between snapshot and push leaves the previous ref (K5a–c); `capture()` waits for an empty outbox |
| `tests/reconcile.rs` | real jj | unchanged → no event; moved → `@` descends from H before ready, one `reconciled`; conflict → `conflict{paths}` |
| `tests/oplog.rs` | real jj, fake clock | after 8 days ops older than 7 abandoned and gc'd; pending objects survive; `@` unchanged; member `jj op log` readable |
| `tests/barrier.rs` | real jj, cgroup v2 | C-COL-03 steps 3–4 with fixture writers; FIFO order; hold time recorded |
| `tests/link.rs` | Linux | relay and bridge against the fake host; newer boot replaces; bad proof never receives the credential; 30 s silence drops; init restart reconnects |
| fault | Linux, `killpoints` | C-DUR-04 K3, K3b, K4, K4b, K5a, K5b, K5c against the fake host, 10 runs each |

C-DUR-04 kill points in this crate: `K3` after outbox append 3; `K3b` after the object stream's `eof`; `K5a` after `jj util snapshot`; `K5b` inside the object stream (after the first `data` frame); `K5c` after the `Durable` frame is written, before the ack. `K4` and `K4b` are fake-host faults (`DropAck`, `DisconnectAfterFrames`). `K1` and `K2` belong to T-COL-04a.

## 12. Lanes

Eight Sol lanes with disjoint files. 03r's three run in parallel from day one; 03a's five start when L3 lands and run in parallel.

```
day   1     2     3     4     5     6     7     8     9    10
L1  ████                                        fixtures + gen.mjs + cocontracts_test.go
L2  ███████                                     Go wire codec
L3  ██████████                                  crate skeleton, codec, hooks, stubs, fake host
A1            ████████                          broker
A2            ████████                          confine, files, local socket, client
A3            ██████████████                    outbox, objects, capture
A4            ████████                          link, stream, daemon lifecycle
A5            ██████████████                    freeze, reconcile, oplog
```

| Lane | Files (exclusive) | Builds before its dependencies land | Depends on | Lands dark, fails closed |
| --- | --- | --- | --- | --- |
| L1 fixtures | `packages/backend/internal/compose/testdata/cocontracts/**` (`gen.mjs`, `*.bin`, `*.json`, `MANIFEST.json`), `packages/backend/internal/compose/cocontracts_test.go` | everything: ADR 0004 tables are the only input | — | test data only |
| L2 Go wire | `packages/backend/internal/machined/wire/**` | codec and unit tests from ADR 0004; golden test skips with a named reason until L1 lands, then must pass | L1 for golden | no caller until T-COL-03 |
| L3 Rust skeleton | everything under `crates/smithers-machined/` marked 03r in §9, root `Cargo.toml` `members`, `Cargo.lock` | codec, hooks, defaults, lock thread, stubs that answer `unsupported`, fake host, golden tests (skip until L1) | L1 for golden | binary not planted until T-COL-03; every stub answers `unsupported` |
| A1 broker | `src/broker.rs`, `src/brokerproto.rs`, `tests/broker.rs` | all of it; `Spawn` answers `unsupported` | L3 | exits 78 without kernel features; refuses any message but the table's |
| A2 files | `src/confine.rs`, `src/files.rs`, `src/local.rs`, `src/client.rs`, `tests/{confinement,write_file,local}.rs` | `write_file` with `NoWatcher`; local socket with a fixture `Sessions` mapping a cgroup to a run | L3; A1 for C-COL-04 step 5 (`ps` uids, root broker) | local socket refuses every caller while `Sessions` is `NoSessions` (no run map) |
| A3 durability | `src/outbox.rs`, `src/objects.rs`, `src/capture.rs`, `tests/{outbox,capture}.rs` | against the fake host and real git/jj | L3 | not planted until T-COL-03; the outbox refuses to start unless `/var/lib/smithers-machined` is owned by `machined` with mode 0700, and the daemon then stays `booting` |
| A4 link | `src/link.rs`, `src/stream.rs`, `src/daemon.rs`, `tests/link.rs` | handshake, reconnect, both topologies, against the fake host; init-restart case after A1 | L3; A1 for restart test | daemon stays `booting` without a valid boot file; never sends the credential before a valid proof |
| A5 rewrite | `src/freeze.rs`, `src/reconcile.rs`, `src/oplog.rs`, `tests/{barrier,reconcile,oplog}.rs` | with `FakeBroker` and a direct `capture_local` stub; real cgroup freeze after A1 | L3; A1, A3 for the full matrix | `rebase` and `return_to_item` stay `unsupported` (T-STK-08, T-COL-05 supply the rewrite) |

Merge order inside 03a: A1, A2, A4 in any order; A3 before A5's final commit. Each lane merges to `main` through a short-lived worktree as soon as its tests pass. T-COL-03 (Go host, planting) starts when L2, L3, A3 and A4 are on `main`; the real-VM evidence for C-DUR-04 and C-COL-03 lands there.

T-COL-03a's dependency on T-COL-01 is a deploy-time input only (the boot file's `topology`); no lane waits for it. Its dependency on T-TRM-06 constrains T-TRM-07, not these lanes: A1 implements T-TRM-06's startup barrier exactly.

## 13. Spec contradictions and gaps

| # | Where | Problem | Proposed fix |
| --- | --- | --- | --- |
| 1 | spec.md §7.6.2 (line 539) | "T-COL-03 defines the daemon-host wire contract"; T-COL-03r owns it since the 2026-10-03 synthesis | Replace "T-COL-03" with "T-COL-03r (ADR 0004)". |
| 2 | T-COL-03r, T-COL-03a, T-COL-04, T-COL-06 cite "§7.6 rows 1, 4, 5, 6" | §7.6 has no rows since `631d6632a` dropped the table | Restore the eight-row contract table from `631d6632a^` under §7.6.2, or rewrite the citations to §7.6.2's sentences. |
| 3 | T-COL-03a Scope "fixed by T-COL-10"; T-COL-03 "Consume T-COL-10 schemas", "inputs to ADR 0003 (T-COL-10)"; T-COL-04 "T-COL-10 event schemas", "(T-COL-10)" after `cocontracts_test.go` | T-COL-10 no longer owns the wire | Replace with "T-COL-03r / ADR 0004". |
| 4 | delta.md §4, "Net new [S2]" row | "T-COL-03r, -03f, -04a and -04 fold into T-COL-03a/-03" contradicts four live tickets | Delete the sentence. |
| 5 | spec.md §9.1.4 step 3; C-DUR-04 K3b "refs pushed" | "pushes … several per `git push`" | "sends each batch's objects as one git bundle on an object stream of the connection (ADR 0004), then the events"; K3b "bundle sent". |
| 6 | spec.md §9.5.3 first bullet | "the host first presents the per-boot connection secret" leaks the secret to whatever holds the port | "the host proves the per-boot secret with an HMAC over the daemon's nonce (ADR 0004); the secret never crosses the connection". |
| 7 | T-COL-03r Scope "No frame names a branch, machine or uid" vs §9.1.2 `open_session(user, …)`, §9.5.3 uid check, C-COL-04 step 4 | A uid must reach the broker for its mismatch check | Scope the rule: "No daemon-sent frame and no actor envelope names a branch, machine or uid; `open_session` and `kill_sessions` carry the host's `{login, uid}` for the broker's check." |
| 8 | C-COL-04 step 4, first pass clause | "attributed `{agent: coding, run}` whatever the payload says" accepts a forged actor field; strict decoding refuses it | Pass when the request is refused `unknown_field` and nothing is written. |
| 9 | spec.md §9.1.1 | "It reconnects with backoff" — on `relay` the daemon cannot dial | "The side that dials (the daemon on `bridge`, the host on `relay`) reconnects with backoff from 250 ms to 5 s." |
| 10 | spec.md §9.1.2 `wake_reconcile` | "It fetches … from the host" — it is a host call with host-sent objects | "The host sends its head's objects and calls `wake_reconcile(head)`." |
| 11 | spec.md §9.1.4, §10.5.5 | A `captured` event replayed after a VM crash can name a commit on a base the host rewrote while the branch slept; nothing says whether the head ref moves | Add to §9.1.4: "The host moves the head ref only when the event's `base` equals the head it last sent this machine; otherwise it records the receipt and sets `rebase_pending`." |
| 12 | spec.md §9.1.2 `capture()` | Omits "close bursts", which §8.4.3 and T-COL-03a list | "flush documents, close bursts, snapshot, …". |
| 13 | spec.md §9.4.2 step 3 vs §9.1.4 last paragraph | `capture()` waits for an empty outbox, so a rewrite inside the freeze would wait on the host and break the 2 s p95 (C-PERF-06) | Step 3: "takes a local capture (snapshot pinned and queued in the outbox); the rewrite does not wait for the host's acknowledgement." |
| 14 | spec.md §9.5.3 second bullet | `machined` cannot create a `root:agent` 0660 socket | "The broker binds the socket and hands it to the daemon." Likewise the relay port (ADR 0004). |
| 15 | spec.md §9.1.2 and §9.6.4 | Re-attach by session id has no RPC | Add `attach_session(id, received)` to §9.1.2. |
| 16 | T-TRM-07 Changes, `src/stream.rs` (new) | Object streams need credit flow control in S2, before T-TRM-07 | `stream.rs` lands in T-COL-03a (lane A4); T-TRM-07 extends it. |
| 17 | T-COL-01 Scope, jj bullet | "The daemon will run one snapshot per burst (§9.3.4)" contradicts §9.3.4 and T-COL-04a ("no jj snapshot per burst") | "at most one capture per 5 s while bursts close (§9.1.3)". |
| 18 | spec.md §9.6.6 | Transcript records go through the outbox, but no ticket owns the event payload | Name the owner; ADR 0004 reserves event variant 5. |
| 19 | spec.md §9.3 | Paths that are not valid UTF-8 cannot be carried as `str` | Add to §9.3.3: "Paths that are not valid UTF-8 produce no activity; capture still snapshots them." |
| 20 | T-COL-03r Scope names `docs/architecture/0004-machined-wire.md`; the T-COL-03r brief named `.specs/adr/0004-machine-wire-contract.md` | No `.specs/adr/` exists; ADRs 0001 and 0002 live in `docs/architecture/` | ADR 0004 lives at `docs/architecture/0004-machined-wire.md`; ADR 0003 (T-COL-10, T-COL-11) does not exist yet and should be created beside it. |
| 21 | spec.md §9.1.2 (line 710) `close_doc(path)` | ADR 0004 closes by stream id, since `open_doc` returns one | `close_doc(stream)`; T-COL-08b may add `path` for logs. |
| 22 | spec.md §9.5.3 (line 814) "the daemon closes any other connection to its port" | After a host restart the old TCP stream can linger half-open; refusing every newcomer would lock the host out for 30 s | "A connection that fails the proof is closed; one that passes replaces the live connection." |
| 23 | T-COL-03a Changes lists `src/lock.rs`; this design moves it to T-COL-03r | T-COL-04a and T-COL-08a need the lock to build against, before 03a lands | Move `lock.rs` (FIFO executor) to T-COL-03r's file list; T-COL-03a keeps `freeze.rs`. |
| 24 | T-COL-03a Tests, fault bullet: "Rust portions of C-DUR-04 K1–K6" | K1 and K2 need bursts (T-COL-04a); K6 kills the VM (T-COL-03, reference host) | T-COL-03a claims K3, K3b, K4, K4b, K5a–c; T-COL-04a K1, K2; T-COL-03 K6. |
