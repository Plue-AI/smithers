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
        flows_jj::ops::snapshot(&self.root, None).map_err(invalid)?;
        self.current()
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

#[path = "native_oplog.rs"]
mod retention;
