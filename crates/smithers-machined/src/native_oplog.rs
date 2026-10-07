//! The same native operations used by `jj op abandon` and `jj util gc`.
use super::*;
use crate::{hooks, oplog};
use futures::TryStreamExt;
use std::time::{Duration, SystemTime};

fn hook(error: io::Error) -> hooks::Error {
    hooks::Error {
        code: 12,
        detail: Some(error.to_string()),
        ..hooks::Error::unsupported()
    }
}
struct Cleanup<'a> {
    repository: &'a Repository,
    now: SystemTime,
}
impl oplog::Repository for Cleanup<'_> {
    fn last_run(&mut self) -> hooks::Result<Option<SystemTime>> {
        let fd = match rustix::fs::open(
            self.repository.state.join("oplog.gc"),
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK,
            rustix::fs::Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(e) => return Err(hook(e.into())),
        };
        let mut file = File::from(fd);
        let meta = file.metadata().map_err(hook)?;
        if !meta.is_file()
            || meta.len() != 8
            || meta.uid() != rustix::process::geteuid().as_raw()
            || meta.nlink() != 1
            || meta.mode() & 0o7777 != 0o600
        {
            return Err(hook(io::ErrorKind::InvalidData.into()));
        }
        let mut bytes = [0; 8];
        file.read_exact(&mut bytes).map_err(hook)?;
        SystemTime::UNIX_EPOCH
            .checked_add(Duration::from_secs(u64::from_be_bytes(bytes)))
            .map(Some)
            .ok_or_else(|| hook(io::ErrorKind::InvalidData.into()))
    }
    fn size_bytes(&mut self) -> hooks::Result<u64> {
        fn size(path: &Path) -> io::Result<u64> {
            let meta = fs::symlink_metadata(path)?;
            if !meta.is_dir() {
                return Ok(meta.len());
            }
            let mut bytes = 0u64;
            for entry in fs::read_dir(path)? {
                bytes = bytes.saturating_add(size(&entry?.path())?);
                if bytes >= oplog::SIZE_LIMIT {
                    break;
                }
            }
            Ok(bytes)
        }
        size(&self.repository.root.join(".jj")).map_err(hook)
    }
    fn operations(&mut self) -> hooks::Result<Vec<oplog::Operation>> {
        let (_, repo) = self.repository.load().map_err(hook)?;
        let operations: Vec<_> =
            jj_lib::op_walk::walk_ancestors(std::slice::from_ref(repo.operation()))
                .try_collect()
                .block_on()
                .map_err(|e| hook(invalid(e)))?;
        operations
            .into_iter()
            .filter(|op| !op.parent_ids().is_empty())
            .map(|op| {
                let millis = op.metadata().time.end.timestamp.0;
                let ended = if millis >= 0 {
                    SystemTime::UNIX_EPOCH.checked_add(Duration::from_millis(millis as u64))
                } else {
                    SystemTime::UNIX_EPOCH.checked_sub(Duration::from_millis(millis.unsigned_abs()))
                }
                .ok_or_else(|| hook(io::ErrorKind::InvalidData.into()))?;
                Ok(oplog::Operation {
                    id: op.id().hex(),
                    ended,
                })
            })
            .collect()
    }
    fn abandon_ancestors(&mut self, id: &str) -> hooks::Result<()> {
        (|| -> io::Result<()> {
            let (mut workspace, repo) = self.repository.load()?;
            let mut locked = workspace
                .start_working_copy_mutation()
                .block_on()
                .map_err(invalid)?;
            if locked.locked_wc().old_operation_id() != repo.op_id() {
                return Err(invalid("working copy operation changed before cleanup"));
            }
            let heads = jj_lib::op_walk::get_current_head_ops(
                repo.op_store(),
                repo.op_heads_store().as_ref(),
            )
            .block_on()
            .map_err(invalid)?;
            if heads.len() != 1 || heads[0].id() != repo.op_id() {
                return Err(invalid("operation heads changed before cleanup"));
            }
            let old = jj_lib::op_walk::resolve_op_at(repo.op_store(), &heads, id)
                .block_on()
                .map_err(invalid)?;
            let root = repo.loader().root_operation().block_on();
            let stats =
                jj_lib::op_walk::reparent_range(repo.op_store().as_ref(), &[old], &heads, &root)
                    .block_on()
                    .map_err(invalid)?;
            let new = stats
                .new_head_ids
                .into_iter()
                .next()
                .ok_or_else(|| invalid("missing cleanup head"))?;
            repo.op_heads_store()
                .update_op_heads(std::slice::from_ref(repo.op_id()), &new)
                .block_on()
                .map_err(invalid)?;
            locked.finish(new).block_on().map_err(invalid)
        })()
        .map_err(hook)
    }
    fn gc(&mut self) -> hooks::Result<()> {
        (|| -> io::Result<()> {
            let (_, repo) = self.repository.load()?;
            let keep_newer = self
                .now
                .checked_sub(oplog::RETENTION)
                .ok_or_else(|| invalid("clock underflow"))?;
            repo.op_store()
                .gc(std::slice::from_ref(repo.op_id()), keep_newer)
                .block_on()
                .map_err(invalid)?;
            // Git's GC retains refs/smithers/pending/*, including captures and
            // versions that no longer occur in the retained operation history.
            repo.store().gc(repo.index(), keep_newer).map_err(invalid)
        })()
        .map_err(hook)
    }
    fn record_run(&mut self, now: SystemTime) -> hooks::Result<()> {
        (|| -> io::Result<()> {
            let mut random = [0; 16];
            getrandom::fill(&mut random).map_err(invalid)?;
            let temporary = self
                .repository
                .state
                .join(format!("oplog-{:x}.tmp", u128::from_be_bytes(random)));
            let result = (|| -> io::Result<()> {
                let mut f = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&temporary)?;
                f.write_all(
                    &now.duration_since(SystemTime::UNIX_EPOCH)
                        .map_err(invalid)?
                        .as_secs()
                        .to_be_bytes(),
                )?;
                f.sync_all()?;
                fs::rename(&temporary, self.repository.state.join("oplog.gc"))?;
                File::open(&self.repository.state)?.sync_all()
            })();
            let _ = fs::remove_file(temporary);
            result
        })()
        .map_err(hook)
    }
}
impl Repository {
    pub(crate) fn cleanup(&self, now: SystemTime) -> hooks::Result<bool> {
        oplog::run(
            &mut Cleanup {
                repository: self,
                now,
            },
            now,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oplog::Repository as _;
    #[test]
    fn native_retention_keeps_hundred_operations_and_workspace_and_pending_objects() {
        let (dir, repository) = super::super::tests::fixture();
        for n in 0..108 {
            fs::write(repository.root.join("file"), format!("version {n}")).unwrap();
            repository.snapshot().unwrap();
        }
        let before = repository.current().unwrap();
        let now = SystemTime::now() + Duration::from_secs(2 * 86400);
        let mut cleanup = Cleanup {
            repository: &repository,
            now,
        };
        assert!(cleanup.operations().unwrap().len() > 100);
        // A Git-only pin is deliberately absent from jj's current view.
        let (_, repo) = repository.load().unwrap();
        let git = jj_lib::git::get_git_repo(repo.store()).unwrap();
        let blob = git.write_blob(b"pending sentinel").unwrap().detach();
        git.reference(
            "refs/smithers/pending/sentinel",
            blob,
            gix::refs::transaction::PreviousValue::MustNotExist,
            "pin",
        )
        .unwrap();
        drop(git);
        drop(repo);
        assert!(repository.cleanup(now).unwrap());
        assert_eq!(cleanup.operations().unwrap().len(), 100);
        assert_eq!(repository.current().unwrap(), before);
        assert_eq!(
            fs::read(repository.root.join("file")).unwrap(),
            b"version 107"
        );
        assert!(!repository.cleanup(now).unwrap());
        let (_, repo) = repository.load().unwrap();
        let git = jj_lib::git::get_git_repo(repo.store()).unwrap();
        assert_eq!(git.find_object(blob).unwrap().data, b"pending sentinel");
        // Early size cleanup uses the same retention path and durable clock.
        let oversized = File::create(dir.path().join("workspace/.jj/size-fixture")).unwrap();
        oversized.set_len(oplog::SIZE_LIMIT).unwrap();
        assert!(repository.cleanup(now + Duration::from_secs(1)).unwrap());
        assert_eq!(cleanup.operations().unwrap().len(), 100);
        assert_eq!(repository.current().unwrap(), before);
    }
}
