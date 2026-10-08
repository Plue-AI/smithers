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
    object_id::{HexPrefix, ObjectId, PrefixResolution},
    op_store::OperationId,
    repo::{MutableRepo, ReadonlyRepo, Repo},
    rewrite::{rebase_commit, CommitRewriter},
    settings::UserSettings,
    workspace::Workspace,
    working_copy::WorkingCopyFreshness,
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
        self.import_colocated_head()?;
        flows_jj::ops::snapshot_with_tracking(&self.root, &crate::ignore::SnapshotFiles)
            .map_err(invalid)?;
        self.current()
    }
    /// Observe Git checkout movement without snapshotting unrelated dirty files.
    /// Metadata admission checks must not generate new jj operations themselves.
    pub fn import_colocated_head(&self) -> io::Result<()> {
        // Colocated Git commands update HEAD and files without advancing jj's
        // operation. Import that movement before snapshotting the working copy,
        // otherwise checkout would look like an edit of the item's change.
        let (mut workspace, repo) = self.load()?;
        let mut tx = repo.start_transaction();
        jj_lib::git::import_head(tx.repo_mut())
            .block_on()
            .map_err(invalid)?;
        if tx.repo().has_changes() {
            let head = tx.repo().view().git_head().as_normal().cloned();
            if let Some(head) = head {
                let commit = tx.repo().store().get_commit(&head).map_err(invalid)?;
                let wc = tx
                    .repo_mut()
                    .check_out(workspace.workspace_name().to_owned(), &commit)
                    .block_on()
                    .map_err(invalid)?;
                let mut locked = workspace
                    .start_working_copy_mutation()
                    .block_on()
                    .map_err(invalid)?;
                locked.locked_wc().reset(&wc).block_on().map_err(invalid)?;
                tx.repo_mut()
                    .rebase_descendants()
                    .block_on()
                    .map_err(invalid)?;
                let updated = tx
                    .commit("import colocated Git head")
                    .block_on()
                    .map_err(invalid)?;
                locked
                    .finish(updated.op_id().clone())
                    .block_on()
                    .map_err(invalid)?;
            } else {
                tx.repo_mut()
                    .rebase_descendants()
                    .block_on()
                    .map_err(invalid)?;
                tx.commit("import removed Git head")
                    .block_on()
                    .map_err(invalid)?;
            }
        }
        Ok(())
    }
    /// Resolve the host-bound item by change identity, including rewritten
    /// revisions. Tree equality and bookmark names confer no write authority.
    pub fn descends_from_item(&self, change: &str) -> io::Result<bool> {
        let (workspace, repo) = self.load()?;
        Self::descends_in(&workspace, &repo, change)
    }
    fn descends_in(
        workspace: &Workspace,
        repo: &Arc<ReadonlyRepo>,
        change: &str,
    ) -> io::Result<bool> {
        if change.len() != 32 || !change.bytes().all(|c| (b'k'..=b'z').contains(&c)) {
            return Err(invalid("invalid item change identity"));
        }
        let prefix = HexPrefix::try_from_reverse_hex(change)
            .ok_or_else(|| invalid("invalid item change identity"))?;
        let current = repo
            .view()
            .get_wc_commit_id(workspace.workspace_name())
            .ok_or_else(|| invalid("missing working-copy commit"))?;
        match repo.resolve_change_id_prefix(&prefix).map_err(invalid)? {
            PrefixResolution::NoMatch => Ok(false),
            PrefixResolution::AmbiguousMatch => Err(invalid("ambiguous item change identity")),
            PrefixResolution::SingleMatch(targets) => {
                for (_, id) in targets.visible_with_offsets() {
                    if repo
                        .index()
                        .is_ancestor(id, current)
                        .block_on()
                        .map_err(invalid)?
                    {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
        }
    }
    /// A last acknowledged capture may precede a rewrite or abandonment of
    /// the item's visible revision. Verify its immutable ancestry by change
    /// identity instead of trusting an arbitrary host head or today's visibility.
    pub fn captured_item_head(&self, head: Oid, change: &str) -> io::Result<bool> {
        let (_, repo) = self.load()?;
        let mut pending = vec![CommitId::new(head.to_vec())];
        let mut seen = std::collections::HashSet::new();
        while let Some(id) = pending.pop() {
            if !seen.insert(id.clone()) {
                continue;
            }
            if seen.len() > 128_000 {
                return Err(invalid("captured item ancestry too large"));
            }
            let commit = repo.store().get_commit(&id).map_err(invalid)?;
            if commit.change_id().reverse_hex() == change {
                return Ok(true);
            }
            pending.extend(commit.parent_ids().iter().cloned());
        }
        Ok(false)
    }
    /// Newest operation whose working copy still descends from the item's
    /// change. Repository operations remain in the unprivileged daemon.
    pub fn latest_on_item(&self, change: &str) -> io::Result<Oid> {
        use futures::TryStreamExt;
        let (workspace, repo) = self.load()?;
        let mut operations = Box::pin(jj_lib::op_walk::walk_ancestors(&[repo.operation().clone()]));
        for _ in 0..128_000 {
            let Some(operation) = operations.try_next().block_on().map_err(invalid)? else {
                return Err(invalid("pre-move history unavailable"));
            };
            if operation.id().as_bytes().iter().all(|b| *b == 0) {
                continue;
            }
            let historical = repo.reload_at(&operation).block_on().map_err(invalid)?;
            if Self::descends_in(&workspace, &historical, change)? {
                let head = historical
                    .view()
                    .get_wc_commit_id(workspace.workspace_name())
                    .ok_or_else(|| invalid("missing historical working-copy commit"))?;
                return oid(head.as_bytes());
            }
        }
        Err(invalid("pre-move history too large"))
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
    // Host-selected attribution belongs in the daemon's protected state, not
    // repository metadata that a member can edit. Persist it before thaw.
    pub(crate) fn record_return_actor(&self, target: Oid, actor: &[u8]) -> io::Result<()> {
        if actor.is_empty() || actor.len() > 1024 {
            return Err(invalid("invalid Return actor"));
        }
        let temporary = self.state.join("moved-return.actor.tmp");
        match fs::remove_file(&temporary) {
            Ok(()) => (),
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(b"MR01")?;
        file.write_all(&target)?;
        file.write_all(actor)?;
        file.sync_all()?;
        fs::rename(temporary, self.state.join("moved-return.actor"))?;
        File::open(&self.state)?.sync_all()
    }
    pub(crate) fn return_actor(&self, target: Oid) -> io::Result<Option<Vec<u8>>> {
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(
                (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
            )
            .open(self.state.join("moved-return.actor"))
        {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.mode() & 0o7777 != 0o600
            || !(25..=1048).contains(&metadata.len())
        {
            return Err(invalid("invalid Return attribution file"));
        }
        let mut bytes = Vec::new();
        file.take(1049).read_to_end(&mut bytes)?;
        if !(25..=1048).contains(&bytes.len()) || &bytes[..4] != b"MR01" || bytes[4..24] != target {
            return Err(invalid("Return attribution target differs"));
        }
        Ok(Some(bytes[24..].to_vec()))
    }
    pub(crate) fn clear_return_actor(&self) -> io::Result<()> {
        match fs::remove_file(self.state.join("moved-return.actor")) {
            Ok(()) => File::open(&self.state)?.sync_all(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
    /// Bind a resolution to the retained logical change and its target before
    /// inspecting disk. A checkout of another change is never a resolution.
    pub fn resolution_paths(&self, retained: Oid, onto: Oid) -> io::Result<Vec<String>> {
        let (workspace, repo) = self.load()?;
        let expected = Self::commit(&repo, retained)?;
        let current = repo.view().get_wc_commit_id(workspace.workspace_name())
            .ok_or_else(|| invalid("missing working-copy commit"))?;
        let current = repo.store().get_commit(current).map_err(invalid)?;
        let target = CommitId::new(onto.to_vec());
        if expected.change_id() != current.change_id()
            || expected.parent_ids() != [target.clone()]
            || current.parent_ids() != [target]
            || !expected.has_conflict() {
            return Err(invalid("retained conflict target changed"));
        }
        let (head, _) = self.snapshot()?;
        self.conflict_paths(head)
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
        // A killed rewrite can commit the repository operation before checkout.
        // Complete that interrupted checkout under the recovery barrier before
        // the existing restore snapshots it. This is only the daemon's private,
        // validated checkpoint path; ordinary stale snapshots still refuse.
        let (mut workspace, repo) = self.load()?;
        // Resolve the bounded checkpoint before changing the working copy.
        let checkpoint_id = OperationId::try_from_hex(operation)
            .ok_or_else(|| invalid("invalid recovery operation ID"))?;
        repo.loader().load_operation(&checkpoint_id).block_on().map_err(invalid)?;
        let current_id = repo.view().get_wc_commit_id(workspace.workspace_name())
            .ok_or_else(|| invalid("missing recovery working-copy commit"))?;
        let current = repo.store().get_commit(current_id).map_err(invalid)?;
        let old_tree = {
            let mut locked = workspace.start_working_copy_mutation().block_on().map_err(invalid)?;
            match WorkingCopyFreshness::check_stale(locked.locked_wc(), &current, &repo)
                .block_on().map_err(invalid)? {
                WorkingCopyFreshness::WorkingCopyStale => Some(locked.locked_wc().old_tree().clone()),
                WorkingCopyFreshness::SiblingOperation => return Err(invalid("recovery has a sibling working-copy operation")),
                _ => None,
            }
        };
        if let Some(old_tree) = old_tree {
            workspace.check_out(repo.op_id().clone(), Some(&old_tree), &current)
                .block_on().map_err(invalid)?;
        }
        flows_jj::ops::op_restore(&self.root, operation)
            .map_err(|e| invalid(format!("native restore: {e}")))?;
        let (workspace, repo) = self.load()?;
        let current_id = repo
            .view()
            .get_wc_commit_id(workspace.workspace_name())
            .ok_or_else(|| invalid("missing restored working-copy commit"))?;
        let current = repo.store().get_commit(current_id).map_err(invalid)?;
        let mut tx = repo.start_transaction();
        jj_lib::git::reset_head(tx.repo_mut(), &current)
            .block_on()
            .map_err(invalid)?;
        tx.commit("machined restore Git HEAD")
            .block_on()
            .map_err(invalid)?;
        Ok(())
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
        if current.id() == target.id() {
            return Ok(head);
        }
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
        jj_lib::git::reset_head(tx.repo_mut(), &target)
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
    // Object transport retains raw Git objects without publishing bookmarks.
    // jj's ancestry index must include that admitted target before any lookup;
    // reading it from the store alone does not add it to the index.
    fn load_rebase_target(&self, onto: Oid) -> io::Result<(Workspace, Arc<ReadonlyRepo>)> {
        let (workspace, repo) = self.load()?;
        let target = Self::commit(&repo, onto)?;
        if repo.index().has_id(target.id()).map_err(invalid)? {
            return Ok((workspace, repo));
        }
        let mut tx = repo.start_transaction();
        tx.repo_mut()
            .add_head(&target)
            .block_on()
            .map_err(invalid)?;
        let indexed = tx
            .commit("import admitted rebase target")
            .block_on()
            .map_err(invalid)?;
        Ok((workspace, indexed))
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
    pub fn validate_rebase(&self, onto: Oid, base: Option<Oid>) -> io::Result<()> {
        let (workspace, repo) = self.load_rebase_target(onto)?;
        Self::rebase_commits(&workspace, &repo, onto)?;
        if let Some(base) = base {
            repo.store().get_commit(&CommitId::from_bytes(&base)).map_err(invalid)?;
        }
        Ok(())
    }
    /// Rebase the item change, including already-captured work, onto its new
    /// prefix. An acknowledged capture is a transport checkpoint, not the
    /// item's old parent. Wake reconciliation alone applies that local delta.
    pub fn rebase(&self, onto: Oid) -> io::Result<Oid> {
        self.rebase_bound(onto, None, None)
    }
    /// Rebase the owning item, including captured working-copy descendants.
    /// A descendant alone does not contain the item's full delta and dropping
    /// its ancestor would revoke the machine's bound change authority.
    pub fn rebase_bound(&self, onto: Oid, item: Option<&str>, source_base: Option<Oid>) -> io::Result<Oid> {
        let (mut workspace, repo) = self.load_rebase_target(onto)?;
        let (current, onto) = Self::rebase_commits(&workspace, &repo, onto)?;
        if source_base.is_some() && item.is_none() {
            return Err(invalid("verified base requires an owning item"));
        }
        let source_base = source_base.map(|id| repo.store().get_commit(&CommitId::from_bytes(&id)).map_err(invalid)).transpose()?;
        let bound = if let Some(change) = item {
            if change.len() != 32 || !change.bytes().all(|c| (b'k'..=b'z').contains(&c)) {
                return Err(invalid("invalid item change identity"));
            }
            let prefix = HexPrefix::try_from_reverse_hex(change)
                .ok_or_else(|| invalid("invalid item change identity"))?;
            let PrefixResolution::SingleMatch(targets) = repo.resolve_change_id_prefix(&prefix).map_err(invalid)? else {
                return Err(invalid("owning item unavailable"));
            };
            let mut selected = None;
            for (_, id) in targets.visible_with_offsets() {
                if repo.index().is_ancestor(id, current.id()).block_on().map_err(invalid)? {
                    if selected.is_some() { return Err(invalid("ambiguous owning item ancestry")); }
                    selected = Some(repo.store().get_commit(id).map_err(invalid)?);
                }
            }
            Some(selected.ok_or_else(|| invalid("working copy moved off the owning item"))?)
        } else { None };
        if current.parent_ids() == [onto.id().clone()] && bound.as_ref().is_none_or(|bound| bound.id() == current.id()) {
            return oid(current.id().as_bytes());
        }
        let mut tx = repo.start_transaction();
        let rebased = if let Some(bound) = bound.as_ref().filter(|bound| bound.id() != current.id() || source_base.is_some()) {
            if bound.parent_ids().len() != 1 { return Err(invalid("owning item has no linear base")); }
            // Bring-in may parent this native change on a published branch that
            // already contains its bytes. Use the stack-fenced verified base
            // for its whole delta, rather than only the last native edit.
            // A completed rewrite already on this target keeps its new base.
            let base_id = if bound.parent_ids() == [onto.id().clone()] {
                onto.id().clone()
            } else {
                source_base.as_ref().map(|base| base.id().clone()).unwrap_or_else(|| bound.parent_ids()[0].clone())
            };
            let base = repo.store().get_commit(&base_id).map_err(invalid)?;
            let tree = MergedTree::merge(Merge::from_removes_adds(
                vec![(base.tree(), "before rebase".into())],
                vec![(current.tree(), "branch".into()), (onto.tree(), "main".into())],
            )).block_on().map_err(invalid)?;
            let builder = tx.repo_mut().rewrite_commit(bound)
                .set_parents(vec![onto.id().clone()])
                .set_description(current.description())
                .set_author(current.author().clone())
                .set_tree(tree)
                .detach();
            write_reconciled(tx.repo_mut(), bound, builder)?
        } else {
            rebase_commit(tx.repo_mut(), current.clone(), vec![onto.id().clone()])
                .block_on().map_err(invalid)?
        };
        tx.repo_mut()
            .set_wc_commit(workspace.workspace_name().to_owned(), rebased.id().clone())
            .map_err(invalid)?;
        tx.repo_mut()
            .rebase_descendants()
            .block_on()
            .map_err(invalid)?;
        jj_lib::git::reset_head(tx.repo_mut(), &rebased)
            .block_on()
            .map_err(invalid)?;
        let updated = tx
            .commit("machined rebase item")
            .block_on()
            .map_err(invalid)?;
        // The repository operation is durable, but the working copy has not
        // been checked out. Recovery must restore the captured checkpoint.
        #[cfg(all(feature = "killpoints", debug_assertions))]
        crate::events::killpoint("rebase-mid");
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
        jj_lib::git::reset_head(tx.repo_mut(), &rebased)
            .block_on()
            .map_err(invalid)?;
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
    pub(crate) fn change(native: &Repository, head: Oid) -> String {
        let (_, repo) = native.load().unwrap();
        Repository::commit(&repo, head)
            .unwrap()
            .change_id()
            .reverse_hex()
    }
    #[test]
    fn item_identity_requires_a_visible_ancestor_even_for_identical_trees() {
        let (_dir, native) = fixture();
        let base = native.current().unwrap().0;
        let item = child(&native, base, "item");
        let (_, repo) = native.load().unwrap();
        let change = Repository::commit(&repo, item)
            .unwrap()
            .change_id()
            .reverse_hex();
        assert!(native.descends_from_item(&change).unwrap());
        child(&native, item, "on top of the item");
        assert!(native.descends_from_item(&change).unwrap());
        child(&native, base, "off the item with identical bytes");
        assert!(!native.descends_from_item(&change).unwrap());
        assert!(native.descends_from_item("main").is_err());
        assert!(!native
            .descends_from_item("kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk")
            .unwrap());
    }
    #[test]
    fn return_attribution_survives_reopen_and_refuses_untrusted_artifacts() {
        let (_dir, native) = fixture();
        let target = native.current().unwrap().0;
        let actor = [0xff; 16];
        assert_eq!(native.return_actor(target).unwrap(), None);
        assert!(native.record_return_actor(target, &[]).is_err());
        assert!(native.record_return_actor(target, &[1; 1025]).is_err());
        native.record_return_actor(target, &actor).unwrap();
        let reopened = Repository::open(&native.root, &native.state).unwrap();
        assert_eq!(reopened.return_actor(target).unwrap(), Some(actor.to_vec()));
        assert!(reopened.return_actor([0; 20]).is_err());
        let path = native.state.join("moved-return.actor");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(reopened.return_actor(target).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let linked = native.state.join("actor-link");
        fs::hard_link(&path, &linked).unwrap();
        assert!(reopened.return_actor(target).is_err());
        fs::remove_file(linked).unwrap();
        fs::write(&path, [0; 1049]).unwrap();
        assert!(reopened.return_actor(target).is_err());
        fs::remove_file(&path).unwrap();
        let sentinel = native.state.join("outside");
        fs::write(&sentinel, b"untouched").unwrap();
        std::os::unix::fs::symlink(&sentinel, &path).unwrap();
        assert!(reopened.return_actor(target).is_err());
        reopened.clear_return_actor().unwrap();
        reopened.clear_return_actor().unwrap();
        assert_eq!(fs::read(sentinel).unwrap(), b"untouched");
        assert_eq!(reopened.return_actor(target).unwrap(), None);
    }
    #[test]
    fn rebase_indexes_a_target_received_as_raw_git_objects() {
        let (_dir, native) = fixture();
        let (base, tree) = native.current().unwrap();
        let item = child(&native, base, "item work");
        let hex = |id: Oid| id.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let output = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&native.root)
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "commit-tree",
                &hex(tree),
                "-p",
                &hex(base),
                "-m",
                "imported main",
            ])
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.test")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let target = {
            let text = String::from_utf8(output.stdout).unwrap();
            let mut id = [0; 20];
            for (n, byte) in id.iter_mut().enumerate() {
                *byte = u8::from_str_radix(&text[n * 2..n * 2 + 2], 16).unwrap();
            }
            id
        };
        let (_, repo) = native.load().unwrap();
        assert!(!repo
            .index()
            .has_id(Repository::commit(&repo, target).unwrap().id())
            .unwrap());
        native.validate_rebase(target, None).unwrap();
        assert_eq!(native.current().unwrap().0, item);
        let head = native.rebase(target).unwrap();
        let (_, repo) = native.load().unwrap();
        let commit = Repository::commit(&repo, head).unwrap();
        assert_eq!(
            commit.parent_ids(),
            &[jj_lib::backend::CommitId::new(target.to_vec())]
        );
        assert_eq!(native.rebase(target).unwrap(), head);
    }
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
    fn snapshots_exclude_retained_save_inodes_without_losing_ordinary_files() {
        let (_dir, repo) = fixture();
        fs::create_dir(repo.root.join("nested")).unwrap();
        fs::write(repo.root.join(".gitignore"), "!.smithers-doc-*\n").unwrap();
        fs::write(
            repo.root.join("nested/.smithers-doc-user-note"),
            "ordinary user bytes",
        )
        .unwrap();
        let before = repo.snapshot().unwrap();
        let name = format!(".smithers-doc-{}-{}", "a".repeat(64), "b".repeat(32));
        for parent in [repo.root.clone(), repo.root.join("nested")] {
            fs::write(parent.join(&name), "displaced bytes still held by a writer").unwrap();
        }
        assert_eq!(before, repo.snapshot().unwrap());
        for parent in [repo.root.clone(), repo.root.join("nested")] {
            assert_eq!(
                fs::read(parent.join(&name)).unwrap(),
                b"displaced bytes still held by a writer"
            );
            fs::remove_file(parent.join(&name)).unwrap();
        }
        assert_eq!(before, repo.snapshot().unwrap());
        fs::write(
            repo.root.join("nested/.smithers-doc-user-note"),
            "updated user bytes",
        )
        .unwrap();
        assert_ne!(before.1, repo.snapshot().unwrap().1);
    }

    #[cfg(all(feature = "killpoints", debug_assertions))]
    fn crash_core(root: &Path) -> std::sync::Arc<crate::native_core::NativeCore> {
        use std::sync::{Arc, Mutex};
        let owner = rustix::process::geteuid().as_raw();
        let git = crate::git::Repository::checked(
            Path::new("/usr/bin/git"),
            &root.join("workspace"),
            &root.join("state/spool"),
        )
        .unwrap();
        let outbox = crate::outbox::Outbox::open(
            crate::outbox_store::Store::open(&root.join("state/outbox"), owner).unwrap(),
            owner,
            git.clone(),
        )
        .unwrap();
        Arc::new(crate::native_core::NativeCore {
            item: Some(crate::boot::ItemBinding {
                number: 0,
                change: String::new(),
            }),
            moved: Mutex::new(None),
            native: Arc::new(
                Repository::open(&root.join("workspace"), &root.join("state")).unwrap(),
            ),
            git: git.clone(),
            events: Arc::new(crate::event_service::Events::new(outbox, git, || Ok(1)).unwrap()),
            sessions: Arc::new(crate::hooks::Disabled),
        })
    }
    #[cfg(all(feature = "killpoints", debug_assertions))]
    #[test]
    fn snapshot_crash_child() {
        let Some(root) = std::env::var_os("MACHINED_SNAPSHOT_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        fs::write(
            root.join("workspace/file"),
            b"durable interrupted snapshot\n",
        )
        .unwrap();
        crate::native_core::tests::framed_capture(crash_core(&root));
        panic!("K5a did not terminate the process");
    }
    #[cfg(all(feature = "killpoints", debug_assertions))]
    #[test]
    fn k5a_dispatched_native_snapshot_crash_preserves_ack_and_recaptures_ten_times() {
        use crate::outbox::Refs;
        for _ in 0..10 {
            let (dir, core) = crate::native_core::tests::fixture();
            let old = core.native.current().unwrap().0;
            core.git.clone().acknowledge_and_sync(old).unwrap();
            drop(core);
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "native::tests::snapshot_crash_child",
                    "--nocapture",
                ])
                .env("MACHINED_SNAPSHOT_ROOT", dir.path())
                .env("SMITHERS_MACHINED_KILL_AT", "K5a")
                .stdout(std::process::Stdio::null())
                .status()
                .unwrap();
            assert_eq!(status.code(), Some(73));
            let core = crash_core(dir.path());
            let head = core.native.current().unwrap().0;
            assert_ne!(head, old);
            let object = std::process::Command::new("/usr/bin/git")
                .args([
                    "-C",
                    dir.path().join("workspace").to_str().unwrap(),
                    "show",
                    &format!(
                        "{}:file",
                        head.iter().map(|b| format!("{b:02x}")).collect::<String>()
                    ),
                ])
                .output()
                .unwrap();
            assert!(object.status.success());
            assert_eq!(object.stdout, b"durable interrupted snapshot\n");
            assert_eq!(core.git.acknowledged().unwrap(), Some(old));
            assert_eq!(core.events.depth().unwrap(), 0);
            assert!(core.git.clone().pending().unwrap().is_empty());
            assert_eq!(
                fs::read(dir.path().join("workspace/file")).unwrap(),
                b"durable interrupted snapshot\n"
            );
            let response = crate::native_core::tests::framed_capture(core.clone());
            let fields = crate::conn::fields("response", &response.payload[1..]).unwrap();
            assert_eq!(fields[1].1[0], 4);
            let result = crate::conn::fields("result4", &fields[1].1[1..]).unwrap();
            assert_eq!(result[0].1, head);
            assert_eq!(core.native.current().unwrap().0, head);
            assert_eq!(core.events.depth().unwrap(), 1);
            assert!(core.events.queued(head).unwrap());
            assert_eq!(core.git.acknowledged().unwrap(), Some(old));
            assert_eq!(core.git.clone().pending().unwrap().len(), 1);
        }
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
    #[test]
    fn bound_rebase_keeps_the_whole_item_and_its_host_identity() {
        let (dir, native) = fixture();
        let root = dir.path().join("workspace");
        fs::write(root.join("base"), b"base\n").unwrap();
        let base = native.snapshot().unwrap().0;
        child(&native, base, "host-bound item");
        fs::write(root.join("first"), b"first edit\n").unwrap();
        let first = native.snapshot().unwrap().0;
        let (_, repo) = native.load().unwrap();
        let change = Repository::commit(&repo, first)
            .unwrap()
            .change_id()
            .reverse_hex();
        child(&native, first, "second item change");
        fs::write(root.join("second"), b"second edit\n").unwrap();
        let current = native.snapshot().unwrap().0;
        child(&native, base, "main moves");
        fs::write(root.join("upstream"), b"main edit\n").unwrap();
        let onto = native.snapshot().unwrap().0;
        native.move_to(current).unwrap();
        let result = native.rebase_bound(onto, Some(&change), None).unwrap();
        let (_, repo) = native.load().unwrap();
        let commit = Repository::commit(&repo, result).unwrap();
        assert_eq!(commit.parent_ids(), &[CommitId::new(onto.to_vec())]);
        assert_eq!(commit.change_id().reverse_hex(), change);
        assert_eq!(commit.description(), "second item change");
        assert!(!commit.tree().has_conflict());
        assert!(native.descends_from_item(&change).unwrap());
        for (name, bytes) in [
            ("first", b"first edit\n".as_slice()),
            ("second", b"second edit\n".as_slice()),
            ("upstream", b"main edit\n".as_slice()),
        ] {
            assert_eq!(fs::read(root.join(name)).unwrap(), bytes);
        }
        assert_eq!(native.rebase_bound(onto, Some(&change), None).unwrap(), result);
    }
    #[test]
    fn bound_rebase_retains_conflicts_and_refuses_another_item() {
        let (dir, native) = fixture();
        let root = dir.path().join("workspace");
        fs::write(root.join("shared"), b"base\n").unwrap();
        let base = native.snapshot().unwrap().0;
        child(&native, base, "host-bound item");
        fs::write(root.join("shared"), b"item\n").unwrap();
        let first = native.snapshot().unwrap().0;
        let (_, repo) = native.load().unwrap();
        let change = Repository::commit(&repo, first).unwrap().change_id().reverse_hex();
        child(&native, first, "second item change");
        fs::write(root.join("second"), b"retained\n").unwrap();
        let current = native.snapshot().unwrap().0;
        child(&native, base, "main moves");
        fs::write(root.join("shared"), b"main\n").unwrap();
        let onto = native.snapshot().unwrap().0;
        let (_, repo) = native.load().unwrap();
        let another = Repository::commit(&repo, onto).unwrap().change_id().reverse_hex();
        native.move_to(current).unwrap();
        assert!(native.rebase_bound(onto, Some(&another), None).is_err());
        assert_eq!(native.current().unwrap().0, current);
        assert_eq!(fs::read(root.join("shared")).unwrap(), b"item\n");
        let result = native.rebase_bound(onto, Some(&change), None).unwrap();
        assert!(Repository::commit(&native.load().unwrap().1, result).unwrap().tree().has_conflict());
        assert!(native.descends_from_item(&change).unwrap());
        assert_eq!(fs::read(root.join("second")).unwrap(), b"retained\n");
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
        jj_lib::git::reset_head(tx.repo_mut(), &child)
            .block_on()
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
    fn rebase_checkpoint_restores_after_repository_commit_before_checkout() {
        let (_dir, native) = fixture();
        fs::write(native.root.join("file"), b"base\n").unwrap();
        let base = native.snapshot().unwrap().0;
        child(&native, base, "new main");
        fs::write(native.root.join("main"), b"new main bytes\n").unwrap();
        let onto = native.snapshot().unwrap().0;
        child(&native, base, "owning item");
        fs::write(native.root.join("file"), b"item bytes\n").unwrap();
        let captured = native.snapshot().unwrap();
        native.checkpoint_with_ack(None).unwrap();
        let (workspace, repo) = native.load().unwrap();
        let current = Repository::commit(&repo, captured.0).unwrap();
        let mut tx = repo.start_transaction();
        let rebased = rebase_commit(tx.repo_mut(), current, vec![CommitId::new(onto.to_vec())])
            .block_on().unwrap();
        tx.repo_mut().set_wc_commit(workspace.workspace_name().to_owned(), rebased.id().clone()).unwrap();
        tx.repo_mut().rebase_descendants().block_on().unwrap();
        tx.commit("interrupted rebase before checkout").block_on().unwrap();
        // Ordinary snapshots still refuse stale state; only the authenticated
        // checkpoint recovery may finish the checkout and restore its tree.
        assert!(native.snapshot().is_err());
        native.restore_with_ack(None).unwrap();
        assert_eq!(native.snapshot().unwrap().1, captured.1);
        assert_eq!(fs::read(native.root.join("file")).unwrap(), b"item bytes\n");
        assert!(!native.root.join("main").exists());
        native.restore_with_ack(None).unwrap();
        assert_eq!(native.snapshot().unwrap().1, captured.1);
    }

    #[test]
    fn rebase_bound_item_retains_descendant_bytes_and_change_authority() {
        for conflict in [false, true] {
            let (_dir, repo) = fixture();
            fs::write(repo.root.join("file"), b"base\n").unwrap();
            let base = repo.snapshot().unwrap().0;
            child(&repo, base, "owning item");
            fs::write(repo.root.join("file"), b"item\n").unwrap();
            let item = repo.snapshot().unwrap().0;
            let change = change(&repo, item);
            child(&repo, item, "working-copy descendant");
            fs::write(repo.root.join("later"), b"captured descendant bytes\n").unwrap();
            let descendant = repo.snapshot().unwrap().0;
            child(&repo, base, "new main");
            fs::write(repo.root.join("main"), b"new main bytes\n").unwrap();
            if conflict { fs::write(repo.root.join("file"), b"main\n").unwrap(); }
            let onto = repo.snapshot().unwrap().0;
            repo.move_to(descendant).unwrap();
            let result = repo.rebase_bound(onto, Some(&change), None).unwrap();
            let (_, loaded) = repo.load().unwrap();
            let result_commit = Repository::commit(&loaded, result).unwrap();
            assert_eq!(result_commit.parent_ids(), &[CommitId::new(onto.to_vec())]);
            assert_eq!(result_commit.change_id().reverse_hex(), change);
            assert_eq!(result_commit.description(), "working-copy descendant");
            assert_eq!(result_commit.tree().has_conflict(), conflict);
            assert!(repo.descends_from_item(&change).unwrap());
            assert_eq!(fs::read(repo.root.join("later")).unwrap(), b"captured descendant bytes\n");
            assert_eq!(fs::read(repo.root.join("main")).unwrap(), b"new main bytes\n");
            let bytes = fs::read(repo.root.join("file")).unwrap();
            if conflict {
                assert!(String::from_utf8_lossy(&bytes).contains("item"));
                assert!(String::from_utf8_lossy(&bytes).contains("main"));
            } else { assert_eq!(bytes, b"item\n"); }
            let reopened = Repository::open(&repo.root, &repo.state).unwrap();
            assert!(reopened.descends_from_item(&change).unwrap());
            assert_eq!(reopened.current().unwrap().0, result);
        }
    }
    #[test]
    fn rebase_verified_base_retains_brought_in_item_delta() {
        for (verified, conflict) in [(false, false), (true, false), (true, true)] {
            let (_dir, repo) = fixture();
            fs::write(repo.root.join("base"), b"base\n").unwrap();
            let base = repo.snapshot().unwrap().0;
            child(&repo, base, "owning item");
            fs::write(repo.root.join("retry"), b"first retry\n").unwrap();
            let item = repo.snapshot().unwrap().0;
            let change = change(&repo, item);
            child(&repo, base, "Alice's published branch");
            fs::write(repo.root.join("retry"), b"first retry\n").unwrap();
            fs::write(repo.root.join("alice"), b"person bytes\n").unwrap();
            let foreign = repo.snapshot().unwrap().0;
            repo.move_to(item).unwrap();
            repo.rebase_bound(foreign, Some(&change), Some(base)).unwrap();
            fs::write(repo.root.join("retry"), b"log each retry\n").unwrap();
            let steered = repo.snapshot().unwrap().0;
            child(&repo, base, "unrelated main move");
            fs::write(repo.root.join("main"), b"main bytes\n").unwrap();
            if conflict { fs::write(repo.root.join("retry"), b"main retry\n").unwrap(); }
            let onto = repo.snapshot().unwrap().0;
            repo.move_to(steered).unwrap();
            assert!(repo.validate_rebase(onto, Some([0xff; 20])).is_err());
            assert_eq!(repo.current().unwrap().0, steered);
            let result = repo.rebase_bound(onto, Some(&change), verified.then_some(base)).unwrap();
            let (_, loaded) = repo.load().unwrap();
            let commit = Repository::commit(&loaded, result).unwrap();
            assert_eq!(commit.change_id().reverse_hex(), change);
            assert_eq!(commit.parent_ids(), &[CommitId::new(onto.to_vec())]);
            assert_eq!(commit.tree().has_conflict(), !verified || conflict);
            if verified { assert_eq!(fs::read(repo.root.join("alice")).unwrap(), b"person bytes\n"); }
            assert_eq!(fs::read(repo.root.join("main")).unwrap(), b"main bytes\n");
            if verified && !conflict {
                assert_eq!(fs::read(repo.root.join("retry")).unwrap(), b"log each retry\n");
                assert_eq!(repo.rebase_bound(onto, Some(&change), Some(base)).unwrap(), result);
            }
        }
    }
    #[test]
    fn journey_conflict_checkout_survives_capture_and_resolution() {
        let (_dir, repo) = fixture();
        fs::write(repo.root.join("JOURNEY.md"), b"Add a greeting to JOURNEY.md\n").unwrap();
        fs::write(repo.root.join("Makefile"), b"check:\n\ttest -s JOURNEY.md\n").unwrap();
        let base = repo.snapshot().unwrap().0;
        child(&repo, base, "greeting");
        fs::write(repo.root.join("JOURNEY.md"), b"Add a greeting to JOURNEY.md\nHello from Smithers!\n").unwrap();
        let item = repo.snapshot().unwrap().0;
        let change = change(&repo, item);
        child(&repo, base, "main");
        fs::write(repo.root.join("JOURNEY.md"), b"Greeting from new main\n").unwrap();
        let onto = repo.snapshot().unwrap().0;
        repo.move_to(item).unwrap();
        let conflict = repo.rebase_bound(onto, Some(&change), None).unwrap();
        let (_, loaded) = repo.load().unwrap();
        let git = jj_lib::git::get_git_repo(loaded.store()).unwrap();
        assert_eq!(git.head_id().unwrap().as_bytes(), onto);
        // A repeated wake reconciles a captured conflicted head against the
        // prior acknowledged item before the repair agent edits its files.
        let conflict = repo.rebase_delta(conflict, item, conflict).unwrap();
        for _ in 0..3 {
            let reopened = Repository::open(&repo.root, &repo.state).unwrap();
            assert_eq!(reopened.snapshot().unwrap().0, conflict);
        }
        fs::write(repo.root.join("JOURNEY.md"), b"Greeting from new main\nHello from Smithers!\n").unwrap();
        let reopened = Repository::open(&repo.root, &repo.state).unwrap();
        let _resolved = reopened.snapshot().unwrap().0;
        assert!(reopened.resolution_paths(conflict, onto).unwrap().is_empty());
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
        assert!(reopened.validate_rebase(onto, None).is_err());
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

#[path = "native_oplog.rs"]
mod retention;
