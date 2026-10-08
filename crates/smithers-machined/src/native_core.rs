//! Native repository operations mounted on the existing daemon RPC dispatcher.
use crate::{
    conn::{self, field, structure_bytes, tagged},
    hooks::{self, Actor, Core, EventSink, Oid},
    lock::LockCx,
    outbox::Refs,
};
use std::{
    io,
    sync::{Arc, Mutex},
};
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
fn parse_oid(value: &str) -> hooks::Result<Oid> {
    if value.len() != 40 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(hooks::Error::unsupported());
    }
    let mut oid = [0; 20];
    for (index, byte) in oid.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| hooks::Error::unsupported())?;
    }
    Ok(oid)
}
pub struct NativeCore {
    pub item: Option<crate::boot::ItemBinding>,
    pub moved: Mutex<Option<crate::moved_off::Fact>>,
    pub native: Arc<crate::native::Repository>,
    pub git: crate::git::Repository,
    pub events: Arc<Events>,
    pub sessions: Arc<dyn hooks::Sessions>,
}
struct Capture<'a>(&'a NativeCore);
impl crate::capture::Repository for Capture<'_> {
    fn snapshot(&mut self) -> hooks::Result<(Oid, Oid)> {
        let snapshot = self.0.native.snapshot().map_err(hook)?;
        let item = self.0.item.as_ref().ok_or_else(hooks::Error::unsupported)?;
        // A capture may run before the metadata debounce finishes. It must
        // never publish that off-item working copy as the item's head.
        let off_item = item.number != 0
            && !self
                .0
                .native
                .descends_from_item(&item.change)
                .map_err(hook)?;
        if off_item
            || self
                .0
                .moved
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some()
        {
            let head = self
                .0
                .git
                .acknowledged()
                .map_err(hook)?
                .ok_or_else(hooks::Error::unsupported)?;
            if !self
                .0
                .native
                .captured_item_head(head, &item.change)
                .map_err(hook)?
            {
                return Err(hooks::Error::unsupported());
            }
            return Ok((head, self.0.native.tree(head).map_err(hook)?));
        }
        Ok(snapshot)
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
        if settlement
            .conflict
            .is_some_and(|conflict| conflict != !paths.is_empty())
        {
            return Err(hook(io::Error::other(
                "wake outcome differs from selected result",
            )));
        }
        let clean = paths.is_empty();
        let outcome = if clean {
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
            .map_err(hook)?;
        // A clean wake still owes the host its selected snapshot, even when
        // that snapshot equals the acknowledged target. Ordinary capture
        // deduplication cannot discharge the host's reconciliation receipt.
        if clean {
            use sha2::{Digest, Sha256};
            let digest = Sha256::new()
                .chain_update(b"smithers/wake-capture/v1\0")
                .chain_update(settlement.event_id)
                .finalize();
            let mut capture_id = [0; 16];
            capture_id.copy_from_slice(&digest[..16]);
            let tree = self.native.tree(settlement.result).map_err(hook)?;
            self.events
                .append_keyed(
                    capture_id,
                    &crate::outbox::captured(settlement.result, tree, settlement.head),
                    settlement.result,
                )
                .map_err(hook)?;
        }
        Ok(())
    }
    fn settle_wake(&self, old: Oid, head: Oid, result: Oid, conflict: bool) -> hooks::Result<()> {
        let mut settlement =
            crate::wake_journal::Settlement::new(old, head, result).map_err(hook)?;
        settlement.conflict = Some(conflict);
        self.git
            .clone()
            .pin_and_sync(settlement.event_id, result)
            .map_err(hook)?;
        self.native
            .wake_journal()
            .map_err(hook)?
            .save(&settlement)
            .map_err(hook)?;
        self.finish_wake(&settlement)
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
    pub fn observe_moved_off(&self, actor: &Actor) -> hooks::Result<()> {
        let item = self.item.as_ref().ok_or_else(hooks::Error::unsupported)?;
        if item.number == 0 {
            return Ok(());
        }
        self.native.snapshot().map_err(hook)?;
        let mut prior = self.moved.lock().unwrap_or_else(|e| e.into_inner());
        let next = crate::moved_off::detect_position(
            &format!("T{}", item.number),
            "",
            self.native.descends_from_item(&item.change).map_err(hook)?,
            prior.as_ref(),
            || {
                self.native
                    .latest_on_item(&item.change)
                    .map(|oid| oid.iter().map(|b| format!("{b:02x}")).collect())
            },
        )
        .map_err(hook)?;
        if next == *prior {
            return Ok(());
        }
        let fact = next
            .as_ref()
            .or(prior.as_ref())
            .ok_or_else(hooks::Error::unsupported)?;
        let target = parse_oid(&fact.pre_move_commit)?;
        let returned_actor = if next.is_none() {
            self.native
                .return_actor(target)
                .map_err(hook)?
                .map(Actor::Principal)
                .unwrap_or_else(|| actor.clone())
        } else {
            // Clear before publishing a new move, including one to the same target.
            self.native.clear_return_actor().map_err(hook)?;
            actor.clone()
        };
        let mut fields = vec![
            field(1, conn::actor_bytes(&returned_actor)),
            field(2, item.number.to_be_bytes()),
            field(3, target),
        ];
        if next.is_none() {
            fields.push(field(4, [1]));
        }
        self.events.append(&tagged(4, &fields), Some(target))?;
        *prior = next;
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
    fn maintain(&self, cx: &mut LockCx) -> hooks::Result<()> {
        if cx.rewrite_pending {
            return Err(crate::freeze::pending_error());
        }
        self.require_settled_wake()?;
        // A settled rewrite no longer needs its rollback operation retained.
        self.native.settled().map_err(hook)?;
        self.native.cleanup(cx.hooks.clock.now()).map(|_| ())
    }
    fn validate_coding_write(&self) -> hooks::Result<()> {
        let item = self.item.as_ref().ok_or_else(hooks::Error::unsupported)?;
        if item.number == 0 {
            // Explicit, host-bound scratch workspace; an omitted binding is
            // still unavailable and must not be mistaken for a scratch branch.
            return self.ready();
        }
        if self
            .moved
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
        {
            return Err(hooks::Error {
                code: 10,
                ..hooks::Error::unsupported()
            });
        }
        // Import colocated Git moves before checking the item's change. This
        // snapshot is native and runs as machined inside the existing lock.
        self.native.snapshot().map_err(hook)?;
        if !self.native.descends_from_item(&item.change).map_err(hook)? {
            return Err(hooks::Error {
                code: 10,
                ..hooks::Error::unsupported()
            });
        }
        Ok(())
    }
    fn ready(&self) -> hooks::Result<()> {
        self.item.as_ref().ok_or_else(hooks::Error::unsupported)?;
        self.native.current().map(|_| ()).map_err(hook)
    }
    fn validate_rebase(&self, onto: Oid) -> hooks::Result<()> {
        self.require_settled_wake()?;
        self.validate_head(onto)?;
        self.native.validate_rebase(onto).map_err(hook)
    }
    fn returned_by(&self, actor: &Actor) -> hooks::Result<()> {
        let Actor::Principal(reference) = actor else {
            return Err(hooks::Error::unsupported());
        };
        let mut moved = self.moved.lock().unwrap_or_else(|e| e.into_inner());
        let fact = moved.as_mut().ok_or_else(hooks::Error::unsupported)?;
        self.native
            .record_return_actor(parse_oid(&fact.pre_move_commit)?, reference)
            .map_err(hook)?;
        fact.by = reference.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(())
    }
    fn validate_return_to_item(&self) -> hooks::Result<()> {
        self.ready()?;
        let moved = self.moved.lock().unwrap_or_else(|e| e.into_inner());
        let fact = moved.as_ref().ok_or_else(hooks::Error::unsupported)?;
        let target = parse_oid(&fact.pre_move_commit)?;
        self.validate_head(target)?;
        let item = self.item.as_ref().ok_or_else(hooks::Error::unsupported)?;
        if item.number == 0
            || !self
                .native
                .captured_item_head(target, &item.change)
                .map_err(hook)?
        {
            return Err(hooks::Error::unsupported());
        }
        self.git
            .acknowledged()
            .map_err(hook)?
            .ok_or_else(hooks::Error::unsupported)?;
        Ok(())
    }
    fn return_to_item(&self, _: &mut LockCx) -> hooks::Result<Oid> {
        let moved = self.moved.lock().unwrap_or_else(|e| e.into_inner());
        let fact = moved.as_ref().ok_or_else(hooks::Error::unsupported)?;
        // capture_local retained the post-move snapshot and operation. Only
        // the later metadata observation clears this daemon branch fact.
        let head = self
            .native
            .move_to(parse_oid(&fact.pre_move_commit)?)
            .map_err(hook)?;
        Ok(head)
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
            self.finish_wake(&settlement)?;
        } else {
            self.native
                .restore_with_ack(self.git.acknowledged().map_err(hook)?)
                .map_err(hook)?;
        }
        // The process-local rewrite kind is lost on restart. Only a successful
        // native restore back off the item withdraws pending Return attribution.
        if let Some(item) = self.item.as_ref().filter(|item| item.number > 0) {
            if !self.native.descends_from_item(&item.change).map_err(hook)? {
                self.native.clear_return_actor().map_err(hook)?;
                if let Some(fact) = self
                    .moved
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_mut()
                {
                    fact.by.clear();
                }
            }
        }
        Ok(())
    }
    fn rebase(&self, _: &mut LockCx, onto: Oid) -> hooks::Result<Oid> {
        let change = self
            .item
            .as_ref()
            .filter(|item| item.number > 0)
            .map(|item| item.change.as_str());
        #[cfg(all(feature = "killpoints", debug_assertions))]
        crate::events::killpoint("rebase-post-capture");
        let head = self.native.rebase_bound(onto, change).map_err(hook)?;
        #[cfg(all(feature = "killpoints", debug_assertions))]
        crate::events::killpoint("rebase-post-apply");
        Ok(head)

    }

    fn rebase_paths(&self, head: Oid) -> hooks::Result<Option<Vec<String>>> {
        self.native.conflict_paths(head).map(Some).map_err(hook)
    }

    fn call(&self, cx: &mut LockCx, method: u8, args: &[u8]) -> hooks::Result<Vec<u8>> {
        match method {
            1 => {
                let watcher = cx.hooks.watcher.clone();
                let idle = watcher.idle(cx);
                let flushed = cx
                    .hooks
                    .documents
                    .ready()
                    .is_ok()
                    .then(|| cx.hooks.documents.all_flushed());
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
                // Optional observations preserve decoding of older status frames.
                // Missing providers omit evidence rather than inventing quiet state.
                if let Ok(idle) = idle {
                    fields.push(field(7, [u8::from(idle)]));
                }
                if let Some(flushed) = flushed {
                    fields.push(field(8, [u8::from(flushed)]));
                }
                Ok(structure_bytes(&fields))
            }
            18 => {
                let request =
                    conn::fields("args18", args).map_err(|_| hooks::Error::unsupported())?;
                let retained = request[0]
                    .1
                    .try_into()
                    .map_err(|_| hooks::Error::unsupported())?;
                let onto = request[1].1.try_into().map_err(|_| hooks::Error::unsupported())?;
                self.require_settled_wake()?;
                let paths = crate::freeze::inspect_then(cx, |cx| {
                    // Drain observed movement before validating the retained identity.
                    let watcher = cx.hooks.watcher.clone();
                    watcher.drain(cx)?;
                    self.native.resolution_paths(retained, onto).map_err(hook)
                })?;
                Ok(structure_bytes(&[field(
                    1,
                    crate::reconcile::paths_payload(&paths)?,
                )]))
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
                let completed = self
                    .native
                    .wake_journal()
                    .map_err(hook)?
                    .completed()
                    .map_err(hook)?;
                if old == Some(head) && completed.as_ref().is_some_and(|last| last.head == head) {
                    let last = completed.unwrap();
                    let conflicted = match last.conflict {
                        Some(conflict) => conflict,
                        None => !self
                            .native
                            .conflict_paths(last.result)
                            .map_err(hook)?
                            .is_empty(),
                    };
                    if conflicted {
                        // Flush documents and stop writers before selecting the
                        // resolution. Merely seeing the same host head proves
                        // nothing about the current working-copy conflict.
                        let outcome = crate::freeze::freeze_then(cx, &Actor::Outside, |_| {
                            let snapshot = self.native.current().map_err(hook)?.0;
                            let paths = self.native.conflict_paths(snapshot).map_err(hook)?;
                            if !paths.is_empty() {
                                return Ok(crate::reconcile::Outcome::Conflict(paths));
                            }
                            self.settle_wake(head, head, snapshot, false)?;
                            Ok(crate::reconcile::Outcome::Unchanged)
                        })?;
                        self.native.settled().map_err(hook)?;
                        return outcome.result();
                    }
                }
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
                    // Persist the immutable result and identity before event or base.
                    self.settle_wake(
                        old,
                        head,
                        moved,
                        matches!(outcome, crate::reconcile::Outcome::Conflict(_)),
                    )?;
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
    #[test]
    fn return_rpc_pins_item_capture_and_preserves_post_move_commit() {
        let (dir, mut core) = fixture();
        let root = dir.path().join("workspace");
        fs::write(root.join("base"), b"base\n").unwrap();
        let base = core.native.snapshot().unwrap().0;
        crate::native::tests::child(&core.native, base, "item");
        fs::write(root.join("item"), b"item bytes before move\n").unwrap();
        let before = core.native.snapshot().unwrap().0;
        let before_git = std::process::Command::new("git")
            .args(["-C", root.to_str().unwrap(), "rev-parse", "HEAD"])
            .output()
            .unwrap();
        assert!(before_git.status.success());
        let main_ref = || {
            std::process::Command::new("git")
                .args(["-C", root.to_str().unwrap(), "rev-parse", "refs/heads/main"])
                .output()
                .unwrap()
        };
        let base_hex: String = base.iter().map(|b| format!("{b:02x}")).collect();
        assert!(std::process::Command::new("git")
            .args([
                "-C",
                root.to_str().unwrap(),
                "update-ref",
                "refs/heads/main",
                &base_hex
            ])
            .status()
            .unwrap()
            .success());
        let main_before = main_ref();
        assert!(main_before.status.success());
        let change = crate::native::tests::change(&core.native, before);
        Arc::get_mut(&mut core).unwrap().item =
            Some(crate::boot::ItemBinding { number: 2, change });
        let mut git = core.git.clone();
        git.acknowledge_and_sync(before).unwrap();
        crate::native::tests::child(&core.native, base, "off item");
        fs::write(root.join("notes.txt"), b"recoverable after move\n").unwrap();
        let before_debounce = call(core.clone(), 4, &[]);
        let pinned = conn::fields("response", &before_debounce.payload[1..]).unwrap()[1].1;
        assert_eq!(conn::fields("result4", &pinned[1..]).unwrap()[0].1, before);
        assert!(core.moved.lock().unwrap().is_none());
        core.observe_moved_off(&Actor::Session(7)).unwrap();
        let post_move = core.native.current().unwrap().0;
        let before_hex: String = before.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            core.moved.lock().unwrap().as_ref().unwrap().pre_move_commit,
            before_hex
        );
        assert_eq!(core.validate_coding_write().unwrap_err().code, 10);
        let capture = call(core.clone(), 4, &[]);
        let value = conn::fields("response", &capture.payload[1..]).unwrap()[1].1;
        assert_eq!(conn::fields("result4", &value[1..]).unwrap()[0].1, before);
        git.acknowledge_and_sync(base).unwrap();
        let refused = call(core.clone(), 4, &[]);
        let error = conn::fields("response", &refused.payload[1..]).unwrap()[1].1;
        assert_eq!(
            error[0], 255,
            "an off-item acknowledged head cannot become the item's capture"
        );
        assert_eq!(conn::fields("error", &error[1..]).unwrap()[0].1, [2]);
        git.acknowledge_and_sync(before).unwrap();
        let response = call(
            core.clone(),
            12,
            &[field(
                1,
                conn::actor_bytes(&Actor::Principal(vec![0xff; 16])),
            )],
        );
        let value = conn::fields("response", &response.payload[1..]).unwrap()[1].1;
        assert_eq!(value[0], 12, "{:?}", value);
        assert_eq!(conn::fields("result12", &value[1..]).unwrap()[0].1, before);
        assert_eq!(core.native.current().unwrap().0, before);
        let after_git = std::process::Command::new("git")
            .args(["-C", root.to_str().unwrap(), "rev-parse", "HEAD"])
            .output()
            .unwrap();
        assert!(after_git.status.success());
        assert_eq!(after_git.stdout, before_git.stdout);
        let main_after = main_ref();
        assert_eq!(main_after.status.code(), main_before.status.code());
        assert_eq!(
            main_after.stdout, main_before.stdout,
            "Return must not move mirrored main"
        );
        assert_eq!(
            fs::read(root.join("item")).unwrap(),
            b"item bytes before move\n"
        );
        assert!(!root.join("notes.txt").exists());
        let post_hex: String = post_move.iter().map(|b| format!("{b:02x}")).collect();
        let recovered = std::process::Command::new("git")
            .args([
                "-C",
                root.to_str().unwrap(),
                "show",
                &format!("{post_hex}:notes.txt"),
            ])
            .output()
            .unwrap();
        assert!(recovered.status.success());
        assert_eq!(recovered.stdout, b"recoverable after move\n");
        assert_eq!(
            core.moved.lock().unwrap().as_ref().unwrap().by,
            "ffffffffffffffffffffffffffffffff",
            "the metadata return activity belongs to the person who pressed Return"
        );
        // Return does not release coding writes before metadata observes it.
        assert_eq!(core.validate_coding_write().unwrap_err().code, 10);
        let core = reopened_core(&core, dir.path());
        core.moved.lock().unwrap().as_mut().unwrap().by.clear(); // protected boot restores target, not the process cache
        core.observe_moved_off(&Actor::Outside).unwrap();
        assert!(core.moved.lock().unwrap().is_none());
        assert!(core.validate_coding_write().is_ok());
        let owner = rustix::process::geteuid().as_raw();
        let store =
            crate::outbox_store::Store::open(&dir.path().join("state/outbox"), owner).unwrap();
        let returned = store
            .sequences()
            .map(|seq| conn::Durable::decode(&store.read(seq, owner).unwrap()).unwrap())
            .filter(|event| event.event[0] == 4)
            .last()
            .unwrap();
        let fields = conn::fields("moved_off", &returned.event[1..]).unwrap();
        assert_eq!(
            fields[0].1,
            conn::actor_bytes(&Actor::Principal(vec![0xff; 16]))
        );
        assert_eq!(fields.last().unwrap().1, [1]);
    }
    #[test]
    fn failed_return_restart_restore_does_not_attribute_a_later_manual_return_to_the_failed_choice()
    {
        let (dir, mut core) = fixture();
        fs::write(dir.path().join("workspace/base"), b"base\n").unwrap();
        let base = core.native.snapshot().unwrap().0;
        let target = crate::native::tests::child(&core.native, base, "item");
        let change = crate::native::tests::change(&core.native, target);
        Arc::get_mut(&mut core).unwrap().item =
            Some(crate::boot::ItemBinding { number: 2, change });
        core.git.clone().acknowledge_and_sync(target).unwrap();
        crate::native::tests::child(&core.native, base, "off item");
        core.observe_moved_off(&Actor::Outside).unwrap();
        let journal = || crate::rewrite_journal::Journal::open(&dir.path().join("state")).unwrap();
        let mut cx = LockCx::recovering(
            recovery_hooks(core.clone(), Arc::new(Flushed), Arc::new(ThawFails)),
            journal(),
        )
        .unwrap();
        assert!(
            crate::freeze::freeze_return(&mut cx, &Actor::Principal(vec![0xff; 16]), |cx| core
                .return_to_item(cx))
            .is_err()
        );
        assert!(cx.rewrite_pending);
        assert_eq!(
            core.native.return_actor(target).unwrap(),
            Some(vec![0xff; 16])
        );
        drop(cx);
        let core = reopened_core(&core, dir.path());
        core.moved.lock().unwrap().as_mut().unwrap().by.clear();
        let mut cx = LockCx::recovering(
            recovery_hooks(core.clone(), Arc::new(Flushed), Arc::new(Flushed)),
            journal(),
        )
        .unwrap();
        assert!(!cx.last_rewrite_was_return);
        crate::freeze::restore(&mut cx, &Actor::Outside).unwrap();
        assert_eq!(core.native.return_actor(target).unwrap(), None);
        assert!(!core
            .native
            .descends_from_item(&core.item.as_ref().unwrap().change)
            .unwrap());
        core.native.move_to(target).unwrap();
        core.observe_moved_off(&Actor::Principal(vec![7; 16]))
            .unwrap();
        let owner = rustix::process::geteuid().as_raw();
        let store =
            crate::outbox_store::Store::open(&dir.path().join("state/outbox"), owner).unwrap();
        let event = store
            .sequences()
            .map(|seq| conn::Durable::decode(&store.read(seq, owner).unwrap()).unwrap())
            .filter(|event| event.event[0] == 4)
            .last()
            .unwrap();
        assert_eq!(
            conn::fields("moved_off", &event.event[1..]).unwrap()[0].1,
            conn::actor_bytes(&Actor::Principal(vec![7; 16]))
        );
    }
    #[test]
    fn metadata_detector_uses_native_item_ancestry_for_git_and_jj_moves() {
        for (case, moved) in [
            ("git checkout", true),
            ("jj edit", true),
            ("jj new main", true),
            ("jj abandon", true),
            ("git commit", false),
            ("jj new item", false),
            ("git same head", false),
        ] {
            let (dir, mut core) = fixture();
            let root = dir.path().join("workspace");
            fs::write(root.join("base"), b"base\n").unwrap();
            let base = core.native.snapshot().unwrap().0;
            crate::native::tests::child(&core.native, base, "item");
            fs::write(root.join("item"), b"item\n").unwrap();
            let before = core.native.snapshot().unwrap().0;
            let change = crate::native::tests::change(&core.native, before);
            crate::native::tests::child(&core.native, before, "working copy on item");
            let before = core.native.current().unwrap().0;

            Arc::get_mut(&mut core).unwrap().item =
                Some(crate::boot::ItemBinding { number: 2, change });
            let mut git = core.git.clone();
            git.acknowledge_and_sync(before).unwrap();
            let oid = |id: [u8; 20]| id.iter().map(|b| format!("{b:02x}")).collect::<String>();
            let run = |program: &str, args: &[&str]| {
                let output = std::process::Command::new(program)
                    .current_dir(&root)
                    .args(args)
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{case}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            };
            match case {
                "git checkout" => run("git", &["checkout", "--detach", &oid(base)]),
                "jj edit" => run("jj", &["edit", &oid(base)]),
                "jj new main" => run("jj", &["new", &oid(base)]),
                "jj abandon" => run("jj", &["abandon", &core.item.as_ref().unwrap().change]),
                "git commit" => {
                    fs::write(root.join("later"), b"later\n").unwrap();
                    run("git", &["add", "."]);
                    run(
                        "git",
                        &[
                            "-c",
                            "user.name=Fixture",
                            "-c",
                            "user.email=fixture@example.com",
                            "-c",
                            "core.hooksPath=/dev/null",
                            "commit",
                            "-m",
                            "on item",
                        ],
                    );
                }
                "jj new item" => run("jj", &["new"]),
                "git same head" => run("git", &["checkout", "-b", "same-head"]),
                _ => unreachable!(),
            }
            core.observe_moved_off(&Actor::Session(7)).unwrap();
            let fact = core.moved.lock().unwrap();
            assert_eq!(fact.is_some(), moved, "{case}");
            if let Some(fact) = fact.as_ref() {
                assert_eq!(fact.pre_move_commit, oid(before), "{case}");
            }
            drop(fact);
            assert_eq!(core.validate_coding_write().is_err(), moved, "{case}");
        }
    }
    #[test]
    fn scratch_metadata_observation_does_not_snapshot_pending_writes() {
        let (dir, core) = fixture();
        let before = core.native.current().unwrap();
        fs::write(dir.path().join("workspace/pending"), b"pending scratch bytes").unwrap();
        core.observe_moved_off(&Actor::Outside).unwrap();
        assert_eq!(core.native.current().unwrap(), before);
        assert_eq!(
            fs::read(dir.path().join("workspace/pending")).unwrap(),
            b"pending scratch bytes"
        );
    }
    #[test]
    fn coding_write_guard_requires_binding_and_refuses_off_item_after_snapshot() {
        let (dir, mut core) = fixture();
        Arc::get_mut(&mut core).unwrap().item = None;
        assert_eq!(core.validate_coding_write().unwrap_err().code, 2);
        assert_eq!(core.ready().unwrap_err().code, 2);
        fs::write(dir.path().join("workspace/base"), b"base\n").unwrap();
        let base = core.native.snapshot().unwrap().0;
        let item = crate::native::tests::child(&core.native, base, "bound item");
        let change = crate::native::tests::change(&core.native, item);
        Arc::get_mut(&mut core).unwrap().item =
            Some(crate::boot::ItemBinding { number: 2, change });
        assert!(core.ready().is_ok());
        assert!(core.validate_coding_write().is_ok());
        crate::native::tests::child(&core.native, item, "descendant");
        assert!(core.validate_coding_write().is_ok());
        crate::native::tests::child(&core.native, base, "off item");
        assert_eq!(core.validate_coding_write().unwrap_err().code, 10);
        assert_eq!(
            fs::read(dir.path().join("workspace/base")).unwrap(),
            b"base\n"
        );
    }
    #[test]
    fn moved_off_agent_dispatch_refuses_before_metadata_debounce_and_disk_effects() {
        // The kernel's UID/cgroup admission is a separate reference-host check.
        // This exercises its production queued write dispatcher and real native
        // repository guard with an already registered run identity.
        let (dir, mut core) = fixture();
        let root = dir.path().join("workspace");
        fs::write(root.join("base"), b"base\n").unwrap();
        let base = core.native.snapshot().unwrap().0;
        let item = crate::native::tests::child(&core.native, base, "item");
        let change = crate::native::tests::change(&core.native, item);
        Arc::get_mut(&mut core).unwrap().item =
            Some(crate::boot::ItemBinding { number: 2, change });
        crate::native::tests::child(&core.native, base, "off item");
        fs::write(root.join("notes.txt"), b"keep after move\n").unwrap();
        let files = Arc::new(crate::files::Files::fixture(
            std::fs::File::open(&root).unwrap(),
            core.clone(),
        ));
        let executor = crate::lock::Executor::start(Hooks {
            core: core.clone(),
            ..Default::default()
        })
        .unwrap();
        let admitted = executor.lock.epoch();
        let response = executor
            .lock
            .run_blocking("coding_write", move |cx| {
                let mut content = 9u32.to_be_bytes().to_vec();
                content.extend(b"overwrite");
                let args = conn::local_write_args(
                    &structure_bytes(&[
                        field(1, bytes("notes.txt")),
                        field(
                            2,
                            tagged(
                                1,
                                &[field(1, crate::doc::state::digest(b"keep after move\n"))],
                            ),
                        ),
                        field(3, content),
                    ]),
                    [7; 16],
                )
                .unwrap();
                crate::local::write_response(cx, &files, 73, args, admitted)
            })
            .unwrap();
        let error = conn::fields("response", &response.payload[1..]).unwrap()[1].1;
        assert_eq!(error[0], 255);
        assert_eq!(conn::fields("error", &error[1..]).unwrap()[0].1, [10]);
        assert!(
            core.moved.lock().unwrap().is_none(),
            "write refusal cannot wait for the metadata debounce"
        );
        assert_eq!(
            fs::read(root.join("notes.txt")).unwrap(),
            b"keep after move\n"
        );
        let batch_files = Arc::new(crate::files::Files::fixture(
            std::fs::File::open(&root).unwrap(),
            core.clone(),
        ));
        let batch_response = executor
            .lock
            .run_blocking("coding_batch", move |cx| {
                crate::local::batch_response(
                    cx,
                    &batch_files,
                    74,
                    vec![crate::hooks::FileWrite {
                        path: "notes.txt".into(),
                        base: crate::hooks::Base::Digest(crate::doc::state::digest(
                            b"keep after move\n",
                        )),
                        content: Some(b"overwrite".to_vec()),
                    }],
                    Actor::Principal(vec![7; 16]),
                    admitted,
                )
            })
            .unwrap();
        let batch_error = conn::fields("response", &batch_response.payload[1..]).unwrap()[1].1;
        assert_eq!(batch_error[0], 255);
        assert_eq!(conn::fields("error", &batch_error[1..]).unwrap()[0].1, [10]);
        assert_eq!(
            fs::read(root.join("notes.txt")).unwrap(),
            b"keep after move\n"
        );
        executor.shutdown().unwrap();
    }
    #[test]
    #[allow(non_snake_case)]
    fn TestMovedOffUnavailableProviders() {
        // Real native repository and framed Return dispatcher. Startup is not
        // enough: a provider can disappear after an authenticated link starts.
        for missing in [
            "watcher",
            "documents",
            "sessions",
            "broker",
            "events",
            "core",
            "binding",
        ] {
            let (dir, mut core) = fixture();
            let root = dir.path().join("workspace");
            fs::write(root.join("base"), b"base\n").unwrap();
            let base = core.native.snapshot().unwrap().0;
            let item = crate::native::tests::child(&core.native, base, "item");
            let change = crate::native::tests::change(&core.native, item);
            Arc::get_mut(&mut core).unwrap().item =
                Some(crate::boot::ItemBinding { number: 2, change });
            core.git.clone().acknowledge_and_sync(item).unwrap();
            crate::native::tests::child(&core.native, base, "off item");
            core.observe_moved_off(&Actor::Outside).unwrap();
            fs::write(root.join("notes.txt"), b"keep after move\n").unwrap();
            let before = core.native.snapshot().unwrap().0;
            if missing == "binding" {
                Arc::get_mut(&mut core).unwrap().item = None;
            }
            let mut hooks = Hooks {
                core: core.clone(),
                events: core.events.clone(),
                watcher: Arc::new(Flushed),
                documents: Arc::new(Flushed),
                sessions: Arc::new(Flushed),
                broker: Arc::new(Flushed),
                ..Default::default()
            };
            match missing {
                "watcher" => hooks.watcher = Arc::new(Disabled),
                "documents" => hooks.documents = Arc::new(Disabled),
                "sessions" => hooks.sessions = Arc::new(Disabled),
                "broker" => hooks.broker = Arc::new(Disabled),
                "events" => hooks.events = Arc::new(Disabled),
                "core" => hooks.core = Arc::new(Disabled),
                "binding" => (),
                _ => unreachable!(),
            }
            assert!(crate::wiring::compose(hooks.clone()).is_err(), "{missing}");
            let frame = Frame {
                kind: 1,
                stream: 0,
                payload: tagged(
                    1,
                    &[
                        field(1, 73u32.to_be_bytes()),
                        field(
                            2,
                            tagged(
                                12,
                                &[field(1, conn::actor_bytes(&Actor::Principal(vec![7; 16])))],
                            ),
                        ),
                    ],
                ),
            };
            let mut output = Vec::new();
            let mut cx = LockCx::new(hooks);
            rpc::serve_one(
                &mut std::io::Cursor::new(frame.encode().unwrap()),
                &mut output,
                &mut cx,
            )
            .unwrap();
            let response = Frame::decode(&output).unwrap();
            let value = conn::fields("response", &response.payload[1..]).unwrap()[1].1;
            assert_eq!(value[0], 255, "{missing}");
            assert_eq!(
                conn::fields("error", &value[1..]).unwrap()[0].1,
                [2],
                "{missing}"
            );
            assert_eq!(core.native.current().unwrap().0, before, "{missing}");
            assert_eq!(
                fs::read(root.join("notes.txt")).unwrap(),
                b"keep after move\n",
                "{missing}"
            );
            assert!(core.validate_coding_write().is_err(), "{missing}");
            // Exercise the same authenticated coding-batch dispatcher used by
            // write/edit/apply_patch, after the failed Return. A readiness
            // refusal must never release the moved-off hold or reach disk.
            let files =
                crate::files::Files::fixture(std::fs::File::open(&root).unwrap(), core.clone());
            let admitted = cx.epoch.load(std::sync::atomic::Ordering::SeqCst);
            for _ in 0..2 {
                let response = crate::local::batch_response(
                    &mut cx,
                    &files,
                    74,
                    vec![crate::hooks::FileWrite {
                        path: "notes.txt".into(),
                        // Literal SHA-256 of "keep after move\n", computed independently.
                        base: crate::hooks::Base::Digest([
                            224, 145, 228, 145, 113, 137, 199, 136, 59, 135, 112, 223,
                            146, 163, 25, 118, 123, 117, 204, 213, 81, 56, 218, 245,
                            119, 224, 208, 221, 102, 251, 2, 249,
                        ]),
                        content: Some(b"must never land".to_vec()),
                    }],
                    Actor::Principal(vec![7; 16]),
                    admitted,
                );
                let value = conn::fields("response", &response.payload[1..]).unwrap()[1].1;
                assert_eq!(value[0], 255, "{missing}");
                assert_eq!(
                    conn::fields("error", &value[1..]).unwrap()[0].1,
                    if missing == "binding" { [2] } else { [10] },
                    "{missing}"
                );
                assert_eq!(core.native.current().unwrap().0, before, "{missing}");
                assert_eq!(core.git.acknowledged().unwrap(), Some(item), "{missing}");
                assert_eq!(
                    fs::read(root.join("notes.txt")).unwrap(),
                    b"keep after move\n",
                    "{missing}"
                );
            }
        }
    }
    #[test]
    fn moved_off_return_refuses_lost_broker_transport_after_composition() {
        use rustix::net::{
            recv, send, socketpair, AddressFamily, RecvFlags, SendFlags, SocketFlags, SocketType,
        };
        // Exercise the installed broker client, not a Disabled/Flushed broker.
        // The peer supplies literal broken-authority packets; no privileged
        // effects or cgroup emulation are needed to prove these refusals.
        for stage in ["readiness", "freeze"] {
            for failure in [
                "disconnect",
                "truncated",
                "correlation",
                "operation",
                "oversized",
            ] {
                let (dir, mut core) = fixture();
                let root = dir.path().join("workspace");
                fs::write(root.join("base"), b"base\n").unwrap();
                let base = core.native.snapshot().unwrap().0;
                let item = crate::native::tests::child(&core.native, base, "item");
                let change = crate::native::tests::change(&core.native, item);
                Arc::get_mut(&mut core).unwrap().item =
                    Some(crate::boot::ItemBinding { number: 2, change });
                core.git.clone().acknowledge_and_sync(item).unwrap();
                crate::native::tests::child(&core.native, base, "off item");
                core.observe_moved_off(&Actor::Outside).unwrap();
                fs::write(root.join("notes.txt"), b"keep after move\n").unwrap();
                let before = core.native.snapshot().unwrap().0;
                let (server, client) = socketpair(
                    AddressFamily::UNIX,
                    SocketType::SEQPACKET,
                    SocketFlags::CLOEXEC,
                    None,
                )
                .unwrap();
                let peer = std::thread::spawn(move || {
                    rustix::net::sockopt::set_socket_timeout(
                        &server,
                        rustix::net::sockopt::Timeout::Recv,
                        Some(std::time::Duration::from_secs(2)),
                    )
                    .unwrap();
                    let mut packet = [0; 64];
                    // Composition checks the shared session and broker providers.
                    for id in 1u32..=if stage == "freeze" { 4 } else { 2 } {
                        let (n, _) = recv(&server, &mut packet, RecvFlags::empty()).unwrap();
                        assert_eq!(&packet[..n], &[id.to_be_bytes().as_slice(), &[23]].concat());
                        send(&server, &packet[..n], SendFlags::NOSIGNAL).unwrap();
                    }
                    let (n, _) = recv(&server, &mut packet, RecvFlags::empty()).unwrap();
                    let id = if stage == "freeze" { 5u32 } else { 3 };
                    let operation = if stage == "freeze" { 1 } else { 23 };
                    let mut expected = id.to_be_bytes().to_vec();
                    expected.push(operation);
                    if stage == "freeze" {
                        // Production Return bounds the freeze to exactly 1000 ms.
                        expected.extend([0, 0, 0, 5, 1, 0, 0, 3, 232]);
                    }
                    assert_eq!(&packet[..n], expected);
                    let reply = match failure {
                        "disconnect" => return,
                        "truncated" => id.to_be_bytes().to_vec(),
                        "correlation" => [(id + 1).to_be_bytes().as_slice(), &[operation]].concat(),
                        "operation" => [id.to_be_bytes().as_slice(), &[2]].concat(),
                        "oversized" => {
                            let mut reply = vec![0; 65561];
                            reply[..4].copy_from_slice(&id.to_be_bytes());
                            reply[4] = operation;
                            reply
                        }
                        _ => unreachable!(),
                    };
                    send(&server, &reply, SendFlags::NOSIGNAL).unwrap();
                });
                let broker = Arc::new(crate::broker::control::SocketpairBroker::new(client).unwrap());
                let hooks = crate::wiring::compose(Hooks {
                    core: core.clone(),
                    events: core.events.clone(),
                    watcher: Arc::new(Flushed),
                    documents: Arc::new(Flushed),
                    sessions: broker.clone(),
                    broker,
                    ..Default::default()
                })
                .unwrap();
                let mut cx = LockCx::new(hooks);
                // Repeat after transport failure: a poisoned connection must not
                // regain authority or silently fall back to repository execution.
                let files = crate::files::Files::fixture(std::fs::File::open(&root).unwrap(), core.clone());
                for _ in 0..2 {
                    let response = call_in(
                        &mut cx,
                        12,
                        &[field(1, conn::actor_bytes(&Actor::Principal(vec![7; 16])))],
                    );
                    let value = conn::fields("response", &response.payload[1..]).unwrap()[1].1;
                    assert_eq!(value[0], 255, "{failure}");
                    assert_eq!(
                        conn::fields("error", &value[1..]).unwrap()[0].1,
                        [12],
                        "{failure}"
                    );
                    assert_eq!(core.native.current().unwrap().0, before, "{failure}");
                    assert_eq!(core.git.acknowledged().unwrap(), Some(item), "{failure}");
                    assert!(core.moved.lock().unwrap().is_some(), "{failure}");
                    let admitted = cx.epoch.load(std::sync::atomic::Ordering::SeqCst);
                    let response = crate::local::batch_response(
                        &mut cx,
                        &files,
                        74,
                        vec![crate::hooks::FileWrite {
                            path: "notes.txt".into(),
                            base: crate::hooks::Base::Digest(crate::doc::state::digest(
                                b"keep after move\n",
                            )),
                            content: Some(b"must never land".to_vec()),
                        }],
                        Actor::Principal(vec![7; 16]),
                        admitted,
                    );
                    let value = conn::fields("response", &response.payload[1..]).unwrap()[1].1;
                    assert_eq!(value[0], 255, "{failure}");
                    assert_eq!(
                        conn::fields("error", &value[1..]).unwrap()[0].1,
                        [10],
                        "{failure}"
                    );
                    assert_eq!(
                        fs::read(root.join("notes.txt")).unwrap(),
                        b"keep after move\n",
                        "{failure}"
                    );
                }
                peer.join().unwrap();
            }
        }
    }
    // Run only from the install/main-built test bundle in an isolated guest.
    // The broker stays root; the Return dispatcher and repository stay machined.
    #[test]
    #[ignore = "requires isolated guest, installed admission and fixed cgroup-v2 parent"]
    #[allow(non_snake_case)]
    fn TestReturnToItemBrokerValidatesFreezeInputs() {
        use crate::broker::{
            cgroups::Cgroups,
            control,
            spawn::{InstalledAdmission, Processes},
            supervisor::Supervisor,
        };
        use rustix::net::{
            recv, send, socketpair, AddressFamily, RecvFlags, SendFlags, SocketFlags, SocketType,
        };
        use std::os::{fd::AsRawFd, unix::process::CommandExt};
        assert_eq!(
            rustix::process::geteuid().as_raw(),
            0,
            "guest broker must run as root"
        );
        let (server, client) = socketpair(
            AddressFamily::UNIX,
            SocketType::SEQPACKET,
            SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        let broker = std::thread::spawn(move || {
            let kernel = Processes::new(Cgroups::open().unwrap(), InstalledAdmission);
            control::serve(&server, &mut Supervisor::new(kernel)).unwrap();
        });
        rustix::net::sockopt::set_socket_timeout(
            &client,
            rustix::net::sockopt::Timeout::Recv,
            Some(std::time::Duration::from_secs(2)),
        )
        .unwrap();
        let exchange = |op, fields: &[Vec<u8>]| {
            let mut packet = 9u32.to_be_bytes().to_vec();
            packet.extend(tagged(op, fields));
            send(&client, &packet, SendFlags::NOSIGNAL).unwrap();
            let mut output = [0; 65536];
            let (length, _) = recv(&client, &mut output, RecvFlags::empty()).unwrap();
            output[..length].to_vec()
        };
        // Registry identities and fixed cgroup paths are never freeze inputs.
        for fields in [
            vec![field(1, 0u32.to_be_bytes())],
            vec![field(1, 1001u32.to_be_bytes())],
            vec![
                field(1, 1000u32.to_be_bytes()),
                field(2, 999u32.to_be_bytes()),
            ],
            vec![
                field(1, 1000u32.to_be_bytes()),
                field(2, b"/sys/fs/cgroup/smithers/sessions/../../root"),
            ],
            vec![
                field(1, 1000u32.to_be_bytes()),
                field(2, b"/workspace/.git/config"),
            ],
            vec![
                field(1, 1000u32.to_be_bytes()),
                field(1, 1u32.to_be_bytes()),
            ],
        ] {
            assert_eq!(exchange(1, &fields)[4], 255);
        }
        assert_eq!(exchange(254, &[])[4], 255);
        assert_eq!(exchange(7, &[field(1, 999u32.to_be_bytes())])[4], 255);
        assert!(fs::read_to_string("/sys/fs/cgroup/smithers/sessions/cgroup.events")
            .unwrap().lines().any(|line| line == "frozen 0"));
        assert_eq!(exchange(2, &[field(1, b"/workspace/evil")])[4], 255);
        // Pass only the already boot-controlled socket descriptor to machined.
        rustix::io::fcntl_setfd(&client, rustix::io::FdFlags::empty()).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "native_core::tests::return_broker_guest_child",
                "--ignored",
                "--nocapture",
            ])
            .env("SMITHERS_COL05_BROKER_FD", client.as_raw_fd().to_string())
            .uid(19998)
            .gid(20000)
            .status()
            .unwrap();
        assert!(status.success(), "unprivileged Return dispatcher failed");
        drop(client);
        broker.join().unwrap();
        // Oversized frames must terminate the real broker without a freeze.
        for length in [65537, 65561, 70000] {
            let (server, client) = socketpair(
                AddressFamily::UNIX,
                SocketType::SEQPACKET,
                SocketFlags::CLOEXEC,
                None,
            )
            .unwrap();
            let broker = std::thread::spawn(move || {
                let kernel = Processes::new(Cgroups::open().unwrap(), InstalledAdmission);
                assert_eq!(
                    control::serve(&server, &mut Supervisor::new(kernel))
                        .unwrap_err()
                        .kind(),
                    io::ErrorKind::InvalidData
                );
            });
            let mut packet = 9u32.to_be_bytes().to_vec();
            packet.extend(tagged(1, &[field(1, 1000u32.to_be_bytes())]));
            packet.resize(length, 0);
            send(&client, &packet, SendFlags::NOSIGNAL).unwrap();
            drop(client);
            broker.join().unwrap();
        }
        assert!(
            fs::read_to_string("/sys/fs/cgroup/smithers/sessions/cgroup.events")
                .unwrap()
                .lines()
                .any(|line| line == "frozen 0")
        );
    }

    #[test]
    #[ignore = "child of TestReturnToItemBrokerValidatesFreezeInputs, never run separately"]
    fn return_broker_guest_child() {
        use std::os::fd::{FromRawFd, OwnedFd};
        assert_eq!(rustix::process::geteuid().as_raw(), 19998);
        let fd: i32 = std::env::var("SMITHERS_COL05_BROKER_FD")
            .unwrap()
            .parse()
            .unwrap();
        assert!(fd > 2);
        // Owned descriptor inherited solely from the parent guest test.
        let socket = unsafe { OwnedFd::from_raw_fd(fd) };
        let (dir, mut core) = fixture();
        let root = dir.path().join("workspace");
        fs::write(root.join("base"), b"base\n").unwrap();
        let base = core.native.snapshot().unwrap().0;
        let item = crate::native::tests::child(&core.native, base, "item");
        let change = crate::native::tests::change(&core.native, item);
        Arc::get_mut(&mut core).unwrap().item =
            Some(crate::boot::ItemBinding { number: 2, change });
        core.git.clone().acknowledge_and_sync(item).unwrap();
        crate::native::tests::child(&core.native, base, "off item");
        core.observe_moved_off(&Actor::Outside).unwrap();
        fs::write(root.join("notes.txt"), b"keep after move\n").unwrap();
        // Branch-controlled config and aliases are daemon-only data. A FIFO
        // makes an accidental root read observable as a bounded socket timeout;
        // even its symlink must be rejected before the broker touches a file.
        let fifo = root.join("hostile-config");
        let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let alias = root.join("config-alias");
        std::os::unix::fs::symlink(&fifo, &alias).unwrap();
        for path in [&fifo, &alias] {
            let mut packet = 9u32.to_be_bytes().to_vec();
            packet.extend(tagged(1, &[field(1, 1000u32.to_be_bytes()),
                field(2, path.to_str().unwrap().as_bytes())]));
            rustix::net::send(&socket, &packet, rustix::net::SendFlags::NOSIGNAL).unwrap();
            let mut response = [0; 65536];
            let (length, _) = rustix::net::recv(&socket, &mut response, rustix::net::RecvFlags::empty()).unwrap();
            assert!(length > 4);
            assert_eq!(response[4], 255);
        }
        fs::remove_file(alias).unwrap();
        fs::remove_file(fifo).unwrap();
        let broker = Arc::new(crate::broker::control::SocketpairBroker::new(socket).unwrap());
        let files = Arc::new(crate::files::Files::new(std::fs::File::open(&root).unwrap(), core.clone()).unwrap());
        let executor = crate::lock::Executor::start(Hooks {
            core: core.clone(), events: core.events.clone(),
            documents: Arc::new(Flushed), watcher: Arc::new(Flushed),
            sessions: broker.clone(), broker, ..Default::default()
        }).unwrap();
        let admitted = executor.lock.epoch();
        let (release, held) = std::sync::mpsc::channel();
        let returning = executor.lock.enqueue("return_to_item", move |cx| {
            held.recv().unwrap();
            call_in(cx, 12, &[field(1, conn::actor_bytes(&Actor::Principal(vec![7;16])))])
        }).unwrap();
        // Admitted before Return, but queued behind it on the production FIFO.
        let queued = executor.lock.enqueue("coding_batch", move |cx| {
            crate::local::batch_response(cx, &files, 74, vec![crate::hooks::FileWrite {
                path: "notes.txt".into(), base: crate::hooks::Base::Absent,
                content: Some(b"must never land".to_vec()),
            }], Actor::Principal(vec![7;16]), admitted)
        }).unwrap();
        release.send(()).unwrap();
        let response = returning.wait().unwrap();
        let value = conn::fields("response", &response.payload[1..]).unwrap()[1].1;
        assert_eq!(value[0], 12, "{value:?}");
        let response = queued.wait().unwrap();
        let value = conn::fields("response", &response.payload[1..]).unwrap()[1].1;
        assert_eq!(value[0], 255);
        assert_eq!(conn::fields("error", &value[1..]).unwrap()[0].1, [10]);
        executor.shutdown().unwrap();
        assert_eq!(core.native.current().unwrap().0, item);
        assert!(!root.join("notes.txt").exists());
    }
    // These collaborators isolate native core behavior; production composition
    // uses the real document/watcher/broker providers in installed.rs.
    struct Flushed;
    impl hooks::Sessions for Flushed {
        fn ready(&self) -> hooks::Result<()> {
            Ok(())
        }
    }
    impl Documents for Flushed {
        fn ready(&self) -> hooks::Result<()> {
            Ok(())
        }
        fn flush_all(&self, _: &mut LockCx) -> hooks::Result<u16> {
            Ok(0)
        }
        fn reconcile_all(&self, _: &mut LockCx, _: &Actor) -> hooks::Result<()> {
            Ok(())
        }
    }
    impl Broker for Flushed {
        fn ready(&self) -> hooks::Result<()> {
            Ok(())
        }
        fn freeze(&self, _: std::time::Duration) -> hooks::Result<Option<u32>> {
            Ok(None)
        }
        fn thaw(&self) -> hooks::Result<()> {
            Ok(())
        }
    }
    impl Watcher for Flushed {
        fn ready(&self) -> hooks::Result<()> {
            Ok(())
        }
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
    #[cfg(all(feature = "killpoints", debug_assertions))]
    pub(crate) fn framed_capture(core: Arc<NativeCore>) -> Frame {
        let mut cx = LockCx::new(Hooks {
            events: core.events.clone(),
            core,
            documents: Arc::new(Flushed),
            watcher: Arc::new(Flushed),
            ..Default::default()
        });
        let request = Frame {
            kind: 1,
            stream: 0,
            payload: tagged(
                1,
                &[field(1, 73u32.to_be_bytes()), field(2, tagged(4, &[]))],
            ),
        }
        .encode()
        .unwrap();
        let mut output = Vec::new();
        rpc::serve_one(&mut std::io::Cursor::new(request), &mut output, &mut cx).unwrap();
        Frame::decode(&output).unwrap()
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
            sessions: Arc::new(Flushed),
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
            item: Some(crate::boot::ItemBinding {
                number: 0,
                change: String::new(),
            }),
            moved: Mutex::new(None),
            native: native.clone(),
            git: repository.clone(),
            events: events.clone(),
            sessions: Arc::new(Disabled),
        });
        (dir, core)
    }
    #[test]
    fn status_idle_observations_require_each_provider() {
        struct Safety(bool);
        impl hooks::Broker for Safety {
            fn freeze(&self, _: std::time::Duration) -> hooks::Result<Option<u32>> {
                panic!("status must not freeze writers")
            }
        }
        impl Watcher for Safety {
            fn drain(&self, _: &mut LockCx) -> hooks::Result<()> {
                panic!("status must not drain the watcher")
            }
            fn idle(&self, _: &mut LockCx) -> hooks::Result<bool> {
                Ok(self.0)
            }
        }
        impl Documents for Safety {
            fn flush_all(&self, _: &mut LockCx) -> hooks::Result<u16> {
                panic!("status must not flush documents")
            }
            fn ready(&self) -> hooks::Result<()> {
                Ok(())
            }
            fn all_flushed(&self) -> bool {
                self.0
            }
        }
        let (_dir, core) = fixture();
        for (quiet, flushed) in [(false, false), (false, true), (true, false), (true, true)] {
            let mut cx = LockCx::new(Hooks {
                broker: Arc::new(Safety(quiet)),
                watcher: Arc::new(Safety(quiet)),
                documents: Arc::new(Safety(flushed)),
                ..Default::default()
            });
            let body = core.call(&mut cx, 1, &[]).unwrap();
            let fields = conn::fields("result1", &body).unwrap();
            assert_eq!(
                fields.iter().find(|(tag, _)| *tag == 7).unwrap().1,
                [u8::from(quiet)]
            );
            assert_eq!(
                fields.iter().find(|(tag, _)| *tag == 8).unwrap().1,
                [u8::from(flushed)]
            );
        }
        let mut cx = LockCx::new(Hooks::default());
        let body = core.call(&mut cx, 1, &[]).unwrap();
        let fields = conn::fields("result1", &body).unwrap();
        assert!(fields.iter().all(|(tag, _)| *tag != 7 && *tag != 8));
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
        assert_eq!(status.iter().find(|(tag, _)| *tag == 6).unwrap().1, [0, 0]);
        assert_eq!(status.iter().find(|(tag, _)| *tag == 8).unwrap().1, [1]);
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
    fn reconciliations(dir: &std::path::Path) -> Vec<conn::Durable> {
        let owner = rustix::process::geteuid().as_raw();
        let store = crate::outbox_store::Store::open(&dir.join("state/outbox"), owner).unwrap();
        store
            .sequences()
            .map(|seq| conn::Durable::decode(&store.read(seq, owner).unwrap()).unwrap())
            .filter(|event| event.event[0] == 3)
            .collect()
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
            reconciliations(dir.path()).len(),
            1,
            "retry adds no duplicate reconciliation"
        );
        assert_eq!(fs::read_to_string(root.join("conflict")).unwrap(), markers);
        fs::write(root.join("conflict"), b"both versions resolved\n").unwrap();
        assert_eq!(wake_result(&call(core.clone(), 5, &[field(1, onto)]))[0], 1);
        assert_eq!(
            fs::read(root.join("conflict")).unwrap(),
            b"both versions resolved\n"
        );
        let events = reconciliations(dir.path());
        assert_eq!(events.len(), 2);
        assert_ne!(events[0].id, events[1].id);
        let fields = conn::fields("reconciled", &events[1].event[1..]).unwrap();
        assert_eq!(fields[0].1, onto);
        assert_eq!(fields[1].1, onto);
        assert_eq!(fields[2].1, [1]);
        let core = reopened_core(&core, dir.path());
        assert_eq!(wake_result(&call(core.clone(), 5, &[field(1, onto)]))[0], 1);
        assert_eq!(
            reconciliations(dir.path())
                .iter()
                .map(|e| e.id)
                .collect::<Vec<_>>(),
            events.iter().map(|e| e.id).collect::<Vec<_>>()
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
    #[test]
    fn clean_wake_retains_selected_capture_after_reconciliation_once() {
        let (dir, core, base, onto) = dirty_wake_fixture();
        assert_eq!(wake_result(&call(core.clone(), 5, &[field(1, onto)]))[0], 2);
        let owner = rustix::process::geteuid().as_raw();
        let store =
            crate::outbox_store::Store::open(&dir.path().join("state/outbox"), owner).unwrap();
        let events: Vec<_> = store
            .sequences()
            .map(|seq| conn::Durable::decode(&store.read(seq, owner).unwrap()).unwrap())
            .collect();
        let reconciliation = events.iter().position(|event| event.event[0] == 3).unwrap();
        let selected = &events[reconciliation + 1];
        assert_eq!(selected.event[0], 2);
        let fields = conn::fields("captured", &selected.event[1..]).unwrap();
        assert_eq!(fields[0].1, core.native.current().unwrap().0);
        assert_eq!(
            fields[1].1,
            core.native.tree(core.native.current().unwrap().0).unwrap()
        );
        assert_eq!(fields[2].1, onto);
        assert_ne!(base, onto);
        let depth = core.events.depth().unwrap();
        assert_eq!(wake_result(&call(core.clone(), 5, &[field(1, onto)]))[0], 1);
        assert_eq!(core.events.depth().unwrap(), depth);
        assert_eq!(
            fs::read(dir.path().join("workspace/local")).unwrap(),
            b"local version\n"
        );
        assert_eq!(
            fs::read(dir.path().join("workspace/host")).unwrap(),
            b"host version\n"
        );
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
            item: core.item.clone(),
            moved: Mutex::new(core.moved.lock().unwrap().clone()),
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
    fn conflict_fixture() -> (tempfile::TempDir, Arc<NativeCore>, Oid) {
        let (dir, core) = fixture();
        let file = dir.path().join("workspace/conflict");
        fs::write(&file, b"original\n").unwrap();
        let base = core.native.snapshot().unwrap().0;
        crate::native::tests::child(&core.native, base, "host changed");
        fs::write(&file, b"host\n").unwrap();
        let head = core.native.snapshot().unwrap().0;
        core.native.move_to(base).unwrap();
        core.git.clone().acknowledge_and_sync(base).unwrap();
        fs::write(&file, b"local\n").unwrap();
        assert_eq!(wake_result(&call(core.clone(), 5, &[field(1, head)]))[0], 3);
        assert_eq!(
            core.native
                .wake_journal()
                .unwrap()
                .completed()
                .unwrap()
                .unwrap()
                .conflict,
            Some(true)
        );
        (dir, core, head)
    }
    #[test]
    fn acknowledged_conflict_still_resolves_after_restart_and_acknowledged_resolution_stays_quiet()
    {
        fn acknowledge_and_restart(
            core: Arc<NativeCore>,
            dir: &std::path::Path,
        ) -> Arc<NativeCore> {
            let native = core.native.clone();
            let git = core.git.clone();
            drop(core);
            let owner = rustix::process::geteuid().as_raw();
            let mut outbox = crate::outbox::Outbox::open(
                crate::outbox_store::Store::open(&dir.join("state/outbox"), owner).unwrap(),
                owner,
                git.clone(),
            )
            .unwrap();
            // Exercise the real durable ACK removal boundary. Bundle transport
            // is covered independently; this fixture assumes import completed.
            while let Some(event) = outbox.front().unwrap() {
                outbox.after_bundle(event.seq).unwrap();
                outbox
                    .acknowledge(&Frame {
                        kind: 2,
                        stream: 0,
                        payload: tagged(
                            3,
                            &[
                                field(1, event.seq.to_be_bytes()),
                                field(2, [if event.event[0] == 3 { 1 } else { 5 }]),
                            ],
                        ),
                    })
                    .unwrap();
            }
            assert!(git.clone().pending().unwrap().is_empty());
            Arc::new(NativeCore {
                item: Some(crate::boot::ItemBinding {
                    number: 0,
                    change: String::new(),
                }),
                moved: Mutex::new(None),
                native,
                git: git.clone(),
                events: Arc::new(Events::new(outbox, git, || Ok(1)).unwrap()),
                sessions: Arc::new(Disabled),
            })
        }
        let (dir, core, head) = conflict_fixture();
        let core = acknowledge_and_restart(core, dir.path());
        fs::write(
            dir.path().join("workspace/conflict"),
            b"resolved after ACK\n",
        )
        .unwrap();
        assert_eq!(wake_result(&call(core.clone(), 5, &[field(1, head)]))[0], 1);
        assert_eq!(reconciliations(dir.path()).len(), 1);
        let core = acknowledge_and_restart(core, dir.path());
        assert_eq!(wake_result(&call(core.clone(), 5, &[field(1, head)]))[0], 1);
        assert!(reconciliations(dir.path()).is_empty());
        assert_eq!(core.events.depth().unwrap(), 0);
        assert_eq!(
            fs::read(dir.path().join("workspace/conflict")).unwrap(),
            b"resolved after ACK\n"
        );
    }
    #[test]
    fn same_head_resolution_flushes_documents_before_selecting_clean_result() {
        let (dir, core, head) = conflict_fixture();
        let response = call_with_documents(
            core.clone(),
            5,
            &[field(1, head)],
            Arc::new(FlushWrite(dir.path().join("workspace/conflict"))),
        );
        assert_eq!(wake_result(&response)[0], 1);
        let record = core
            .native
            .wake_journal()
            .unwrap()
            .completed()
            .unwrap()
            .unwrap();
        assert_eq!(record.old, head);
        assert_eq!(record.head, head);
        assert_eq!(record.conflict, Some(false));
        assert!(core
            .native
            .conflict_paths(record.result)
            .unwrap()
            .is_empty());
        assert_eq!(
            fs::read(dir.path().join("workspace/conflict")).unwrap(),
            b"typing flushed during freeze\n"
        );
        assert_eq!(reconciliations(dir.path()).len(), 2);
    }
    #[test]
    fn same_head_resolution_restarts_after_document_thaw_or_journal_failure() {
        for phase in ["documents", "thaw", "journal"] {
            let (dir, core, head) = conflict_fixture();
            let state = dir.path().join("state");
            let root = dir.path().join("workspace");
            fs::write(root.join("conflict"), b"resolved\n").unwrap();
            let documents: Arc<dyn Documents> = if phase == "documents" {
                Arc::new(ReconcileFails)
            } else {
                Arc::new(Flushed)
            };
            let broker: Arc<dyn Broker> = if phase == "thaw" {
                Arc::new(ThawFails)
            } else {
                Arc::new(Flushed)
            };
            if phase == "journal" {
                std::os::unix::fs::symlink("untouched", state.join("wake.settlement.tmp")).unwrap();
            }
            let mut cx = LockCx::recovering(
                recovery_hooks(core.clone(), documents, broker),
                crate::rewrite_journal::Journal::open(&state).unwrap(),
            )
            .unwrap();
            let response = call_in(&mut cx, 5, &[field(1, head)]);
            assert_eq!(
                conn::fields("response", &response.payload[1..]).unwrap()[1].1[0],
                255,
                "{phase}"
            );
            let pending = core.native.wake_journal().unwrap().pending().unwrap();
            if phase == "journal" {
                assert!(pending.is_none());
                assert_eq!(reconciliations(dir.path()).len(), 1);
                fs::remove_file(state.join("wake.settlement.tmp")).unwrap();
            } else {
                assert!(cx.rewrite_pending);
                assert_eq!(pending.as_ref().unwrap().conflict, Some(false));
                assert_eq!(reconciliations(dir.path()).len(), 2);
            }
            drop(cx);
            let core = reopened_core(&core, dir.path());
            let mut cx = LockCx::recovering(
                recovery_hooks(core.clone(), Arc::new(Flushed), Arc::new(Flushed)),
                crate::rewrite_journal::Journal::open(&state).unwrap(),
            )
            .unwrap();
            assert_eq!(wake_result(&call_in(&mut cx, 5, &[field(1, head)]))[0], 1);
            assert!(!cx.rewrite_pending);
            assert_eq!(fs::read(root.join("conflict")).unwrap(), b"resolved\n");
            let events = reconciliations(dir.path());
            assert_eq!(events.len(), 2);
            if let Some(pending) = pending {
                assert_eq!(events[1].id, pending.event_id);
            }
            assert_eq!(core.git.acknowledged().unwrap(), Some(head));
            assert!(core
                .native
                .wake_journal()
                .unwrap()
                .pending()
                .unwrap()
                .is_none());
            assert_eq!(wake_result(&call_in(&mut cx, 5, &[field(1, head)]))[0], 1);
            assert_eq!(reconciliations(dir.path()).len(), 2);
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
                3,
                "{phase}: initial capture, reconciliation and its selected capture"
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
            assert_eq!(core.events.depth().unwrap(), 3);
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
        let log_path = dir.path().join("rebase.jsonl");
        core.events.observe_rebases([7; 16], fs::File::create(&log_path).unwrap()).unwrap();
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
        let rows: Vec<serde_json::Value> = fs::read_to_string(log_path).unwrap().lines()
            .map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["phase"], "held");
        assert_eq!(rows[1]["phase"], "thawed");
        assert_eq!(rows[0]["id"], rows[1]["id"]);
        assert_eq!(rows[0]["start"], rows[1]["start"]);
        assert_eq!(rows[0]["clock"], format!("guest monotonic:{}", "07".repeat(16)));
        assert_eq!(rows[0]["onto"], onto.iter().map(|byte| format!("{byte:02x}")).collect::<String>());
        assert_eq!(rows[1]["capture"]["boot"], "07".repeat(16));
        assert_eq!(rows[1]["localSnapshotQueued"], true);
        assert_eq!(rows[1]["acknowledgedBeforeThaw"], false);
        assert_eq!(rows[1]["failed"], false);
        assert!(rows[1]["end"].as_f64().unwrap() >= rows[0]["start"].as_f64().unwrap());
        assert_eq!(rows[1]["capture"]["sequence"].as_u64(), Some(core.events.next_sequence().unwrap() - 1));

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
        let rebase_response = rebase(&core, onto);
        let head = rebased_head(&rebase_response);
        let response = conn::fields("response", &rebase_response.payload[1..]).unwrap();
        let rewritten = conn::fields("result11", &response[1].1[1..]).unwrap();
        assert_eq!(rewritten[1].1, crate::reconcile::paths_payload(&["conflict".into()]).unwrap());
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
    fn rebase_rpc_inspection_binds_change_and_target_until_resolution() {
        let (dir, core) = fixture();
        let root = dir.path().join("workspace");
        fs::write(root.join("conflict"), b"original\n").unwrap();
        let base = core.native.snapshot().unwrap().0;
        crate::native::tests::child(&core.native, base, "item edit");
        fs::write(root.join("conflict"), b"item\n").unwrap();
        let item = core.native.snapshot().unwrap().0;
        crate::native::tests::child(&core.native, base, "main edit");
        fs::write(root.join("conflict"), b"main\n").unwrap();
        let onto = core.native.snapshot().unwrap().0;
        core.native.move_to(item).unwrap();
        core.git.clone().acknowledge_and_sync(item).unwrap();
        let head = rebased_head(&rebase(&core, onto));
        let inspected = call(core.clone(),18,&[field(1,head),field(2,onto)]);
        let response = conn::fields("response", &inspected.payload[1..]).unwrap();
        assert_eq!(response[1].1[0],18);
        let inspection = conn::fields("result18", &response[1].1[1..]).unwrap();
        assert_eq!(inspection.iter().find(|(tag,_)| *tag==1).unwrap().1,
            crate::reconcile::paths_payload(&["conflict".into()]).unwrap());
        let markers = fs::read(root.join("conflict")).unwrap();
        let stale = call(core.clone(),18,&[field(1,head),field(2,base)]);
        let response = conn::fields("response", &stale.payload[1..]).unwrap();
        assert_eq!(response[1].1[0],255);
        assert_eq!(core.native.current().unwrap().0,head);
        assert_eq!(fs::read(root.join("conflict")).unwrap(),markers);
        fs::write(root.join("conflict"),b"resolved item and main\n").unwrap();
        let inspected = call(core.clone(),18,&[field(1,head),field(2,onto)]);
        let response = conn::fields("response", &inspected.payload[1..]).unwrap();
        assert_eq!(response[1].1[0],18);
        let inspection = conn::fields("result18", &response[1].1[1..]).unwrap();
        assert_eq!(inspection.iter().find(|(tag,_)| *tag==1).unwrap().1,[0,0]);
        assert_eq!(fs::read(root.join("conflict")).unwrap(),b"resolved item and main\n");
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
