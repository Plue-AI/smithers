//! The flows `Jj` contract ops implemented over jj-lib.
//!
//! Semantics mirror `NodeJj` (`packages/jj/src/node/NodeJj.ts`), which shells
//! out to the `jj` CLI; each function here is the jj-lib equivalent of the
//! CLI invocation the Node layer performs. Repos use jj's `SimpleBackend`
//! (`jj debug init-simple` compatible) — git interop is out of scope.
//!
//! jj-lib's store traits are async but never pend over a synchronous
//! filesystem, so futures are driven with `pollster::block_on`, the same way
//! jj-lib's own sync wrappers (e.g. `Store::get_commit`) do.

use std::path::Component;
use std::path::Path;
use std::sync::Arc;

use jj_lib::commit::Commit;
use jj_lib::config::ConfigLayer;
use jj_lib::config::ConfigSource;
use jj_lib::config::StackedConfig;
use jj_lib::default_backend_factories::default_backend_factories;
use jj_lib::default_backend_factories::default_working_copy_factories;
use jj_lib::default_backend_factories::default_working_copy_factory;
use jj_lib::file_util;
use jj_lib::gitignore::GitIgnoreFile;
use jj_lib::matchers::EverythingMatcher;
use jj_lib::matchers::NothingMatcher;
use jj_lib::object_id::HexPrefix;
use jj_lib::object_id::ObjectId as _;
use jj_lib::object_id::PrefixResolution;
use jj_lib::ref_name::WorkspaceName;
use jj_lib::ref_name::WorkspaceNameBuf;
use jj_lib::repo::ReadonlyRepo;
use jj_lib::repo::Repo as _;
use jj_lib::rewrite::merge_commit_trees;
use jj_lib::settings::UserSettings;
use jj_lib::working_copy::SnapshotOptions;
use jj_lib::working_copy::WorkingCopyFreshness;
use jj_lib::workspace::Workspace;
use jj_lib::workspace_store::SimpleWorkspaceStore;
use jj_lib::workspace_store::WorkspaceStore as _;
use pollster::FutureExt as _;

use crate::diff_render;
use crate::error::OpError;
use crate::status_render;

/// `change_id.short()` in jj's template language truncates the reverse-hex
/// change id to 12 characters; `NodeJj` reads ids with exactly that template.
const SHORT_CHANGE_ID_LEN: usize = 12;

/// The identity recorded on commits and operations. The browser has no
/// `$USER`/`$HOSTNAME`; these are deliberately fixed so snapshots are
/// deterministic in what they depend on.
const USER_CONFIG: &str = r#"
user.name = "Flows"
user.email = "flows@localhost"
operation.hostname = "flows"
operation.username = "flows"
"#;

/// Immutable settings for every op. jj's config machinery stays out of the
/// wasm module — this is the whole configuration surface.
fn user_settings() -> Result<UserSettings, OpError> {
    let mut config = StackedConfig::with_defaults();
    let layer = ConfigLayer::parse(ConfigSource::User, USER_CONFIG)?;
    config.add_layer(layer);
    Ok(UserSettings::from_config(config)?)
}

/// Snapshot options matching jj's defaults for a repo with no user config:
/// track everything, no base ignores beyond in-tree `.gitignore` files, no
/// file-size ceiling.
fn snapshot_options() -> SnapshotOptions<'static> {
    SnapshotOptions {
        base_ignores: GitIgnoreFile::empty(),
        progress: None,
        start_tracking_matcher: &EverythingMatcher,
        force_tracking_matcher: &NothingMatcher,
        max_new_file_size: u64::MAX,
    }
}

/// Loads an existing workspace without creating directories or repository state.
fn load(settings: &UserSettings, root: &Path) -> Result<(Workspace, Arc<ReadonlyRepo>), OpError> {
    let workspace = Workspace::load(
        settings,
        root,
        &default_backend_factories(),
        &default_working_copy_factories(),
    )?;
    let repo_loader = workspace.repo_loader().clone();
    let repo = repo_loader.load_at_head().block_on()?;
    Ok((workspace, repo))
}

/// The workspace's current working-copy commit according to `repo`'s view.
fn wc_commit(repo: &Arc<ReadonlyRepo>, name: &WorkspaceName) -> Result<Commit, OpError> {
    let commit_id = repo.view().get_wc_commit_id(name).ok_or_else(|| {
        OpError::unknown(format!(
            "workspace '{name}' has no working-copy commit (forgotten?)",
            name = name.as_symbol()
        ))
    })?;
    Ok(repo.store().get_commit(commit_id)?)
}

/// Snapshots the working copy into the current change and commits the
/// "snapshot working copy" operation, mirroring what every `jj` CLI command
/// does before running. Returns the (possibly rewritten) working-copy commit.
fn snapshot_working_copy(
    workspace: &mut Workspace,
    repo: &mut Arc<ReadonlyRepo>,
) -> Result<Commit, OpError> {
    let name = workspace.workspace_name().to_owned();
    let mut locked_ws = workspace.start_working_copy_mutation().block_on()?;
    let mut commit = wc_commit(repo, &name)?;
    match WorkingCopyFreshness::check_stale(locked_ws.locked_wc(), &commit, repo).block_on()? {
        WorkingCopyFreshness::Fresh => {}
        WorkingCopyFreshness::Updated(operation) => {
            *repo = repo.reload_at(&operation).block_on()?;
            commit = wc_commit(repo, &name)?;
        }
        WorkingCopyFreshness::WorkingCopyStale | WorkingCopyFreshness::SiblingOperation => {
            return Err(OpError::unknown(format!(
                "the working copy at '{root}' is stale (not updated since an older operation)",
                root = workspace.workspace_root().display()
            )));
        }
    }
    let options = snapshot_options();
    let (new_tree, _stats) = locked_ws.locked_wc().snapshot(&options).block_on()?;
    if new_tree.tree_ids_and_labels() != commit.tree().tree_ids_and_labels() {
        let mut tx = repo.start_transaction();
        tx.set_is_snapshot(true);
        let mut_repo = tx.repo_mut();
        let new_commit = mut_repo
            .rewrite_commit(&commit)
            .set_tree(new_tree)
            .write()
            .block_on()?;
        mut_repo.set_wc_commit(name.clone(), new_commit.id().clone())?;
        mut_repo.rebase_descendants().block_on()?;
        *repo = tx.commit("snapshot working copy").block_on()?;
        commit = new_commit;
    }
    locked_ws.finish(repo.op_id().clone()).block_on()?;
    Ok(commit)
}

/// Resolves a user-supplied revision string to a commit: `@` is the
/// working-copy commit, otherwise a change-id prefix (reverse hex, the form
/// `snapshot` returns) or a commit-id prefix (hex). Every failure is
/// `invalid_ref` — the messages reuse jj's own stderr vocabulary so the two
/// `Jj` layers classify identically.
fn resolve_revision(
    repo: &Arc<ReadonlyRepo>,
    workspace_commit: &Commit,
    symbol: &str,
) -> Result<Commit, OpError> {
    if symbol == "@" {
        return Ok(workspace_commit.clone());
    }
    if symbol.is_empty() {
        return Err(OpError::invalid_ref("empty revision string"));
    }
    if let Some(prefix) = HexPrefix::try_from_reverse_hex(symbol) {
        match repo.resolve_change_id_prefix(&prefix)? {
            PrefixResolution::NoMatch => {}
            PrefixResolution::AmbiguousMatch => {
                return Err(OpError::invalid_ref(format!(
                    "change id prefix \"{symbol}\" is ambiguous"
                )));
            }
            PrefixResolution::SingleMatch(targets) => {
                let visible: Vec<_> = targets
                    .visible_with_offsets()
                    .map(|(_offset, commit_id)| commit_id)
                    .collect();
                return match visible[..] {
                    [] => Err(OpError::invalid_ref(format!(
                        "revision \"{symbol}\" doesn't exist (the change is hidden)"
                    ))),
                    [commit_id] => Ok(repo.store().get_commit(commit_id)?),
                    _ => Err(OpError::invalid_ref(format!(
                        "change id \"{symbol}\" is divergent"
                    ))),
                };
            }
        }
    }
    if let Some(prefix) = HexPrefix::try_from_hex(symbol) {
        match repo.index().resolve_commit_id_prefix(&prefix)? {
            PrefixResolution::NoMatch => {}
            PrefixResolution::AmbiguousMatch => {
                return Err(OpError::invalid_ref(format!(
                    "commit id prefix \"{symbol}\" is ambiguous"
                )));
            }
            PrefixResolution::SingleMatch(commit_id) => {
                return Ok(repo.store().get_commit(&commit_id)?);
            }
        }
    }
    Err(OpError::invalid_ref(format!(
        "revision \"{symbol}\" doesn't exist"
    )))
}

/// The first 12 characters of the reverse-hex change id — the exact string
/// `NodeJj` reads with `-T "change_id.short()"`.
fn short_change_id(commit: &Commit) -> String {
    let mut id = commit.change_id().reverse_hex();
    id.truncate(SHORT_CHANGE_ID_LEN);
    id
}

/// `init`: create a `SimpleBackend` repo at `root`. Idempotent — an existing
/// workspace is loaded (validated) and left untouched, so a reloading page
/// can call `init` unconditionally.
pub fn init(root: &Path) -> Result<(), OpError> {
    let settings = user_settings()?;
    if root.join(".jj").exists() {
        let _ = load(&settings, root)?;
    } else {
        std::fs::create_dir_all(root)?;
        Workspace::init_simple(&settings, root).block_on()?;
    }
    Ok(())
}

/// The current change captured by [`snapshot`], without describing or closing it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Snapshot {
    pub commit_id: String,
    pub change_id: String,
    pub operation_id: String,
}

/// Captures the working copy in place. The message is journal metadata only.
pub fn snapshot(root: &Path, _message: Option<&str>) -> Result<Snapshot, OpError> {
    let settings = user_settings()?;
    let (mut workspace, mut repo) = load(&settings, root)?;
    let commit = snapshot_working_copy(&mut workspace, &mut repo)?;
    Ok(Snapshot {
        commit_id: commit.id().hex(),
        change_id: short_change_id(&commit),
        operation_id: repo.op_id().hex(),
    })
}

/// Restores the repository view while preserving remote tracking and other workspaces.
pub fn op_restore(root: &Path, operation_id: &str) -> Result<(), OpError> {
    if operation_id.is_empty()
        || !operation_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(OpError::invalid_ref("not an operation id"));
    }
    let prefix = HexPrefix::try_from_hex(operation_id)
        .ok_or_else(|| OpError::invalid_ref("not an operation id"))?;
    let settings = user_settings()?;
    let (mut workspace, mut repo) = load(&settings, root)?;
    let name = workspace.workspace_name().to_owned();
    let commit = snapshot_working_copy(&mut workspace, &mut repo)?;
    let id = match repo
        .op_store()
        .resolve_operation_id_prefix(&prefix)
        .block_on()
        .map_err(OpError::unknown_source)?
    {
        PrefixResolution::SingleMatch(id) => id,
        PrefixResolution::NoMatch => {
            return Err(OpError::invalid_ref("operation does not resolve"));
        }
        PrefixResolution::AmbiguousMatch => {
            return Err(OpError::invalid_ref("operation id is ambiguous"));
        }
    };
    let operation = repo
        .loader()
        .load_operation(&id)
        .block_on()
        .map_err(OpError::unknown_source)?;
    let target = repo.reload_at(&operation).block_on()?;
    let now = repo.view().store_view();
    let mut view = target.view().store_view().clone();
    let other_now: std::collections::BTreeMap<_, _> = now
        .wc_commit_ids
        .iter()
        .filter(|(workspace, _)| *workspace != &name)
        .collect();
    let other_then: std::collections::BTreeMap<_, _> = view
        .wc_commit_ids
        .iter()
        .filter(|(workspace, _)| *workspace != &name)
        .collect();
    if other_now != other_then || !view.wc_commit_ids.contains_key(&name) {
        return Err(OpError::conflict("workspace(s) changed after operation"));
    }
    view.remote_views = now.remote_views.clone();
    view.git_refs = now.git_refs.clone();
    view.git_head = now.git_head.clone();
    let mut tx = repo.start_transaction();
    tx.repo_mut().merge_index(&target)?;
    tx.repo_mut().set_view(view);
    repo = tx
        .commit(format!("restore to operation {}", id.hex()))
        .block_on()?;
    let restored = wc_commit(&repo, &name)?;
    workspace
        .check_out(repo.op_id().clone(), Some(&commit.tree()), &restored)
        .block_on()?;
    Ok(())
}

/// `restore`: put the working-copy files back to `change_id`'s tree —
/// `jj restore --from <change_id>`. The current change keeps its identity;
/// only its tree (and the files on disk) change.
pub fn restore(root: &Path, change_id: &str) -> Result<(), OpError> {
    let settings = user_settings()?;
    let (mut workspace, mut repo) = load(&settings, root)?;
    let name = workspace.workspace_name().to_owned();
    let commit = snapshot_working_copy(&mut workspace, &mut repo)?;
    let from_commit = resolve_revision(&repo, &commit, change_id)?;
    if from_commit.tree_ids() == commit.tree_ids() {
        return Ok(());
    }
    let mut tx = repo.start_transaction();
    let mut_repo = tx.repo_mut();
    mut_repo
        .rewrite_commit(&commit)
        .set_tree(from_commit.tree())
        .write()
        .block_on()?;
    mut_repo.rebase_descendants().block_on()?;
    repo = tx
        .commit(format!("restore into commit {}", commit.id().hex()))
        .block_on()?;
    let new_commit = wc_commit(&repo, &name)?;
    let old_tree = commit.tree();
    workspace
        .check_out(repo.op_id().clone(), Some(&old_tree), &new_commit)
        .block_on()?;
    Ok(())
}

/// `diff`: git-format unified diff between two revisions' trees —
/// `jj diff --from <from> --to <to> --git`.
pub fn diff(root: &Path, from: &str, to: &str) -> Result<String, OpError> {
    let settings = user_settings()?;
    let (mut workspace, mut repo) = load(&settings, root)?;
    let commit = snapshot_working_copy(&mut workspace, &mut repo)?;
    let from_commit = resolve_revision(&repo, &commit, from)?;
    let to_commit = resolve_revision(&repo, &commit, to)?;
    diff_render::git_diff(repo.store(), &from_commit.tree(), &to_commit.tree())
}

/// `status`: current change id plus per-file working-copy changes (A/M/D
/// lines) — `jj status`. Contract callers treat the text as opaque; the
/// format is ours and covered by tests.
pub fn status(root: &Path) -> Result<String, OpError> {
    let settings = user_settings()?;
    let (mut workspace, mut repo) = load(&settings, root)?;
    let commit = snapshot_working_copy(&mut workspace, &mut repo)?;
    let parent_tree = commit.parent_tree(repo.as_ref()).block_on()?;
    status_render::status(&parent_tree, &commit.tree(), &short_change_id(&commit))
}

/// Refuses a workspace name outside `[A-Za-z0-9._-]`, or one that is empty or
/// starts with `.`. The name is a caller-chosen string that becomes a
/// workspace-store key, a jj operation description, and log text, so a `/`,
/// `..`, newline, or control character in it would reach all three.
fn validate_workspace_name(name: &str) -> Result<(), OpError> {
    if name.is_empty() {
        return Err(OpError::unknown("workspace name cannot be empty"));
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
    if name.starts_with('.') || !name.chars().all(allowed) {
        return Err(OpError::unknown(format!(
            "workspace name {name:?} must use only A-Z, a-z, 0-9, '.', '_', and '-', and must not start with '.'"
        )));
    }
    Ok(())
}

/// The destination a `workspaceAdd` may create: an absolute path with no
/// `.` or `..` component and no `.jj` or `.git` component, compared without
/// regard to ASCII case because APFS and NTFS resolve `.JJ` to `.jj`. The
/// path is caller-chosen, and without these checks it could climb out of the
/// directory the caller named or land a working copy inside a repository's
/// `.jj` store or colocated `.git` directory.
fn workspace_destination(path: &str) -> Result<&Path, OpError> {
    let destination = Path::new(path);
    if !destination.is_absolute() {
        return Err(OpError::unknown(format!(
            "destination path {path:?} must be absolute"
        )));
    }
    // `Path::components` drops interior `.` segments, so inspect the raw
    // segments too.
    let dot_segment = path
        .split('/')
        .any(|segment| segment == "." || segment == "..");
    let bad_component = destination.components().any(|component| {
        matches!(component, Component::ParentDir | Component::CurDir)
            || component.as_os_str().to_str().is_some_and(|segment| {
                segment.eq_ignore_ascii_case(".jj") || segment.eq_ignore_ascii_case(".git")
            })
    });
    if dot_segment || bad_component {
        return Err(OpError::unknown(format!(
            "destination path {path:?} must not contain '.', '..', '.jj', or '.git' components"
        )));
    }
    Ok(destination)
}

/// `workspaceAdd`: attach a second working copy named `name` at `path` —
/// `jj workspace add --name <name> <path>`. The new workspace's working-copy
/// commit is opened on the parents of this workspace's current change, same
/// as the CLI.
pub fn workspace_add(root: &Path, name: &str, path: &str) -> Result<(), OpError> {
    validate_workspace_name(name)?;
    let destination = workspace_destination(path)?;
    let settings = user_settings()?;
    let (mut workspace, mut repo) = load(&settings, root)?;
    snapshot_working_copy(&mut workspace, &mut repo)?;

    let name_buf: WorkspaceNameBuf = name.into();
    if repo.view().get_wc_commit_id(&name_buf).is_some() {
        return Err(OpError::unknown(format!(
            "workspace '{name}' already exists"
        )));
    }
    if !destination.exists() {
        std::fs::create_dir_all(destination)?;
    } else if !file_util::is_empty_dir(destination)? {
        return Err(OpError::unknown(format!(
            "destination path '{path}' exists and is not an empty directory"
        )));
    }

    let (mut new_workspace, repo) = Workspace::init_workspace_with_existing_repo(
        destination,
        workspace.repo_path(),
        &repo,
        &*default_working_copy_factory(),
        name_buf.clone(),
    )
    .block_on()?;

    let parents = match repo.view().get_wc_commit_id(workspace.workspace_name()) {
        Some(commit_id) => repo.store().get_commit(commit_id)?.parents().block_on()?,
        None => vec![repo.store().root_commit()],
    };
    let mut tx = repo.start_transaction();
    let merged_tree = merge_commit_trees(tx.repo(), &parents).block_on()?;
    let parent_ids = parents.iter().map(|commit| commit.id().clone()).collect();
    let mut_repo = tx.repo_mut();
    let new_commit = mut_repo
        .new_commit(parent_ids, merged_tree)
        .write()
        .block_on()?;
    mut_repo.edit(name_buf, &new_commit).block_on()?;
    // `edit` abandons the placeholder commit the workspace was initialized
    // with; the abandonment must be propagated before the transaction commits.
    mut_repo.rebase_descendants().block_on()?;
    let repo = tx
        .commit(format!(
            "create initial working-copy commit in workspace {name}"
        ))
        .block_on()?;
    new_workspace
        .check_out(repo.op_id().clone(), None, &new_commit)
        .block_on()?;
    Ok(())
}

/// `workspaceForget`: stop tracking workspace `name` —
/// `jj workspace forget <name>`. Forgetting a workspace that does not exist
/// is a no-op, exactly like the CLI (which warns and exits 0). The files at
/// the forgotten workspace's path are left in place, also like the CLI.
pub fn workspace_forget(root: &Path, name: &str) -> Result<(), OpError> {
    validate_workspace_name(name)?;
    let settings = user_settings()?;
    let (workspace, repo) = load(&settings, root)?;
    let name_buf: WorkspaceNameBuf = name.into();
    if repo.view().get_wc_commit_id(&name_buf).is_none() {
        return Ok(());
    }
    let mut tx = repo.start_transaction();
    let mut_repo = tx.repo_mut();
    mut_repo.remove_wc_commit(&name_buf).block_on()?;
    // Removing the working-copy commit may abandon it (a rewrite), which must
    // be propagated before the transaction commits.
    mut_repo.rebase_descendants().block_on()?;
    let workspace_store = SimpleWorkspaceStore::load(workspace.repo_path())?;
    workspace_store.forget(&[&*name_buf])?;
    tx.commit(format!("forget workspace {name}")).block_on()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_repository_operations_do_not_create_a_directory() {
        let temp = tempfile::tempdir().unwrap();
        for exists in [false, true] {
            let root = temp.path().join(if exists { "empty" } else { "missing" });
            if exists {
                std::fs::create_dir(&root).unwrap();
            }
            for result in [
                status(&root),
                diff(&root, "@", "@"),
                restore(&root, "@").map(|()| String::new()),
            ] {
                assert!(result.is_err());
                assert_eq!(result.unwrap_err().code, crate::error::ErrorCode::Unknown);
                assert_eq!(root.exists(), exists);
                assert!(!root.join(".jj").exists());
            }
        }
    }

    #[test]
    fn revision_resolution_accepts_current_change_and_commit_ids() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        init(&root).unwrap();
        std::fs::write(root.join("file.txt"), "version one\n").unwrap();
        let saved = snapshot(&root, Some("saved")).unwrap();
        let settings = user_settings().unwrap();
        let (workspace, repo) = load(&settings, &root).unwrap();
        let current = wc_commit(&repo, workspace.workspace_name()).unwrap();

        assert_eq!(
            resolve_revision(&repo, &current, "@").unwrap().id(),
            current.id()
        );
        assert_eq!(
            resolve_revision(&repo, &current, &saved.commit_id)
                .unwrap()
                .id()
                .hex(),
            saved.commit_id
        );
        assert_eq!(
            resolve_revision(&repo, &current, &saved.change_id)
                .unwrap()
                .id()
                .hex(),
            saved.commit_id
        );
        assert_eq!(short_change_id(&current).len(), 12);

        for (symbol, message) in [
            ("", "empty revision string"),
            (
                "not-a-reference",
                "revision \"not-a-reference\" doesn't exist",
            ),
            ("kkkkkkkkkkkk", "revision \"kkkkkkkkkkkk\" doesn't exist"),
            ("ffffffffffff", "revision \"ffffffffffff\" doesn't exist"),
        ] {
            let error = resolve_revision(&repo, &current, symbol).unwrap_err();
            assert_eq!(error.code, crate::error::ErrorCode::InvalidRef);
            assert_eq!(error.message, message);
        }
    }

    #[test]
    fn init_is_idempotent_and_missing_workspace_has_clear_error() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        init(&root).unwrap();
        std::fs::write(root.join("keep.txt"), "keep\n").unwrap();
        let settings = user_settings().unwrap();
        let (workspace, repo) = load(&settings, &root).unwrap();
        let original = wc_commit(&repo, workspace.workspace_name())
            .unwrap()
            .id()
            .clone();

        let missing: WorkspaceNameBuf = "missing".into();
        let error = wc_commit(&repo, &missing).unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::Unknown);
        assert_eq!(
            error.message,
            "workspace 'missing' has no working-copy commit (forgotten?)"
        );

        init(&root).unwrap();
        assert_eq!(std::fs::read(root.join("keep.txt")).unwrap(), b"keep\n");
        let (workspace, repo) = load(&settings, &root).unwrap();
        assert_eq!(
            wc_commit(&repo, workspace.workspace_name()).unwrap().id(),
            &original
        );
    }

    #[test]
    fn one_character_revision_prefixes_reject_real_ambiguity() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        init(&root).unwrap();
        let settings = user_settings().unwrap();
        let (workspace, mut repo) = load(&settings, &root).unwrap();
        let mut saved = Vec::new();
        // Ambiguity needs distinct visible changes; snapshots intentionally keep @.
        for index in 0..17 {
            let mut tx = repo.start_transaction();
            let commit = tx
                .repo_mut()
                .new_commit(
                    vec![repo.store().root_commit_id().clone()],
                    repo.store().empty_merged_tree(),
                )
                .set_description(format!("branch {index}"))
                .write()
                .block_on()
                .unwrap();
            repo = tx
                .commit(format!("create branch {index}"))
                .block_on()
                .unwrap();
            saved.push(Snapshot {
                commit_id: commit.id().hex(),
                change_id: short_change_id(&commit),
                operation_id: repo.op_id().hex(),
            });
        }
        let current = wc_commit(&repo, workspace.workspace_name()).unwrap();

        for (label, prefixes) in [
            (
                "change id",
                saved.iter().map(|s| &s.change_id).collect::<Vec<_>>(),
            ),
            (
                "commit id",
                saved.iter().map(|s| &s.commit_id).collect::<Vec<_>>(),
            ),
        ] {
            let prefix = ('a'..='z')
                .chain('0'..='9')
                .find(|prefix| prefixes.iter().filter(|id| id.starts_with(*prefix)).count() >= 2)
                .unwrap();
            let symbol = prefix.to_string();
            let error = resolve_revision(&repo, &current, &symbol).unwrap_err();
            assert_eq!(error.code, crate::error::ErrorCode::InvalidRef);
            assert_eq!(
                error.message,
                format!("{label} prefix \"{symbol}\" is ambiguous")
            );
        }
    }

    #[test]
    fn hidden_change_id_reports_that_its_commit_is_no_longer_visible() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        init(&root).unwrap();
        let settings = user_settings().unwrap();
        let (workspace, repo) = load(&settings, &root).unwrap();

        let mut tx = repo.start_transaction();
        let hidden = tx
            .repo_mut()
            .new_commit(
                vec![repo.store().root_commit_id().clone()],
                repo.store().empty_merged_tree(),
            )
            .set_description("temporary branch")
            .write()
            .block_on()
            .unwrap();
        let repo = tx.commit("create temporary branch").block_on().unwrap();
        assert!(repo.view().heads().contains(hidden.id()));

        let mut tx = repo.start_transaction();
        tx.repo_mut().remove_head(hidden.id());
        let repo = tx.commit("hide temporary branch").block_on().unwrap();
        assert!(!repo.view().heads().contains(hidden.id()));
        let current = wc_commit(&repo, workspace.workspace_name()).unwrap();
        let symbol = short_change_id(&hidden);
        let error = resolve_revision(&repo, &current, &symbol).unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::InvalidRef);
        assert_eq!(
            error.message,
            format!("revision \"{symbol}\" doesn't exist (the change is hidden)")
        );
    }

    #[test]
    fn divergent_change_id_rejects_multiple_visible_commits() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        init(&root).unwrap();
        let settings = user_settings().unwrap();
        let (workspace, repo) = load(&settings, &root).unwrap();
        let parent = repo.store().root_commit_id().clone();
        let tree = repo.store().empty_merged_tree();

        let mut tx = repo.start_transaction();
        let first = tx
            .repo_mut()
            .new_commit(vec![parent.clone()], tree.clone())
            .set_description("branch one")
            .write()
            .block_on()
            .unwrap();
        let second = tx
            .repo_mut()
            .new_commit(vec![parent], tree)
            .set_change_id(first.change_id().clone())
            .set_description("branch two")
            .write()
            .block_on()
            .unwrap();
        let repo = tx.commit("create divergent change").block_on().unwrap();
        assert!(repo.view().heads().contains(first.id()));
        assert!(repo.view().heads().contains(second.id()));
        let current = wc_commit(&repo, workspace.workspace_name()).unwrap();
        let symbol = short_change_id(&first);
        let error = resolve_revision(&repo, &current, &symbol).unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::InvalidRef);
        assert_eq!(
            error.message,
            format!("change id \"{symbol}\" is divergent")
        );
    }

    #[test]
    fn stale_loaded_repository_reloads_after_another_operation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        init(&root).unwrap();
        let settings = user_settings().unwrap();
        let (mut old_workspace, mut old_repo) = load(&settings, &root).unwrap();
        let original_op = old_repo.op_id().clone();

        std::fs::write(root.join("new.txt"), "from newer operation\n").unwrap();
        let saved = snapshot(&root, Some("newer")).unwrap();
        assert_eq!(old_repo.op_id(), &original_op);
        let current = snapshot_working_copy(&mut old_workspace, &mut old_repo).unwrap();
        assert_ne!(old_repo.op_id(), &original_op);
        assert_eq!(
            current.tree_ids(),
            wc_commit(&old_repo, old_workspace.workspace_name())
                .unwrap()
                .tree_ids()
        );
        assert_eq!(
            std::fs::read(root.join("new.txt")).unwrap(),
            b"from newer operation\n"
        );
        assert!(
            old_repo
                .store()
                .get_commit(&jj_lib::backend::CommitId::try_from_hex(saved.commit_id).unwrap())
                .is_ok()
        );
    }

    #[test]
    fn stale_working_copy_refuses_repo_tree_change_without_checkout() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        init(&root).unwrap();
        std::fs::write(root.join("keep.txt"), "still on disk\n").unwrap();
        snapshot(&root, Some("base")).unwrap();
        let settings = user_settings().unwrap();
        let (mut workspace, repo) = load(&settings, &root).unwrap();
        let name = workspace.workspace_name().to_owned();
        let current = wc_commit(&repo, &name).unwrap();
        assert_ne!(current.tree_ids(), &repo.store().empty_merged_tree_id());

        let mut tx = repo.start_transaction();
        let next = tx
            .repo_mut()
            .rewrite_commit(&current)
            .set_tree(repo.store().empty_merged_tree())
            .write()
            .block_on()
            .unwrap();
        tx.repo_mut()
            .set_wc_commit(name, next.id().clone())
            .unwrap();
        tx.repo_mut().rebase_descendants().block_on().unwrap();
        let mut newer_repo = tx
            .commit("advance repo without checkout")
            .block_on()
            .unwrap();

        let error = snapshot_working_copy(&mut workspace, &mut newer_repo).unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::Unknown);
        assert!(error.message.contains("working copy"));
        assert!(error.message.contains("stale"));
        assert!(error.message.contains(root.to_str().unwrap()));
        assert_eq!(
            std::fs::read(root.join("keep.txt")).unwrap(),
            b"still on disk\n"
        );
    }

    #[test]
    fn direct_working_copy_snapshot_detects_edits_then_stabilizes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        init(&root).unwrap();
        let settings = user_settings().unwrap();
        let (mut workspace, mut repo) = load(&settings, &root).unwrap();
        let before = wc_commit(&repo, workspace.workspace_name()).unwrap();

        std::fs::write(root.join("new.txt"), "new\n").unwrap();
        let changed = snapshot_working_copy(&mut workspace, &mut repo).unwrap();
        assert_eq!(changed.change_id(), before.change_id());
        assert_ne!(changed.tree_ids(), before.tree_ids());
        assert_eq!(
            status_render::status(&repo.store().empty_merged_tree(), &changed.tree(), "id")
                .unwrap(),
            "Working copy changes:\nA new.txt\nWorking copy  (@) : id\n"
        );

        let unchanged = snapshot_working_copy(&mut workspace, &mut repo).unwrap();
        assert_eq!(unchanged.id(), changed.id());
        assert_eq!(unchanged.tree_ids(), changed.tree_ids());
    }

    #[test]
    fn restore_and_diff_keep_bytes_and_identity_after_invalid_refs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        init(&root).unwrap();
        std::fs::write(root.join("note.txt"), "before\n").unwrap();
        let first = snapshot(&root, Some("first")).unwrap();
        std::fs::write(root.join("note.txt"), "after\n").unwrap();
        let second = snapshot(&root, Some("second")).unwrap();

        let expected = diff(&root, &first.commit_id, &second.commit_id).unwrap();
        assert!(expected.contains("-before\n+after\n"), "{expected}");
        assert_eq!(
            diff(&root, &second.commit_id, &second.commit_id).unwrap(),
            ""
        );
        let current_id = status(&root).unwrap().lines().last().unwrap().to_owned();

        for invalid in ["", "missing", "not-a-rev!"] {
            let before = std::fs::read(root.join("note.txt")).unwrap();
            let error = restore(&root, invalid).unwrap_err();
            assert_eq!(error.code, crate::error::ErrorCode::InvalidRef);
            assert!(error.message.contains(if invalid.is_empty() {
                "empty revision"
            } else {
                invalid
            }));
            assert_eq!(std::fs::read(root.join("note.txt")).unwrap(), before);
            assert_eq!(status(&root).unwrap().lines().last().unwrap(), current_id);
        }
        let diff_error = diff(&root, "missing", &second.commit_id).unwrap_err();
        assert_eq!(diff_error.code, crate::error::ErrorCode::InvalidRef);
        assert_eq!(diff_error.message, "revision \"missing\" doesn't exist");
        assert_eq!(std::fs::read(root.join("note.txt")).unwrap(), b"after\n");

        restore(&root, &first.commit_id).unwrap();
        assert_eq!(std::fs::read(root.join("note.txt")).unwrap(), b"before\n");
        assert_eq!(diff(&root, "@", &first.commit_id).unwrap(), "");
        assert_eq!(status(&root).unwrap().lines().last().unwrap(), current_id);
        restore(&root, &first.commit_id).unwrap();
        assert_eq!(std::fs::read(root.join("note.txt")).unwrap(), b"before\n");
    }

    #[test]
    fn adding_from_forgotten_current_workspace_refuses_before_destination_mutation() {
        for destination_exists in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("repo");
            init(&root).unwrap();
            std::fs::write(root.join("keep.txt"), b"preserved\n").unwrap();
            snapshot(&root, Some("preserved")).unwrap();
            workspace_forget(&root, "default").unwrap();

            let destination = temp.path().join("lane");
            if destination_exists {
                std::fs::create_dir(&destination).unwrap();
            }
            let error = workspace_add(&root, "lane", destination.to_str().unwrap()).unwrap_err();
            assert_eq!(error.code, crate::error::ErrorCode::Unknown);
            assert_eq!(
                error.message,
                "workspace 'default' has no working-copy commit (forgotten?)"
            );
            assert_eq!(
                std::fs::read(root.join("keep.txt")).unwrap(),
                b"preserved\n"
            );
            assert_eq!(destination.exists(), destination_exists);
            if destination_exists {
                assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 0);
            }
            let settings = user_settings().unwrap();
            let (_, repo) = load(&settings, &root).unwrap();
            assert!(repo.view().wc_commit_ids().is_empty());
        }
    }

    #[test]
    fn workspace_add_refuses_unsafe_names_and_destinations_before_touching_disk() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        init(&root).unwrap();
        let lane = temp.path().join("lane");
        let lane = lane.to_str().unwrap();

        for name in [
            "a/b",
            "..",
            ".hidden",
            "lane\nforged",
            "lane\u{1b}[31m",
            "雪",
        ] {
            let error = workspace_add(&root, name, lane).unwrap_err();
            assert_eq!(error.code, crate::error::ErrorCode::Unknown);
            assert!(
                error.message.contains("workspace name"),
                "{}",
                error.message
            );
            assert!(!Path::new(lane).exists());
            let error = workspace_forget(&root, name).unwrap_err();
            assert!(
                error.message.contains("workspace name"),
                "{}",
                error.message
            );
        }

        let inside_store = root.join(".jj").join("lane");
        // Case-insensitive filesystems (APFS, NTFS) resolve `.JJ` to `.jj`.
        let inside_store_upper = root.join(".JJ").join("lane");
        let inside_git = root.join(".git").join("lane");
        let inside_git_upper = root.join(".Git").join("lane");
        let escaping = format!("{}/../escaped", temp.path().join("sub").display());
        let dotted = format!("{}/./dotted", temp.path().display());
        for (path, created) in [
            (
                "relative-lane".to_owned(),
                Path::new("relative-lane").to_owned(),
            ),
            (
                inside_store.to_str().unwrap().to_owned(),
                inside_store.clone(),
            ),
            (
                inside_store_upper.to_str().unwrap().to_owned(),
                inside_store_upper.clone(),
            ),
            (inside_git.to_str().unwrap().to_owned(), inside_git.clone()),
            (
                inside_git_upper.to_str().unwrap().to_owned(),
                inside_git_upper.clone(),
            ),
            (escaping, temp.path().join("escaped")),
            (dotted, temp.path().join("dotted")),
        ] {
            let error = workspace_add(&root, "lane", &path).unwrap_err();
            assert_eq!(error.code, crate::error::ErrorCode::Unknown);
            assert!(
                error.message.contains("destination path"),
                "{}",
                error.message
            );
            assert!(!created.exists(), "{path} was created");
        }
        let settings = user_settings().unwrap();
        let (_, repo) = load(&settings, &root).unwrap();
        assert_eq!(repo.view().wc_commit_ids().len(), 1);

        workspace_add(&root, "Lane_1.a-b", lane).unwrap();
        workspace_forget(&root, "Lane_1.a-b").unwrap();
    }

    #[test]
    fn workspace_lifecycle_refusals_leave_repository_and_destinations_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        init(&root).unwrap();
        std::fs::write(root.join("base.txt"), "base\n").unwrap();
        let saved = snapshot(&root, Some("base")).unwrap();

        let lane = temp.path().join("lane");
        let empty_name = workspace_add(&root, "", lane.to_str().unwrap()).unwrap_err();
        assert_eq!(empty_name.code, crate::error::ErrorCode::Unknown);
        assert_eq!(empty_name.message, "workspace name cannot be empty");
        assert!(!lane.exists());

        let blocked = temp.path().join("blocked");
        std::fs::create_dir(&blocked).unwrap();
        std::fs::write(blocked.join("keep.txt"), "untouched").unwrap();
        let occupied = workspace_add(&root, "lane", blocked.to_str().unwrap()).unwrap_err();
        assert_eq!(occupied.code, crate::error::ErrorCode::Unknown);
        assert!(occupied.message.contains("not an empty directory"));
        assert_eq!(
            std::fs::read(blocked.join("keep.txt")).unwrap(),
            b"untouched"
        );
        assert_eq!(std::fs::read(root.join("base.txt")).unwrap(), b"base\n");

        std::fs::create_dir(&lane).unwrap();
        workspace_add(&root, "lane", lane.to_str().unwrap()).unwrap();
        restore(&lane, &saved.commit_id).unwrap();
        assert_eq!(std::fs::read(lane.join("base.txt")).unwrap(), b"base\n");
        let duplicate = temp.path().join("duplicate");
        let error = workspace_add(&root, "lane", duplicate.to_str().unwrap()).unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::Unknown);
        assert_eq!(error.message, "workspace 'lane' already exists");
        assert!(!duplicate.exists());

        workspace_forget(&root, "lane").unwrap();
        assert_eq!(std::fs::read(lane.join("base.txt")).unwrap(), b"base\n");
        let settings = user_settings().unwrap();
        let (_, repo) = load(&settings, &root).unwrap();
        let lane_name: WorkspaceNameBuf = "lane".into();
        assert!(repo.view().get_wc_commit_id(&lane_name).is_none());
        workspace_forget(&root, "lane").unwrap();
        workspace_add(&root, "lane", duplicate.to_str().unwrap()).unwrap();
        restore(&duplicate, &saved.commit_id).unwrap();
        assert_eq!(
            std::fs::read(duplicate.join("base.txt")).unwrap(),
            b"base\n"
        );
    }
}
