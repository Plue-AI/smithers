//! Native jj working-copy operations for the unprivileged installed daemon.
//! The existing flows-jj snapshot/restore implementation owns those operations;
//! no CLI subprocess, repository config, or second repository is introduced.
use crate::hooks::Oid;
use jj_lib::{
    backend::CommitId,
    commit::Commit,
    commit_builder::DetachedCommitBuilder,
    config::{ConfigLayer, ConfigSource, StackedConfig},
    default_backend_factories::{default_backend_factories, default_working_copy_factories},
    merge::Merge,
    merged_tree::MergedTree,
    object_id::ObjectId,
    repo::{MutableRepo, ReadonlyRepo, Repo},
    rewrite::{rebase_commit, CommitRewriter},
    settings::UserSettings,
    workspace::Workspace,
};
use pollster::FutureExt;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};

fn invalid(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}
fn settings() -> io::Result<UserSettings> {
    let mut config = StackedConfig::with_defaults();
    config.add_layer(ConfigLayer::parse(ConfigSource::User,
        "user.name='Smithers'\nuser.email='smithers@localhost'\noperation.username='machined'\noperation.hostname='machine'\n")
        .map_err(invalid)?);
    UserSettings::from_config(config).map_err(invalid)
}
fn oid(bytes: &[u8]) -> io::Result<Oid> {
    bytes
        .try_into()
        .map_err(|_| invalid("requires Git SHA-1 backing store"))
}
// Restoring an operation retains already-written objects in the index. A
// replay can produce the exact same immutable commit (including its timestamp).
// Reuse it without recording it as a new predecessor or manufacturing metadata.
fn write_reconciled(
    repo: &mut MutableRepo,
    source: &Commit,
    builder: DetachedCommitBuilder,
) -> io::Result<Commit> {
    let candidate = builder.write_hidden().block_on().map_err(invalid)?;
    if repo.index().has_id(candidate.id()).map_err(invalid)? {
        if candidate.id() != source.id() {
            // A descendant cannot replace its own ancestor without a cycle.
            if repo
                .index()
                .is_ancestor(source.id(), candidate.id())
                .block_on()
                .map_err(invalid)?
            {
                return Err(invalid(
                    "recovered reconciliation would create an ancestry cycle",
                ));
            }
            repo.add_head(&candidate).block_on().map_err(invalid)?;
            repo.set_rewritten_commit(source.id().clone(), candidate.id().clone());
        }
        Ok(candidate)
    } else {
        builder.write(repo).block_on().map_err(invalid)
    }
}
// Descendant rewrites can also replay a previously indexed commit. Let jj
// compute their parents and merged trees, then use the same replay-safe writer.
fn reconcile_descendants(repo: &mut MutableRepo, source: &Commit) -> io::Result<()> {
    repo.transform_descendants(vec![source.id().clone()], async |mut rewriter| {
        if rewriter.parents_changed() {
            let old = rewriter.old_commit().clone();
            let parents = rewriter.new_parents().to_vec();
            let repo = rewriter.repo_mut();
            let builder = CommitRewriter::new(repo, old.clone(), parents)
                .rebase()
                .await?
                .detach();
            write_reconciled(repo, &old, builder)
                .map_err(|e| jj_lib::backend::BackendError::Other(e.into()))?;
        }
        Ok(())
    })
    .block_on()
    .map_err(invalid)?;
    // Finish the library's rewrite-reference bookkeeping.
    repo.rebase_descendants().block_on().map_err(invalid)?;
    Ok(())
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    version: u8,
    operation: String,
    #[serde(deserialize_with = "deserialize_acknowledgement")]
    acknowledged: Option<Oid>,
}
fn deserialize_acknowledgement<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Oid>, D::Error> {
    <Option<Oid> as serde::Deserialize>::deserialize(deserializer)
}
pub struct Repository {
    root: PathBuf,
    state: PathBuf,
}
impl Repository {
    /// Only the image's daemon identity can construct the installed adapter.
    /// Paths are fixed by the install, never selected by branch/RPC data.
    pub fn installed() -> io::Result<Self> {
        if !cfg!(target_os = "linux")
            || rustix::process::getuid().as_raw() != 19998
            || rustix::process::geteuid().as_raw() != 19998
        {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Self::open(
            Path::new("/workspace"),
            Path::new("/var/lib/smithers-machined"),
        )
    }
    fn open(root: &Path, state: &Path) -> io::Result<Self> {
        let metadata = fs::symlink_metadata(state)?;
        if !metadata.is_dir()
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.mode() & 0o7777 != 0o700
        {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let repository = Self {
            root: root.into(),
            state: state.into(),
        };
        repository.current()?;
        Ok(repository)
    }
    fn load(&self) -> io::Result<(Workspace, Arc<ReadonlyRepo>)> {
        let workspace = Workspace::load(
            &settings()?,
            &self.root,
            &default_backend_factories(),
            &default_working_copy_factories(),
        )
        .map_err(invalid)?;
        let repo = workspace
            .repo_loader()
            .load_at_head()
            .block_on()
            .map_err(invalid)?;
        Ok((workspace, repo))
    }
    fn commit(repo: &ReadonlyRepo, id: Oid) -> io::Result<Commit> {
        repo.store()
            .get_commit(&CommitId::new(id.to_vec()))
            .map_err(invalid)
    }
    pub fn current(&self) -> io::Result<(Oid, Oid)> {
        let (workspace, repo) = self.load()?;
        let id = repo
            .view()
            .get_wc_commit_id(workspace.workspace_name())
            .ok_or_else(|| invalid("workspace has no working-copy commit"))?;
        let commit = repo.store().get_commit(id).map_err(invalid)?;
        // Captures name the actual Git commit and its stored tree. A jj
        // conflict has several logical tree terms; choosing a term loses a
        // side, while refusing it prevents restart and durable capture during
        // conflict resolution. Keep jj's conflict encoding intact in transit.
        let git = jj_lib::git::get_git_repo(repo.store()).map_err(invalid)?;
        let raw = git
            .find_object(gix::ObjectId::from_bytes_or_panic(commit.id().as_bytes()))
            .map_err(invalid)?
            .try_into_commit()
            .map_err(invalid)?;
        let tree = raw.tree_id().map_err(invalid)?;
        Ok((oid(commit.id().as_bytes())?, oid(tree.as_bytes())?))
    }
    pub fn snapshot(&self) -> io::Result<(Oid, Oid)> {
        flows_jj::ops::snapshot(&self.root, None)
            .map_err(|e| invalid(format!("native snapshot: {e}")))?;
        self.current()
    }
    pub fn contains(&self, head: Oid) -> io::Result<bool> {
        let (_, repo) = self.load()?;
        match repo.store().get_commit(&CommitId::new(head.to_vec())) {
            Ok(_) => Ok(true),
            Err(jj_lib::backend::BackendError::ObjectNotFound { .. }) => Ok(false),
            Err(error) => Err(invalid(error)),
        }
    }
    pub fn tree(&self, head: Oid) -> io::Result<Oid> {
        let (_, repo) = self.load()?;
        let commit = Self::commit(&repo, head)?;
        let tree = commit.tree();
        oid(tree
            .tree_ids()
            .as_resolved()
            .ok_or_else(|| invalid("unresolved tree"))?
            .as_bytes())
    }
    /// Compare complete logical trees, including retained conflict terms.
    /// A wake must not choose one side or refuse to examine an existing conflict.
    pub fn same_tree(&self, left: Oid, right: Oid) -> io::Result<bool> {
        let (_, repo) = self.load()?;
        Ok(Self::commit(&repo, left)?.tree().tree_ids()
            == Self::commit(&repo, right)?.tree().tree_ids())
    }
    pub fn conflict_paths(&self, head: Oid) -> io::Result<Vec<String>> {
        let (_, repo) = self.load()?;
        Self::commit(&repo, head)?
            .tree()
            .conflicts()
            .map(|(path, value)| {
                value.map_err(invalid)?;
                Ok(path.as_internal_file_string().to_owned())
            })
            .collect()
    }
    /// Save the operation and the acknowledgement that made rollback safe.
    pub(crate) fn checkpoint_with_ack(&self, acknowledged: Option<Oid>) -> io::Result<()> {
        let (_, repo) = self.load()?;
        let record = Checkpoint {
            version: 1,
            operation: repo.op_id().hex(),
            acknowledged,
        };
        self.write_checkpoint(&serde_json::to_vec(&record).map_err(invalid)?)
    }
    #[cfg(test)]
    fn checkpoint(&self) -> io::Result<()> {
        let (_, repo) = self.load()?;
        self.write_checkpoint(repo.op_id().hex().as_bytes())
    }
    fn write_checkpoint(&self, bytes: &[u8]) -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.state.join("rewrite.operation"))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        File::open(&self.state)?.sync_all()
    }
    fn read_checkpoint(&self) -> io::Result<(String, Option<Option<Oid>>)> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(
                (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
            )
            .open(self.state.join("rewrite.operation"))?;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.mode() & 0o7777 != 0o600
            || metadata.len() > 1024
        {
            return Err(invalid("invalid native rewrite checkpoint"));
        }
        let mut bytes = String::new();
        file.take(1025).read_to_string(&mut bytes)?;
        if bytes.len() > 1024 {
            return Err(invalid("oversized native rewrite checkpoint"));
        }
        let (operation, acknowledged) =
            if bytes.len() == 128 && bytes.bytes().all(|b| b.is_ascii_hexdigit()) {
                (bytes, None) // Legacy history remains readable, but lacks rollback authority.
            } else {
                let record: Checkpoint = serde_json::from_str(&bytes).map_err(invalid)?;
                if record.version != 1 || record.acknowledged == Some([0; 20]) {
                    return Err(invalid("invalid native rewrite checkpoint version or head"));
                }
                (record.operation, Some(record.acknowledged))
            };
        if operation.len() != 128
            || !operation
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid("invalid native operation ID"));
        }
        Ok((operation, acknowledged))
    }
    pub fn restore(&self) -> io::Result<()> {
        let (operation, _) = self.read_checkpoint()?;
        self.restore_operation(&operation)
    }
    pub(crate) fn restore_with_ack(&self, acknowledged: Option<Oid>) -> io::Result<()> {
        let (operation, before) = self.read_checkpoint()?;
        if before != Some(acknowledged) {
            // Old daemons could publish an acknowledgement before settling the
            // rewrite. Never silently rewind files behind that published head.
            return Err(invalid(
                "rewrite checkpoint lacks matching acknowledgement; recovery retained",
            ));
        }
        self.restore_operation(&operation)
    }
    fn restore_operation(&self, operation: &str) -> io::Result<()> {
        flows_jj::ops::op_restore(&self.root, operation)
            .map_err(|e| invalid(format!("native restore: {e}")))
    }
    pub(crate) fn wake_journal(&self) -> io::Result<crate::wake_journal::Journal> {
        crate::wake_journal::Journal::open(&self.state)
    }
    /// Keep recovery retryable until document reconciliation and thaw succeed.
    pub fn settled(&self) -> io::Result<()> {
        match fs::remove_file(self.state.join("rewrite.operation")) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        self.wake_journal()?.clear()?;
        File::open(&self.state)?.sync_all()
    }
    pub fn move_to(&self, head: Oid) -> io::Result<Oid> {
        let (mut workspace, repo) = self.load()?;
        let target = Self::commit(&repo, head)?;
        let current_id = repo
            .view()
            .get_wc_commit_id(workspace.workspace_name())
            .ok_or_else(|| invalid("missing working-copy commit"))?;
        let current = repo.store().get_commit(current_id).map_err(invalid)?;
        let mut tx = repo.start_transaction();
        tx.repo_mut()
            .edit(workspace.workspace_name().to_owned(), &target)
            .block_on()
            .map_err(invalid)?;
        // edit may abandon an empty working-copy commit. Finish its descendant
        // bookkeeping before publishing, including heads imported from a host.
        tx.repo_mut()
            .rebase_descendants()
            .block_on()
            .map_err(invalid)?;
        let updated = tx
            .commit("machined reconcile working copy")
            .block_on()
            .map_err(invalid)?;
        workspace
            .check_out(updated.op_id().clone(), Some(&current.tree()), &target)
            .block_on()
            .map_err(invalid)?;
        Ok(head)
    }
    fn rebase_commits(
        workspace: &Workspace,
        repo: &ReadonlyRepo,
        onto: Oid,
    ) -> io::Result<(Commit, Commit)> {
        let current_id = repo
            .view()
            .get_wc_commit_id(workspace.workspace_name())
            .ok_or_else(|| invalid("missing working-copy commit"))?;
        let current = repo.store().get_commit(current_id).map_err(invalid)?;
        let onto = Self::commit(repo, onto)?;
        if current.tree().has_conflict() || onto.tree().has_conflict() {
            return Err(invalid("resolve existing conflicts before rebase"));
        }
        if repo
            .index()
            .is_ancestor(current.id(), onto.id())
            .block_on()
            .map_err(invalid)?
        {
            return Err(invalid(
                "cannot rebase an item onto itself or its descendant",
            ));
        }
        Ok((current, onto))
    }
    /// Validate before the RPC freezes writers. The mutation path checks again
    /// after capture, against the snapshot taken under the shared lock.
    pub fn validate_rebase(&self, onto: Oid) -> io::Result<()> {
        let (workspace, repo) = self.load()?;
        Self::rebase_commits(&workspace, &repo, onto).map(|_| ())
    }
    /// Rebase the item change, including already-captured work, onto its new
    /// prefix. An acknowledged capture is a transport checkpoint, not the
    /// item's old parent. Wake reconciliation alone applies that local delta.
    pub fn rebase(&self, onto: Oid) -> io::Result<Oid> {
        let (mut workspace, repo) = self.load()?;
        let (current, onto) = Self::rebase_commits(&workspace, &repo, onto)?;
        if current.parent_ids() == [onto.id().clone()] {
            return oid(current.id().as_bytes());
        }
        let mut tx = repo.start_transaction();
        let rebased = rebase_commit(tx.repo_mut(), current.clone(), vec![onto.id().clone()])
            .block_on()
            .map_err(invalid)?;
        tx.repo_mut()
            .set_wc_commit(workspace.workspace_name().to_owned(), rebased.id().clone())
            .map_err(invalid)?;
        tx.repo_mut()
            .rebase_descendants()
            .block_on()
            .map_err(invalid)?;
        let updated = tx
            .commit("machined rebase item")
            .block_on()
            .map_err(invalid)?;
        workspace
            .check_out(updated.op_id().clone(), Some(&current.tree()), &rebased)
            .block_on()
            .map_err(invalid)?;
        oid(rebased.id().as_bytes())
    }
    /// Apply precisely the delta from acknowledged tree to local snapshot on
    /// the new head. Native merge preserves conflicts instead of overwriting.
    pub fn rebase_delta(&self, snapshot: Oid, old: Oid, head: Oid) -> io::Result<Oid> {
        let (mut workspace, repo) = self.load()?;
        let snapshot = Self::commit(&repo, snapshot)?;
        let base = Self::commit(&repo, old)?;
        let head = Self::commit(&repo, head)?;
        let tree = MergedTree::merge(Merge::from_removes_adds(
            vec![(base.tree(), "acknowledged".into())],
            vec![
                (snapshot.tree(), "local".into()),
                (head.tree(), "host".into()),
            ],
        ))
        .block_on()
        .map_err(|e| invalid(format!("native delta: {e}")))?;
        let mut tx = repo.start_transaction();
        let builder = tx
            .repo_mut()
            .rewrite_commit(&snapshot)
            .set_parents(head.parent_ids().to_vec())
            .set_tree(tree)
            .detach();
        let rebased = write_reconciled(tx.repo_mut(), &snapshot, builder)?;
        tx.repo_mut()
            .set_wc_commit(workspace.workspace_name().to_owned(), rebased.id().clone())
            .map_err(|e| invalid(format!("native delta: {e}")))?;
        reconcile_descendants(tx.repo_mut(), &snapshot)?;
        let updated = tx
            .commit("machined reconcile local delta")
            .block_on()
            .map_err(|e| invalid(format!("native delta: {e}")))?;
        workspace
            .check_out(updated.op_id().clone(), Some(&snapshot.tree()), &rebased)
            .block_on()
            .map_err(|e| invalid(format!("native delta: {e}")))?;
        oid(rebased.id().as_bytes())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    pub(crate) fn fixture() -> (tempfile::TempDir, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        fs::create_dir(&root).unwrap();
        Workspace::init_colocated_git(&settings().unwrap(), &root, gix::hash::Kind::Sha1)
            .block_on()
            .unwrap();
        let state = dir.path().join("state");
        fs::create_dir(&state).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        let repo = Repository::open(&root, &state).unwrap();
        (dir, repo)
    }
    #[test]
    fn restored_reconciliation_reuses_the_identical_indexed_commit() {
        let (_dir, native) = fixture();
        fs::write(native.root.join("base"), b"base\n").unwrap();
        let base = native.snapshot().unwrap().0;
        child(&native, base, "local change");
        fs::write(native.root.join("local"), b"local\n").unwrap();
        let local = native.snapshot().unwrap().0;
        child(&native, base, "host change");
        fs::write(native.root.join("host"), b"host\n").unwrap();
        let host = native.snapshot().unwrap().0;
        native.move_to(local).unwrap();
        native.checkpoint().unwrap();
        let first = native.rebase_delta(local, base, host).unwrap();
        native.restore().unwrap();
        let (mut workspace, repo) = native.load().unwrap();
        let source = Repository::commit(&repo, local).unwrap();
        let expected = Repository::commit(&repo, first).unwrap();
        assert!(repo.index().has_id(expected.id()).unwrap());
        let mut tx = repo.start_transaction();
        let builder = tx
            .repo_mut()
            .rewrite_commit(&source)
            .set_parents(expected.parent_ids().to_vec())
            .set_tree(expected.tree())
            .set_author(expected.author().clone())
            .set_committer(expected.committer().clone())
            .detach();
        let result = write_reconciled(tx.repo_mut(), &source, builder).unwrap();
        assert_eq!(result.id(), expected.id());
        assert_eq!(result.change_id(), source.change_id());
        tx.repo_mut()
            .set_wc_commit(workspace.workspace_name().to_owned(), result.id().clone())
            .unwrap();
        tx.repo_mut().rebase_descendants().block_on().unwrap();
        let updated = tx
            .commit("recover identical reconciliation")
            .block_on()
            .unwrap();
        workspace
            .check_out(updated.op_id().clone(), Some(&source.tree()), &result)
            .block_on()
            .unwrap();
        assert_eq!(fs::read(native.root.join("local")).unwrap(), b"local\n");
        assert_eq!(fs::read(native.root.join("host")).unwrap(), b"host\n");
    }
    pub(crate) fn child(repo: &Repository, parent: Oid, description: &str) -> Oid {
        repo.move_to(parent).unwrap();
        let (mut workspace, current_repo) = repo.load().unwrap();
        let parent = Repository::commit(&current_repo, parent).unwrap();
        let mut tx = current_repo.start_transaction();
        let child = tx
            .repo_mut()
            .new_commit(vec![parent.id().clone()], parent.tree())
            .set_description(description)
            .write()
            .block_on()
            .unwrap();
        tx.repo_mut()
            .set_wc_commit(workspace.workspace_name().to_owned(), child.id().clone())
            .unwrap();
        let updated = tx.commit("test branch change").block_on().unwrap();
        workspace
            .check_out(updated.op_id().clone(), Some(&parent.tree()), &child)
            .block_on()
            .unwrap();
        oid(child.id().as_bytes()).unwrap()
    }
    pub(crate) fn assert_rebase(
        repo: &Repository,
        result: Oid,
        onto: Oid,
        prior: Oid,
        conflict: bool,
    ) {
        let (workspace, current_repo) = repo.load().unwrap();
        let result = Repository::commit(&current_repo, result).unwrap();
        assert_eq!(
            current_repo
                .view()
                .get_wc_commit_id(workspace.workspace_name()),
            Some(result.id())
        );
        let prior = Repository::commit(&current_repo, prior).unwrap();
        assert_eq!(result.parent_ids(), &[CommitId::new(onto.to_vec())]);
        assert_eq!(result.change_id(), prior.change_id());
        assert_eq!(result.description(), prior.description());
        assert_eq!(result.tree().has_conflict(), conflict);
    }
    #[test]
    fn conflicted_rebase_reopens_captures_and_resolves_without_losing_sides() {
        let (_dir, repo) = fixture();
        fs::write(repo.root.join("file"), b"original\n").unwrap();
        let base = repo.snapshot().unwrap().0;
        child(&repo, base, "item edit");
        fs::write(repo.root.join("file"), b"item version\n").unwrap();
        let item = repo.snapshot().unwrap().0;
        child(&repo, base, "main edit");
        fs::write(repo.root.join("file"), b"main version\n").unwrap();
        let onto = repo.snapshot().unwrap().0;
        repo.move_to(item).unwrap();
        let conflict = repo.rebase(onto).unwrap();
        assert_rebase(&repo, conflict, onto, item, true);
        let markers = fs::read(repo.root.join("file")).unwrap();
        let reopened = Repository::open(&repo.root, &repo.state).unwrap();
        assert_eq!(fs::read(repo.root.join("file")).unwrap(), markers);
        let (head, tree) = reopened.snapshot().unwrap();
        assert_eq!(head, conflict, "capture must retain the conflicted change");
        // The wire tree is the Git commit's actual tree, not one side of jj's
        // merge. The host verifies exactly this identity before acknowledging.
        let (_, current_repo) = reopened.load().unwrap();
        let git = jj_lib::git::get_git_repo(current_repo.store()).unwrap();
        let raw = git.find_commit(gix::ObjectId::from(conflict)).unwrap();
        assert_eq!(tree.as_slice(), raw.tree_id().unwrap().as_bytes());
        assert!(
            reopened.tree(conflict).is_err(),
            "unresolved trees stay unavailable to clean-tree comparisons"
        );
        assert!(reopened.validate_rebase(onto).is_err());
        assert_eq!(fs::read(repo.root.join("file")).unwrap(), markers);
        fs::write(repo.root.join("file"), b"item and main resolved\n").unwrap();
        let resolved = reopened.snapshot().unwrap().0;
        assert_rebase(&reopened, resolved, onto, item, false);
        assert_eq!(
            fs::read(repo.root.join("file")).unwrap(),
            b"item and main resolved\n"
        );
        assert!(reopened.contains(conflict).unwrap());
    }
    #[test]
    fn snapshot_and_native_recovery_preserve_working_copy_bytes() {
        let (_dir, repo) = fixture();
        fs::write(repo.root.join("file"), "before\n").unwrap();
        let before = repo.snapshot().unwrap();
        repo.checkpoint().unwrap();
        fs::write(repo.root.join("file"), "after\n").unwrap();
        let after = repo.snapshot().unwrap();
        assert_ne!(before, after);
        assert!(repo.contains(before.0).unwrap());
        repo.restore().unwrap();
        assert_eq!(fs::read(repo.root.join("file")).unwrap(), b"before\n");
        assert_eq!(repo.current().unwrap(), before);
        repo.settled().unwrap();
        repo.settled().unwrap();
    }
    #[test]
    fn checkpoint_refuses_replacement_and_corrupt_recovery() {
        let (_dir, repo) = fixture();
        repo.checkpoint().unwrap();
        assert_eq!(
            repo.checkpoint().unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        fs::write(repo.state.join("rewrite.operation"), b"bad").unwrap();
        assert!(repo.restore().is_err());
        assert!(repo.state.join("rewrite.operation").exists());
    }
    #[test]
    fn versioned_checkpoint_requires_exact_acknowledgement_and_retains_legacy_history() {
        for before in [None, Some([1; 20])] {
            let (_dir, repo) = fixture();
            fs::write(repo.root.join("file"), b"before\n").unwrap();
            repo.snapshot().unwrap();
            repo.checkpoint_with_ack(before).unwrap();
            let path = repo.state.join("rewrite.operation");
            let bytes = fs::read(&path).unwrap();
            fs::write(repo.root.join("file"), b"after\n").unwrap();
            repo.snapshot().unwrap();
            assert!(repo.restore_with_ack(Some([2; 20])).is_err());
            assert_eq!(fs::read(repo.root.join("file")).unwrap(), b"after\n");
            assert_eq!(fs::read(&path).unwrap(), bytes);
            for invalid in [
                "missing ack",
                "version",
                "operation",
                "zero ack",
                "extra field",
            ] {
                let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                match invalid {
                    "missing ack" => {
                        value.as_object_mut().unwrap().remove("acknowledged");
                    }
                    "version" => value["version"] = 2.into(),
                    "operation" => value["operation"] = "bad".into(),
                    "zero ack" => value["acknowledged"] = serde_json::to_value([0u8; 20]).unwrap(),
                    _ => value["extra"] = true.into(),
                }
                fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
                assert!(repo.restore_with_ack(before).is_err(), "{invalid}");
                assert_eq!(fs::read(repo.root.join("file")).unwrap(), b"after\n");
            }
            fs::write(&path, &bytes).unwrap();
            repo.restore_with_ack(before).unwrap();
            assert_eq!(fs::read(repo.root.join("file")).unwrap(), b"before\n");
            let (operation, _) = repo.read_checkpoint().unwrap();
            fs::write(&path, operation.as_bytes()).unwrap();
            assert!(repo.restore_with_ack(before).is_err());
            repo.restore().unwrap(); // Explicit native history restore still decodes old records.
        }
    }
    #[test]
    fn installed_adapter_refuses_other_identities() {
        if rustix::process::geteuid().as_raw() != 19998 || !cfg!(target_os = "linux") {
            assert_eq!(
                Repository::installed().err().unwrap().kind(),
                io::ErrorKind::PermissionDenied
            );
        }
    }
    #[test]
    fn reconciliation_preserves_local_delta_and_host_changes() {
        let (_dir, repo) = fixture();
        fs::write(repo.root.join("local"), "base\n").unwrap();
        let base = repo.snapshot().unwrap().0;
        fs::write(repo.root.join("local"), "edited\n").unwrap();
        let local = repo.snapshot().unwrap().0;
        fs::write(repo.root.join("local"), "base\n").unwrap();
        fs::write(repo.root.join("host"), "host change\n").unwrap();
        let host = repo.snapshot().unwrap().0;
        repo.move_to(local).unwrap();
        let result = repo.rebase_delta(local, base, host).unwrap();
        assert_eq!(repo.current().unwrap().0, result);
        assert_eq!(fs::read(repo.root.join("local")).unwrap(), b"edited\n");
        assert_eq!(fs::read(repo.root.join("host")).unwrap(), b"host change\n");
        assert!(repo.contains(host).unwrap());
        assert!(!repo.contains([255; 20]).unwrap());
    }
    #[test]
    fn symlinked_recovery_and_shared_state_are_refused() {
        let (_dir, repo) = fixture();
        let marker = repo.state.join("rewrite.operation");
        let sentinel = repo.state.join("sentinel");
        fs::write(&sentinel, "sentinel").unwrap();
        std::os::unix::fs::symlink(&sentinel, &marker).unwrap();
        assert!(repo.restore().is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"sentinel");
        fs::set_permissions(&repo.state, fs::Permissions::from_mode(0o770)).unwrap();
        assert_eq!(
            Repository::open(&repo.root, &repo.state)
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }
}
