//! Native repository operations mounted on the existing daemon RPC dispatcher.
use crate::{
    conn::{self, field, structure_bytes},
    hooks::{self, Actor, Core, Oid},
    lock::LockCx,
    outbox::Refs,
};
use std::{io, sync::Arc};
type Events = crate::event_service::Events<crate::git::Repository, crate::git::Repository>;
fn hook(e: io::Error) -> hooks::Error {
    hooks::Error {
        code: 12,
        detail: Some(e.to_string()),
        ..hooks::Error::unsupported()
    }
}
fn bytes(value: &str) -> Vec<u8> {
    let mut b = (value.len() as u16).to_be_bytes().to_vec();
    b.extend(value.as_bytes());
    b
}
pub struct NativeCore {
    pub native: Arc<crate::native::Repository>,
    pub git: crate::git::Repository,
    pub events: Arc<Events>,
    pub sessions: Arc<dyn hooks::Sessions>,
}
struct Capture<'a>(&'a NativeCore);
impl crate::capture::Repository for Capture<'_> {
    fn snapshot(&mut self) -> hooks::Result<(Oid, Oid)> {
        self.0.native.snapshot().map_err(hook)
    }
    fn base(&mut self) -> hooks::Result<Oid> {
        Ok(self
            .0
            .git
            .acknowledged()
            .map_err(hook)?
            .unwrap_or(self.0.native.current().map_err(hook)?.0))
    }
    fn acknowledged(&mut self) -> hooks::Result<Option<Oid>> {
        self.0.git.acknowledged().map_err(hook)
    }
    fn queued(&mut self, head: Oid) -> hooks::Result<bool> {
        self.0.events.queued(head).map_err(hook)
    }
}
impl NativeCore {
    fn finish_wake(&self, settlement: &crate::wake_journal::Settlement) -> hooks::Result<()> {
        let acknowledged = self.git.acknowledged().map_err(hook)?;
        if acknowledged != Some(settlement.old) && acknowledged != Some(settlement.head) {
            return Err(hook(io::Error::other(
                "wake settlement acknowledgement changed",
            )));
        }
        let paths = self
            .native
            .conflict_paths(settlement.result)
            .map_err(hook)?;
        let outcome = if paths.is_empty() {
            crate::reconcile::Outcome::Moved(settlement.result)
        } else {
            crate::reconcile::Outcome::Conflict(paths)
        };
        self.events
            .append_keyed(
                settlement.event_id,
                &outcome.event(settlement.old, settlement.head)?,
                settlement.result,
            )
            .map_err(hook)?;
        self.git
            .clone()
            .acknowledge_and_sync(settlement.head)
            .map_err(hook)
    }
    fn require_settled_wake(&self) -> hooks::Result<()> {
        if self
            .native
            .wake_journal()
            .map_err(hook)?
            .pending()
            .map_err(hook)?
            .is_some()
        {
            return Err(crate::freeze::pending_error());
        }
        Ok(())
    }
    fn validate_head(&self, onto: Oid) -> hooks::Result<()> {
        if self.native.contains(onto).map_err(hook)? {
            Ok(())
        } else {
            Err(hooks::Error {
                code: 5,
                oids: Some(vec![onto]),
                ..hooks::Error::unsupported()
            })
        }
    }
}
impl Core for NativeCore {
    fn ready(&self) -> hooks::Result<()> {
        self.native.current().map(|_| ()).map_err(hook)
    }
    fn validate_rebase(&self, onto: Oid) -> hooks::Result<()> {
        self.require_settled_wake()?;
        self.validate_head(onto)?;
        self.native.validate_rebase(onto).map_err(hook)
    }
    fn capture_local(&self, cx: &mut LockCx) -> hooks::Result<()> {
        self.require_settled_wake()?;
        crate::capture::local(cx, &mut Capture(self))?;
        self.native.settled().map_err(hook)?;
        self.native
            .checkpoint_with_ack(self.git.acknowledged().map_err(hook)?)
            .map_err(hook)
    }
    fn restore_rewrite(&self, _: &mut LockCx) -> hooks::Result<()> {
        if let Some(settlement) = self
            .native
            .wake_journal()
            .map_err(hook)?
            .pending()
            .map_err(hook)?
        {
            // The native mutation and its immutable result already committed.
            // Finish its identity/acknowledgement, keeping even post-thaw edits.
            self.finish_wake(&settlement)
        } else {
            self.native
                .restore_with_ack(self.git.acknowledged().map_err(hook)?)
                .map_err(hook)
        }
    }
    fn rebase(&self, _: &mut LockCx, onto: Oid) -> hooks::Result<Oid> {
        self.native.rebase(onto).map_err(hook)
    }

    fn call(&self, cx: &mut LockCx, method: u8, args: &[u8]) -> hooks::Result<Vec<u8>> {
        match method {
            1 => {
                let mut fields = vec![
                    field(1, [2]),
                    field(2, conn::PROTOCOL.to_be_bytes()),
                    field(3, bytes("smithers-machined")),
                    field(4, self.events.depth().map_err(hook)?.to_be_bytes()),
                ];
                if let Some(acked) = self.git.acknowledged().map_err(hook)? {
                    fields.push(field(5, acked));
                }
                fields.push(field(6, (self.sessions.live().len() as u16).to_be_bytes()));
                Ok(structure_bytes(&fields))
            }
            4 => {
                self.require_settled_wake()?;
                let captured = crate::capture::local(cx, &mut Capture(self))?;
                Ok(structure_bytes(&[
                    field(1, captured.head),
                    field(2, captured.tree),
                    field(3, captured.flushed.to_be_bytes()),
                ]))
            }
            5 => {
                let f = conn::fields("args5", args).map_err(|_| hooks::Error::unsupported())?;
                let head: Oid = f[0].1.try_into().map_err(|_| hooks::Error::unsupported())?;
                self.validate_head(head)?;
                if !cx.rewrite_pending
                    && self
                        .native
                        .wake_journal()
                        .map_err(hook)?
                        .pending()
                        .map_err(hook)?
                        .is_some()
                {
                    // A crash may follow barrier removal but precede journal
                    // cleanup. Re-enter settlement without rewriting files.
                    cx.begin_rewrite()?;
                }
                if cx.rewrite_pending {
                    crate::freeze::restore(cx, &Actor::Outside)?;
                    self.native.settled().map_err(hook)?;
                }
                let old = self.git.acknowledged().map_err(hook)?;
                if old.is_none() || old == Some(head) {
                    // A repeated wake is not proof that a retained conflict was
                    // resolved. Snapshot actual edits before testing readiness.
                    let snapshot = self.native.snapshot().map_err(hook)?.0;
                    let paths = self.native.conflict_paths(snapshot).map_err(hook)?;
                    let outcome = if paths.is_empty() {
                        crate::reconcile::Outcome::Unchanged
                    } else {
                        crate::reconcile::Outcome::Conflict(paths)
                    };
                    let result = outcome.result()?;
                    let mut git = self.git.clone();
                    git.acknowledge_and_sync(head).map_err(hook)?;
                    return Ok(result);
                }
                let old = old.unwrap();
                let outcome = crate::freeze::freeze_then(cx, &Actor::Outside, |_| {
                    // freeze_then flushes documents, drains writers and captures
                    // under the lock. A snapshot selected before that preparation
                    // omits the typing and outside writes it just preserved.
                    let snapshot = self.native.current().map_err(hook)?.0;
                    let moved = if self.native.same_tree(snapshot, old).map_err(hook)? {
                        self.native.move_to(head).map_err(hook)?
                    } else {
                        self.native
                            .rebase_delta(snapshot, old, head)
                            .map_err(hook)?
                    };
                    let paths = self.native.conflict_paths(moved).map_err(hook)?;
                    let outcome = if paths.is_empty() {
                        crate::reconcile::Outcome::Moved(moved)
                    } else {
                        crate::reconcile::Outcome::Conflict(paths)
                    };
                    let settlement =
                        crate::wake_journal::Settlement::new(old, head, moved).map_err(hook)?;
                    // Persist objects, then commit the chosen result and event
                    // identity before publishing either the event or new base.
                    self.git
                        .clone()
                        .pin_and_sync(settlement.event_id, moved)
                        .map_err(hook)?;
                    self.native
                        .wake_journal()
                        .map_err(hook)?
                        .save(&settlement)
                        .map_err(hook)?;
                    self.finish_wake(&settlement)?;
                    Ok(outcome)
                })?;
                self.native.settled().map_err(hook)?;
                outcome.result()
            }
            _ => Err(hooks::Error::unsupported()),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        conn::{tagged, Frame},
        hooks::{Broker, Disabled, Documents, Hooks, Watcher},
        rpc,
    };
    use std::{fs, os::unix::fs::PermissionsExt};
    // These collaborators isolate native core behavior; production composition
    // uses the real document/watcher/broker providers in installed.rs.
    struct Flushed;
    impl Documents for Flushed {
        fn flush_all(&self, _: &mut LockCx) -> hooks::Result<u16> {
            Ok(0)
        }
        fn reconcile_all(&self, _: &mut LockCx, _: &Actor) -> hooks::Result<()> {
            Ok(())
        }
    }
    impl Broker for Flushed {
        fn freeze(&self, _: std::time::Duration) -> hooks::Result<Option<u32>> {
            Ok(None)
        }
        fn thaw(&self) -> hooks::Result<()> {
            Ok(())
        }
    }
    impl Watcher for Flushed {
        fn drain(&self, _: &mut LockCx) -> hooks::Result<()> {
            Ok(())
        }
        fn close_bursts(&self, _: &mut LockCx) -> hooks::Result<()> {
            Ok(())
        }
    }
    pub(crate) fn call(core: Arc<NativeCore>, method: u8, fields: &[Vec<u8>]) -> Frame {
        call_with_documents(core, method, fields, Arc::new(Flushed))
    }
    fn call_with_documents(
        core: Arc<NativeCore>,
        method: u8,
        fields: &[Vec<u8>],
        documents: Arc<dyn Documents>,
    ) -> Frame {
        let mut cx = LockCx::new(Hooks {
            events: core.events.clone(),
            core,
            documents,
            watcher: Arc::new(Flushed),
            broker: Arc::new(Flushed),
            ..Default::default()
        });
        call_in(&mut cx, method, fields)
    }
    fn call_in(cx: &mut LockCx, method: u8, fields: &[Vec<u8>]) -> Frame {
        rpc::dispatch(
            &Frame {
                kind: 1,
                stream: 0,
                payload: tagged(
                    1,
                    &[
                        field(1, 73u32.to_be_bytes()),
                        field(2, tagged(method, fields)),
                    ],
                ),
            },
            cx,
        )
        .unwrap()
    }
    pub(crate) fn fixture() -> (tempfile::TempDir, Arc<NativeCore>) {
        let (dir, native) = crate::native::tests::fixture();
        let state = dir.path().join("state");
        for name in ["spool", "outbox"] {
            fs::create_dir(state.join(name)).unwrap();
            fs::set_permissions(state.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let git = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|p| p.join("git"))
            .find(|p| p.is_file())
            .unwrap();
        let repository = crate::git::Repository::checked(
            &git,
            &dir.path().join("workspace"),
            &state.join("spool"),
        )
        .unwrap();
        let owner = rustix::process::geteuid().as_raw();
        let outbox = crate::outbox::Outbox::open(
            crate::outbox_store::Store::open(&state.join("outbox"), owner).unwrap(),
            owner,
            repository.clone(),
        )
        .unwrap();
        let events = Arc::new(
            Events::new(outbox, repository.clone(), || Ok(1))
                .unwrap()
                .with_incoming(Arc::new(repository.clone())),
        );
        let native = Arc::new(native);
        let core = Arc::new(NativeCore {
            native: native.clone(),
            git: repository.clone(),
            events: events.clone(),
            sessions: Arc::new(Disabled),
        });
        (dir, core)
    }
    #[test]
    fn dispatcher_native_capture_status_and_first_reconcile_use_durable_repository() {
        let (dir, core) = fixture();
        let native = &core.native;
        let repository = &core.git;
        let events = &core.events;
        fs::write(dir.path().join("workspace/file"), b"literal member bytes\n").unwrap();
        let response = call(core.clone(), 4, &[]);
        let fields = conn::fields("response", &response.payload[1..]).unwrap();
        assert_eq!(&fields[1].1[..1], &[4], "{:?}", fields);
        let result = conn::fields("result4", &fields[1].1[1..]).unwrap();
        let head: Oid = result[0].1.try_into().unwrap();
        assert_eq!(native.tree(head).unwrap().as_slice(), result[1].1);
        assert_eq!(result[2].1, [0, 0]);
        assert_eq!(events.depth().unwrap(), 1);
        assert!(events.queued(head).unwrap());
        // Repeating capture of the identical snapshot cannot enqueue it twice.
        call(core.clone(), 4, &[]);
        assert_eq!(events.depth().unwrap(), 1);
        let response = call(core.clone(), 1, &[]);
        let fields = conn::fields("response", &response.payload[1..]).unwrap();
        let status = conn::fields("result1", &fields[1].1[1..]).unwrap();
        assert_eq!(status[3].1, [0, 0, 0, 1]);
        assert_eq!(status.last().unwrap().1, [0, 0]);
        let response = call(core.clone(), 5, &[field(1, head)]);
        let fields = conn::fields("response", &response.payload[1..]).unwrap();
        assert_eq!(fields[1].1, [5, 0, 0, 0, 6, 1, 1, 0, 0, 0, 0]);
        assert_eq!(repository.acknowledged().unwrap(), Some(head));
        let response = call(core.clone(), 5, &[field(1, [255; 20])]);
        let fields = conn::fields("response", &response.payload[1..]).unwrap();
        assert_eq!(fields[1].1[0], 255);
        assert_eq!(repository.acknowledged().unwrap(), Some(head));
        assert_eq!(
            fs::read(dir.path().join("workspace/file")).unwrap(),
            b"literal member bytes\n"
        );
    }
    fn wake_result(frame: &Frame) -> Vec<u8> {
        let fields = conn::fields("response", &frame.payload[1..]).unwrap();
        assert_eq!(fields[1].1[0], 5, "{fields:?}");
        conn::fields("result5", &fields[1].1[1..]).unwrap()[0]
            .1
            .to_vec()
    }
    #[test]
    fn wake_rpc_reports_conflict_and_repeat_cannot_admit_until_resolved() {
        let (dir, core) = fixture();
        let root = dir.path().join("workspace");
        fs::write(root.join("conflict"), b"original\n").unwrap();
        let base = core.native.snapshot().unwrap().0;
        crate::native::tests::child(&core.native, base, "host changed");
        fs::write(root.join("conflict"), b"host version\n").unwrap();
        let onto = core.native.snapshot().unwrap().0;
        core.native.move_to(base).unwrap();
        core.git.clone().acknowledge_and_sync(base).unwrap();
        fs::write(root.join("conflict"), b"local version\n").unwrap();
        let value = wake_result(&call(core.clone(), 5, &[field(1, onto)]));
        assert_eq!(value[0], 3, "conflict must not be reported as moved");
        let paths = conn::fields("conflict", &value[1..]).unwrap();
        assert_eq!(
            paths[0].1,
            [0, 1, 0, 8, b'c', b'o', b'n', b'f', b'l', b'i', b'c', b't']
        );
        let markers = fs::read_to_string(root.join("conflict")).unwrap();
        assert!(markers.contains("local version"), "{markers}");
        assert!(markers.contains("host version"), "{markers}");
        assert!(markers.contains("<<<<<<<"), "{markers}");
        assert_eq!(core.git.acknowledged().unwrap(), Some(onto));
        let depth = core.events.depth().unwrap();
        let store = crate::outbox_store::Store::open(
            &dir.path().join("state/outbox"),
            rustix::process::geteuid().as_raw(),
        )
        .unwrap();
        let raw = store
            .read(depth.into(), rustix::process::geteuid().as_raw())
            .unwrap();
        let event = conn::Durable::decode(&raw).unwrap();
        assert_eq!(event.event[0], 3);
        let fields = conn::fields("reconciled", &event.event[1..]).unwrap();
        assert_eq!(fields[0].1, base);
        assert_eq!(fields[1].1, onto);
        assert_eq!(fields[2].1, [2]);
        assert_eq!(fields[3].1, paths[0].1);
        assert_eq!(
            wake_result(&call(core.clone(), 5, &[field(1, onto)])),
            value
        );
        assert_eq!(
            core.events.depth().unwrap(),
            depth,
            "retry adds no duplicate reconciliation"
        );
        assert_eq!(fs::read_to_string(root.join("conflict")).unwrap(), markers);
        fs::write(root.join("conflict"), b"both versions resolved\n").unwrap();
        assert_eq!(wake_result(&call(core.clone(), 5, &[field(1, onto)]))[0], 1);
        assert_eq!(
            fs::read(root.join("conflict")).unwrap(),
            b"both versions resolved\n"
        );
    }
    struct ReconcileFails;
    impl Documents for ReconcileFails {
        fn flush_all(&self, _: &mut LockCx) -> hooks::Result<u16> {
            Ok(0)
        }
        fn reconcile_all(&self, _: &mut LockCx, _: &Actor) -> hooks::Result<()> {
            Err(hooks::Error::unsupported())
        }
    }
    struct ThawFails;
    impl Broker for ThawFails {
        fn freeze(&self, _: std::time::Duration) -> hooks::Result<Option<u32>> {
            Ok(None)
        }
        fn thaw(&self) -> hooks::Result<()> {
            Err(hooks::Error::unsupported())
        }
    }
    fn dirty_wake_fixture() -> (tempfile::TempDir, Arc<NativeCore>, Oid, Oid) {
        let (dir, core) = fixture();
        let root = dir.path().join("workspace");
        fs::write(root.join("base"), b"original\n").unwrap();
        let base = core.native.snapshot().unwrap().0;
        crate::native::tests::child(&core.native, base, "host changed");
        fs::write(root.join("host"), b"host version\n").unwrap();
        let onto = core.native.snapshot().unwrap().0;
        core.native.move_to(base).unwrap();
        core.git.clone().acknowledge_and_sync(base).unwrap();
        fs::write(root.join("local"), b"local version\n").unwrap();
        (dir, core, base, onto)
    }
    fn recovery_hooks(
        core: Arc<NativeCore>,
        documents: Arc<dyn Documents>,
        broker: Arc<dyn Broker>,
    ) -> Hooks {
        Hooks {
            events: core.events.clone(),
            core,
            documents,
            broker,
            watcher: Arc::new(Flushed),
            ..Default::default()
        }
    }
    fn reopened_core(core: &NativeCore, dir: &std::path::Path) -> Arc<NativeCore> {
        let owner = rustix::process::geteuid().as_raw();
        let outbox = crate::outbox::Outbox::open(
            crate::outbox_store::Store::open(&dir.join("state/outbox"), owner).unwrap(),
            owner,
            core.git.clone(),
        )
        .unwrap();
        Arc::new(NativeCore {
            native: core.native.clone(),
            git: core.git.clone(),
            events: Arc::new(Events::new(outbox, core.git.clone(), || Ok(1)).unwrap()),
            sessions: Arc::new(Disabled),
        })
    }
    #[test]
    fn wake_restart_after_document_or_thaw_failure_keeps_both_sides() {
        for fail_documents in [false, true] {
            let (dir, core, _, onto) = dirty_wake_fixture();
            let root = dir.path().join("workspace");
            let (documents, broker): (Arc<dyn Documents>, Arc<dyn Broker>) = if fail_documents {
                (Arc::new(ReconcileFails), Arc::new(Flushed))
            } else {
                (Arc::new(Flushed), Arc::new(ThawFails))
            };
            let journal =
                || crate::rewrite_journal::Journal::open(&dir.path().join("state")).unwrap();
            let mut cx =
                LockCx::recovering(recovery_hooks(core.clone(), documents, broker), journal())
                    .unwrap();
            let response = call_in(&mut cx, 5, &[field(1, onto)]);
            assert_eq!(
                conn::fields("response", &response.payload[1..]).unwrap()[1].1[0],
                255
            );
            assert!(cx.rewrite_pending);
            assert_eq!(core.git.acknowledged().unwrap(), Some(onto));
            let depth = core.events.depth().unwrap();
            let response = call_in(&mut cx, 5, &[field(1, onto)]);
            assert_eq!(
                conn::fields("response", &response.payload[1..]).unwrap()[1].1[0],
                255
            );
            assert!(cx.rewrite_pending);
            assert_eq!(core.events.depth().unwrap(), depth);
            drop(cx);
            let core = reopened_core(&core, dir.path());
            let mut restarted = LockCx::recovering(
                recovery_hooks(core.clone(), Arc::new(Flushed), Arc::new(Flushed)),
                journal(),
            )
            .unwrap();
            assert!(restarted.rewrite_pending);
            wake_result(&call_in(&mut restarted, 5, &[field(1, onto)]));
            assert!(!restarted.rewrite_pending);
            assert_eq!(fs::read(root.join("local")).unwrap(), b"local version\n");
            assert_eq!(fs::read(root.join("host")).unwrap(), b"host version\n");
            assert_eq!(
                core.events.depth().unwrap(),
                depth,
                "recovery must not publish a second reconciliation"
            );
            assert!(!dir.path().join("state/rewrite.operation").exists());
            assert!(core
                .native
                .wake_journal()
                .unwrap()
                .pending()
                .unwrap()
                .is_none());
        }
    }
    #[test]
    fn wake_recovery_refuses_unknown_or_changed_acknowledgements_without_mutation() {
        for phase in [
            "legacy",
            "changed before selection",
            "changed after selection",
        ] {
            let (dir, core, base, onto) = dirty_wake_fixture();
            let root = dir.path().join("workspace");
            let mut cx = LockCx::recovering(
                recovery_hooks(core.clone(), Arc::new(Flushed), Arc::new(Flushed)),
                crate::rewrite_journal::Journal::open(&dir.path().join("state")).unwrap(),
            )
            .unwrap();
            core.capture_local(&mut cx).unwrap();
            cx.begin_rewrite().unwrap();
            let snapshot = core.native.current().unwrap().0;
            let result = core.native.rebase_delta(snapshot, base, onto).unwrap();
            let checkpoint = dir.path().join("state/rewrite.operation");
            if phase == "legacy" {
                let value: serde_json::Value =
                    serde_json::from_slice(&fs::read(&checkpoint).unwrap()).unwrap();
                fs::write(&checkpoint, value["operation"].as_str().unwrap()).unwrap();
            } else if phase == "changed after selection" {
                let settlement = crate::wake_journal::Settlement::new(base, onto, result).unwrap();
                core.native
                    .wake_journal()
                    .unwrap()
                    .save(&settlement)
                    .unwrap();
            }
            // Valid repository object, but unrelated to this checkpoint's authority.
            let acknowledged = if phase == "changed after selection" {
                snapshot
            } else {
                onto
            };
            core.git.clone().acknowledge_and_sync(acknowledged).unwrap();
            let bytes = fs::read(&checkpoint).unwrap();
            let depth = core.events.depth().unwrap();
            let response = call_in(&mut cx, 5, &[field(1, onto)]);
            assert_eq!(
                conn::fields("response", &response.payload[1..]).unwrap()[1].1[0],
                255,
                "{phase}"
            );
            assert!(cx.rewrite_pending);
            assert_eq!(core.git.acknowledged().unwrap(), Some(acknowledged));
            assert_eq!(core.native.current().unwrap().0, result);
            assert_eq!(core.events.depth().unwrap(), depth);
            assert_eq!(fs::read(&checkpoint).unwrap(), bytes);
            assert_eq!(fs::read(root.join("local")).unwrap(), b"local version\n");
            assert_eq!(fs::read(root.join("host")).unwrap(), b"host version\n");
        }
    }
    #[test]
    fn wake_restart_at_each_publication_boundary_finishes_one_selected_result() {
        for phase in ["before selection", "selected", "published", "thawed"] {
            let (dir, core, base, onto) = dirty_wake_fixture();
            let root = dir.path().join("workspace");
            let journal =
                || crate::rewrite_journal::Journal::open(&dir.path().join("state")).unwrap();
            let mut cx = LockCx::recovering(
                recovery_hooks(core.clone(), Arc::new(Flushed), Arc::new(Flushed)),
                journal(),
            )
            .unwrap();
            core.capture_local(&mut cx).unwrap();
            cx.begin_rewrite().unwrap();
            let snapshot = core.native.current().unwrap().0;
            let result = core.native.rebase_delta(snapshot, base, onto).unwrap();
            let settlement = crate::wake_journal::Settlement::new(base, onto, result).unwrap();
            if phase != "before selection" {
                core.git
                    .clone()
                    .pin_and_sync(settlement.event_id, result)
                    .unwrap();
                core.native
                    .wake_journal()
                    .unwrap()
                    .save(&settlement)
                    .unwrap();
            }
            if matches!(phase, "published" | "thawed") {
                core.events
                    .append_keyed(
                        settlement.event_id,
                        &crate::reconcile::Outcome::Moved(result)
                            .event(base, onto)
                            .unwrap(),
                        result,
                    )
                    .unwrap();
                assert!(
                    core.events
                        .append_keyed(
                            settlement.event_id,
                            &crate::reconcile::Outcome::Moved(result)
                                .event(onto, base)
                                .unwrap(),
                            result
                        )
                        .is_err(),
                    "same identity cannot change payload"
                );
            }
            if phase == "thawed" {
                crate::freeze::restore(&mut cx, &Actor::Outside).unwrap();
                assert!(!cx.rewrite_pending);
                // A crash between barrier removal and journal cleanup must not
                // rewind writes that outside sessions made after thaw.
                fs::write(root.join("after-thaw"), b"later work\n").unwrap();
            }
            drop(cx);
            let core = reopened_core(&core, dir.path());
            let mut restarted = LockCx::recovering(
                recovery_hooks(core.clone(), Arc::new(Flushed), Arc::new(Flushed)),
                journal(),
            )
            .unwrap();
            let refused = call_in(&mut restarted, 4, &[]);
            assert_eq!(
                conn::fields("response", &refused.payload[1..]).unwrap()[1].1[0],
                255,
                "ordinary capture is not recovery"
            );
            wake_result(&call_in(&mut restarted, 5, &[field(1, onto)]));
            assert!(!restarted.rewrite_pending);
            assert_eq!(core.git.acknowledged().unwrap(), Some(onto));
            assert_eq!(fs::read(root.join("local")).unwrap(), b"local version\n");
            assert_eq!(fs::read(root.join("host")).unwrap(), b"host version\n");
            if phase == "thawed" {
                assert_eq!(fs::read(root.join("after-thaw")).unwrap(), b"later work\n");
            }
            assert_eq!(
                core.events.depth().unwrap(),
                2,
                "{phase}: capture plus one reconciliation"
            );
            let owner = rustix::process::geteuid().as_raw();
            let store =
                crate::outbox_store::Store::open(&dir.path().join("state/outbox"), owner).unwrap();
            let event = conn::Durable::decode(&store.read(2, owner).unwrap()).unwrap();
            assert_eq!(event.event[0], 3);
            if phase != "before selection" {
                assert_eq!(event.id, settlement.event_id);
            }
            assert!(!dir.path().join("state/rewrite.operation").exists());
            assert!(core
                .native
                .wake_journal()
                .unwrap()
                .pending()
                .unwrap()
                .is_none());
            wake_result(&call_in(&mut restarted, 5, &[field(1, onto)]));
            assert_eq!(core.events.depth().unwrap(), 2);
        }
    }
    struct FlushWrite(std::path::PathBuf);
    impl Documents for FlushWrite {
        fn flush_all(&self, _: &mut LockCx) -> hooks::Result<u16> {
            fs::write(&self.0, b"typing flushed during freeze\n").map_err(hook)?;
            Ok(1)
        }
        fn reconcile_all(&self, _: &mut LockCx, _: &Actor) -> hooks::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn wake_rpc_rebases_snapshot_taken_after_document_flush() {
        for dirty_before_flush in [false, true] {
            let (dir, core) = fixture();
            let root = dir.path().join("workspace");
            fs::write(root.join("base"), b"original\n").unwrap();
            let base = core.native.snapshot().unwrap().0;
            crate::native::tests::child(&core.native, base, "host changed");
            fs::write(root.join("host"), b"host version\n").unwrap();
            let onto = core.native.snapshot().unwrap().0;
            core.native.move_to(base).unwrap();
            core.git.clone().acknowledge_and_sync(base).unwrap();
            if dirty_before_flush {
                fs::write(root.join("local"), b"local version\n").unwrap();
            }
            let response = call_with_documents(
                core.clone(),
                5,
                &[field(1, onto)],
                Arc::new(FlushWrite(root.join("late"))),
            );
            assert_eq!(wake_result(&response)[0], 2);
            if dirty_before_flush {
                assert_eq!(fs::read(root.join("local")).unwrap(), b"local version\n");
            }
            assert_eq!(fs::read(root.join("host")).unwrap(), b"host version\n");
            assert_eq!(
                fs::read(root.join("late")).unwrap(),
                b"typing flushed during freeze\n"
            );
        }
    }
    #[test]
    fn wake_rpc_reports_conflicts_when_moving_to_a_conflicted_host_head() {
        let (dir, core) = fixture();
        let root = dir.path().join("workspace");
        fs::write(root.join("file"), b"original\n").unwrap();
        let base = core.native.snapshot().unwrap().0;
        crate::native::tests::child(&core.native, base, "one side");
        fs::write(root.join("file"), b"one\n").unwrap();
        let one = core.native.snapshot().unwrap().0;
        crate::native::tests::child(&core.native, base, "other side");
        fs::write(root.join("file"), b"two\n").unwrap();
        core.native.snapshot().unwrap();
        let conflict = core.native.rebase(one).unwrap();
        let markers = fs::read(root.join("file")).unwrap();
        core.native.move_to(base).unwrap();
        core.git.clone().acknowledge_and_sync(base).unwrap();
        let result = wake_result(&call(core.clone(), 5, &[field(1, conflict)]));
        assert_eq!(result[0], 3);
        assert_eq!(core.native.current().unwrap().0, conflict);
        assert_eq!(fs::read(root.join("file")).unwrap(), markers);
        assert_eq!(
            wake_result(&call(core.clone(), 5, &[field(1, conflict)])),
            result
        );
    }
    #[test]
    fn rebase_rpc_preserves_acknowledged_item_and_uncaptured_work() {
        let (dir, core) = fixture();
        let root = dir.path().join("workspace");
        fs::write(root.join("base"), b"base bytes\n").unwrap();
        let base = core.native.snapshot().unwrap().0;
        crate::native::tests::child(&core.native, base, "item change");
        fs::write(root.join("item"), b"already captured item bytes\n").unwrap();
        let item = core.native.snapshot().unwrap().0;
        crate::native::tests::child(&core.native, base, "upstream change");
        fs::write(root.join("upstream"), b"new main bytes\n").unwrap();
        let onto = core.native.snapshot().unwrap().0;
        core.native.move_to(item).unwrap();
        let mut git = core.git.clone();
        git.acknowledge_and_sync(item).unwrap();
        fs::write(root.join("later"), b"not captured yet\n").unwrap();
        let response = call(
            core.clone(),
            11,
            &[
                field(1, onto),
                field(2, conn::actor_bytes(&Actor::Principal(b"person".to_vec()))),
            ],
        );
        let fields = conn::fields("response", &response.payload[1..]).unwrap();
        assert_eq!(fields[1].1[0], 11, "{:?}", fields);
        let fields = conn::fields("result11", &fields[1].1[1..]).unwrap();
        let result: Oid = fields[0].1.try_into().unwrap();
        assert_eq!(
            fs::read(root.join("item")).unwrap(),
            b"already captured item bytes\n"
        );
        assert_eq!(fs::read(root.join("later")).unwrap(), b"not captured yet\n");
        assert_eq!(
            fs::read(root.join("upstream")).unwrap(),
            b"new main bytes\n"
        );
        assert_eq!(fs::read(root.join("base")).unwrap(), b"base bytes\n");
        crate::native::tests::assert_rebase(&core.native, result, onto, item, false);
        assert_eq!(
            core.git.acknowledged().unwrap(),
            Some(item),
            "a local rewrite cannot invent a host acknowledgement"
        );
    }
    fn rebase(core: &Arc<NativeCore>, onto: Oid) -> Frame {
        call(
            core.clone(),
            11,
            &[
                field(1, onto),
                field(2, conn::actor_bytes(&Actor::Principal(b"person".to_vec()))),
            ],
        )
    }
    fn rebased_head(response: &Frame) -> Oid {
        let fields = conn::fields("response", &response.payload[1..]).unwrap();
        assert_eq!(fields[1].1[0], 11, "{:?}", fields);
        conn::fields("result11", &fields[1].1[1..]).unwrap()[0]
            .1
            .try_into()
            .unwrap()
    }
    #[test]
    fn rebase_rpc_before_first_ack_keeps_change_and_retries_without_rewriting() {
        let (dir, core) = fixture();
        let root = dir.path().join("workspace");
        fs::write(root.join("base"), b"base\n").unwrap();
        let base = core.native.snapshot().unwrap().0;
        crate::native::tests::child(&core.native, base, "item before first acknowledgement");
        fs::write(root.join("item"), b"item\n").unwrap();
        let item = core.native.snapshot().unwrap().0;
        crate::native::tests::child(&core.native, base, "main advanced");
        fs::write(root.join("upstream"), b"main\n").unwrap();
        let onto = core.native.snapshot().unwrap().0;
        core.native.move_to(item).unwrap();
        let head = rebased_head(&rebase(&core, onto));
        crate::native::tests::assert_rebase(&core.native, head, onto, item, false);
        assert_eq!(fs::read(root.join("item")).unwrap(), b"item\n");
        assert_eq!(fs::read(root.join("upstream")).unwrap(), b"main\n");
        assert_eq!(core.git.acknowledged().unwrap(), None);
        assert_eq!(
            rebased_head(&rebase(&core, onto)),
            head,
            "retry must not create another revision"
        );
    }
    #[test]
    fn rebase_rpc_retains_conflict_and_can_restore_exact_pre_rebase_change() {
        let (dir, core) = fixture();
        let root = dir.path().join("workspace");
        fs::write(root.join("conflict"), b"original\n").unwrap();
        let base = core.native.snapshot().unwrap().0;
        crate::native::tests::child(&core.native, base, "item conflicting edit");
        fs::write(root.join("conflict"), b"item version\n").unwrap();
        let item = core.native.snapshot().unwrap().0;
        crate::native::tests::child(&core.native, base, "main conflicting edit");
        fs::write(root.join("conflict"), b"main version\n").unwrap();
        let onto = core.native.snapshot().unwrap().0;
        core.native.move_to(item).unwrap();
        let mut git = core.git.clone();
        git.acknowledge_and_sync(item).unwrap();
        let head = rebased_head(&rebase(&core, onto));
        crate::native::tests::assert_rebase(&core.native, head, onto, item, true);
        let markers = fs::read_to_string(root.join("conflict")).unwrap();
        assert!(markers.contains("<<<<<<<"), "{markers}");
        assert!(markers.contains("item version"), "{markers}");
        assert!(markers.contains("main version"), "{markers}");
        // A retained conflict remains serviceable and capturable. Readiness
        // must not require the member to resolve a file before reconnecting.
        core.ready().unwrap();
        let depth = core.events.depth().unwrap();
        let response = call(core.clone(), 4, &[]);
        let fields = conn::fields("response", &response.payload[1..]).unwrap();
        assert_eq!(
            fields[1].1[0], 4,
            "capture must succeed with a retained conflict"
        );
        let result = conn::fields("result4", &fields[1].1[1..]).unwrap();
        assert_eq!(result[0].1, head);
        assert_eq!(result[1].1, core.native.current().unwrap().1);
        assert_eq!(core.events.depth().unwrap(), depth + 1);
        assert_eq!(fs::read_to_string(root.join("conflict")).unwrap(), markers);
        // Neither a second rebase nor a conflicted target overwrites the retained
        // conflict. The operation checkpoint also restores the original change.
        assert!(core.validate_rebase(onto).is_err());
        assert_eq!(fs::read_to_string(root.join("conflict")).unwrap(), markers);
        core.native.restore().unwrap();
        assert_eq!(core.native.current().unwrap().0, item);
        assert_eq!(fs::read(root.join("conflict")).unwrap(), b"item version\n");
        assert!(core.validate_rebase(head).is_err());
        assert_eq!(core.native.current().unwrap().0, item);
        core.native.settled().unwrap();
    }
    #[test]
    fn rebase_rpc_refuses_missing_self_and_descendant_before_capture() {
        let (dir, core) = fixture();
        let root = dir.path().join("workspace");
        fs::write(root.join("item"), b"keep these bytes\n").unwrap();
        let item = core.native.snapshot().unwrap().0;
        let descendant = crate::native::tests::child(&core.native, item, "descendant");
        core.native.move_to(item).unwrap();
        for onto in [item, descendant, [255; 20]] {
            let response = rebase(&core, onto);
            let fields = conn::fields("response", &response.payload[1..]).unwrap();
            assert_eq!(fields[1].1[0], 255);
            assert_eq!(core.native.current().unwrap().0, item);
            assert_eq!(fs::read(root.join("item")).unwrap(), b"keep these bytes\n");
            assert!(!dir.path().join("state/rewrite.operation").exists());
            assert_eq!(
                core.events.depth().unwrap(),
                0,
                "refusal must precede capture"
            );
        }
    }
}
