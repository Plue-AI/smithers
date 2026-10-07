//! Native jj working-copy operations for the unprivileged installed daemon.
//! The existing flows-jj snapshot/restore implementation owns those operations;
//! no CLI subprocess, repository config, or second repository is introduced.
use crate::hooks::Oid;
use jj_lib::{
    backend::CommitId,
    commit::Commit,
    config::{ConfigLayer, ConfigSource, StackedConfig},
    default_backend_factories::{default_backend_factories, default_working_copy_factories},
    merge::Merge,
    merged_tree::MergedTree,
    object_id::ObjectId,
    repo::{ReadonlyRepo, Repo},
    rewrite::rebase_commit,
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
        flows_jj::ops::snapshot(&self.root, None).map_err(invalid)?;
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
    /// Save the exact operation before a rewrite. Failure never truncates a
    /// previous checkpoint. fsync orders it before the shared rewrite fence.
    pub fn checkpoint(&self) -> io::Result<()> {
        let (_, repo) = self.load()?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.state.join("rewrite.operation"))?;
        file.write_all(repo.op_id().hex().as_bytes())?;
        file.sync_all()?;
        File::open(&self.state)?.sync_all()
    }
    pub fn restore(&self) -> io::Result<()> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(self.state.join("rewrite.operation"))?;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.mode() & 0o7777 != 0o600
            || metadata.len() != 128
        {
            return Err(invalid("invalid native rewrite checkpoint"));
        }
        let mut operation = String::new();
        (&mut file).take(129).read_to_string(&mut operation)?;
        if operation.len() != 128
            || !operation
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid("invalid native operation ID"));
        }
        flows_jj::ops::op_restore(&self.root, &operation).map_err(invalid)
    }
    /// Keep recovery retryable until document reconciliation and thaw succeed.
    pub fn settled(&self) -> io::Result<()> {
        match fs::remove_file(self.state.join("rewrite.operation")) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
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
        .map_err(invalid)?;
        let mut tx = repo.start_transaction();
        let rebased = tx
            .repo_mut()
            .rewrite_commit(&snapshot)
            .set_parents(head.parent_ids().to_vec())
            .set_tree(tree)
            .write()
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
            .commit("machined reconcile local delta")
            .block_on()
            .map_err(invalid)?;
        workspace
            .check_out(updated.op_id().clone(), Some(&snapshot.tree()), &rebased)
            .block_on()
            .map_err(invalid)?;
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
