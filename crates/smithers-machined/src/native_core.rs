//! Native repository operations mounted on the existing daemon RPC dispatcher.
use crate::{
    conn::{self, field, structure_bytes, tagged},
    hooks::{self, Actor, Core, EventSink, Oid},
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
        self.validate_head(onto)?;
        self.native.validate_rebase(onto).map_err(hook)
    }
    fn capture_local(&self, cx: &mut LockCx) -> hooks::Result<()> {
        crate::capture::local(cx, &mut Capture(self))?;
        self.native.settled().map_err(hook)?;
        self.native.checkpoint().map_err(hook)
    }
    fn restore_rewrite(&self, _: &mut LockCx) -> hooks::Result<()> {
        self.native.restore().map_err(hook)
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
                if cx.rewrite_pending {
                    crate::freeze::restore(cx, &Actor::Outside)?;
                }
                let old = self.git.acknowledged().map_err(hook)?;
                let snapshot = self.native.snapshot().map_err(hook)?.0;
                if old.is_none() || old == Some(head) {
                    let mut git = self.git.clone();
                    git.acknowledge_and_sync(head).map_err(hook)?;
                    return Ok(structure_bytes(&[field(1, tagged(1, &[]))]));
                }
                let old = old.unwrap();
                let moved = crate::freeze::freeze_then(cx, &Actor::Outside, |_| {
                    let moved = if self.native.tree(snapshot).map_err(hook)?
                        == self.native.tree(old).map_err(hook)?
                    {
                        self.native.move_to(head).map_err(hook)?
                    } else {
                        self.native
                            .rebase_delta(snapshot, old, head)
                            .map_err(hook)?
                    };
                    self.events.append(
                        &tagged(3, &[field(1, old), field(2, head), field(3, [1])]),
                        Some(moved),
                    )?;
                    let mut git = self.git.clone();
                    git.acknowledge_and_sync(head).map_err(hook)?;
                    Ok(moved)
                })?;
                self.native.settled().map_err(hook)?;
                Ok(structure_bytes(&[field(1, tagged(2, &[field(1, moved)]))]))
            }
            _ => Err(hooks::Error::unsupported()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        conn::Frame,
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
    fn call(core: Arc<NativeCore>, method: u8, fields: &[Vec<u8>]) -> Frame {
        let mut cx = LockCx::new(Hooks {
            events: core.events.clone(),
            core,
            documents: Arc::new(Flushed),
            watcher: Arc::new(Flushed),
            broker: Arc::new(Flushed),
            ..Default::default()
        });
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
            &mut cx,
        )
        .unwrap()
    }
    fn fixture() -> (tempfile::TempDir, Arc<NativeCore>) {
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
        let events = Arc::new(Events::new(outbox, repository.clone(), || Ok(1)).unwrap());
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
