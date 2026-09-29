//! C ABI entry points for Smithers repository operations.
//!
//! All exported functions return heap-allocated UTF-8 JSON strings. The caller
//! owns every non-NULL return value and must release it with
//! [`smithers_free_string`] exactly once.
//!
//! Input pointers may be NULL, in which case the function returns a JSON error
//! envelope. Any non-NULL pointer must reference a valid NUL-terminated C
//! string for the duration of the call. Invalid UTF-8 is reported as JSON, but
//! dangling pointers, unterminated strings, or other invalid memory violate the
//! FFI contract and are undefined behavior.
//!
//! The library is reentrant, but it does not synchronize concurrent operations
//! against the same repository path. Callers must serialize concurrent writers
//! and avoid freeing the same returned pointer from multiple threads.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::{c_char, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::prelude::{Engine as _, BASE64_STANDARD};
use futures::StreamExt as _;
use jj_lib::backend::{CommitId, CopyId, TreeValue};
use jj_lib::conflict_labels::ConflictLabels;
use jj_lib::conflicts::{
    extract_as_single_hunk, materialize_merge_result_to_bytes, ConflictMarkerStyle,
    ConflictMaterializeOptions,
};
use jj_lib::git::GitImportOptions;
use jj_lib::gitignore::GitIgnoreFile;
use jj_lib::matchers::{EverythingMatcher, FilesMatcher, NothingMatcher};
use jj_lib::merge::Merge;
use jj_lib::merged_tree::MergedTree;
use jj_lib::object_id::ObjectId;
use jj_lib::op_store::RefTarget;
use jj_lib::op_walk;
use jj_lib::ref_name::{RefName, WorkspaceName};
use jj_lib::repo::{ReadonlyRepo, Repo};
use jj_lib::repo_path::RepoPathBuf;
use jj_lib::str_util::StringMatcher;
use jj_lib::tree_builder::TreeBuilder;
use jj_lib::working_copy::SnapshotOptions;
use jj_lib::workspace::Workspace;
mod append_prepare;
// Run the Windows namespace boundary tests independently of the command host.
#[cfg(all(test, windows))]
mod atomic_glob;
#[cfg(all(test, windows))]
mod atomic_protocol;
#[cfg(all(test, windows))]
mod atomic_windows_fs;
#[cfg(all(test, windows))]
mod atomic_windows_handle;
pub mod jj_core;
pub mod tree_export;
mod wiki_document;
mod wiki_projection;
pub mod workspace_source;
use jj_core::{
    collect_tree_diff, create_settings, format_timestamp, load_repo, load_repo_at_head,
    parent_tree, read_file_content, resolve_change_id as core_resolve_change_id,
    resolve_commit_id as core_resolve_commit_id, ChangeIdResolution, UserConfig,
    MAX_BLOB_READ_BYTES,
};
use pollster::FutureExt as _;
use serde::{Deserialize, Serialize};

const PAGINATION_MAX_PER_PAGE: u32 = 100;

/// The mythical stack's bookmark (Go: repohost.MythicalBookmarkRef).
const MYTHICAL_BOOKMARK: &str = "mythical";

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
    code: &'static str,
}

#[derive(Serialize)]
struct InitRepoResponse {
    status: &'static str,
    path: String,
}

#[derive(Serialize)]
struct StatusResponse {
    status: &'static str,
}

#[derive(Serialize)]
struct PaginatedResponse<T: Serialize> {
    items: Vec<T>,
    total_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct Bookmark {
    name: String,
    target_change_id: String,
    target_commit_id: String,
    is_tracking_remote: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct Change {
    change_id: String,
    commit_id: String,
    parent_commit_id: String,
    description: String,
    author_name: String,
    author_email: String,
    timestamp: String,
    has_conflict: bool,
    is_empty: bool,
    parent_change_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct SplitChangeResult {
    original: Change,
    split: Change,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct ChangeDiff {
    change_id: String,
    file_diffs: Vec<FileDiff>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct FileDiff {
    path: String,
    change_type: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct RevisionFileDiff {
    path: String,
    change_type: String,
    is_binary: bool,
    too_large: bool,
    old_content: String,
    new_content: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct RevisionChangeDiff {
    change_id: String,
    file_diffs: Vec<RevisionFileDiff>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RevisionDiffContent {
    content: String,
    is_binary: bool,
    too_large: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct ChangeFile {
    path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct TreeEntry {
    path: String,
    kind: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct Conflict {
    file_path: String,
    conflict_type: String,
    base_content: Option<String>,
    left_content: Option<String>,
    right_content: Option<String>,
    hunks: Option<String>,
    resolution_status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct FileContent {
    path: String,
    /// UTF-8 text when `encoding == "utf8"`, standard base64 of the raw blob
    /// bytes when `encoding == "base64"`. Binary blobs must never go through a
    /// lossy UTF-8 conversion: that silently corrupts the bytes we claim to
    /// return.
    content: String,
    encoding: String,
    /// True when the blob exceeds `MAX_BLOB_READ_BYTES`; `content` is empty.
    too_large: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct LandRequest {
    change_ids: Vec<String>,
    target_bookmark: String,
    #[serde(default)]
    expected_commit_id: Option<String>,
    #[serde(default)]
    operation_key: String,
    #[serde(default)]
    lookup_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    append: Option<LandAppend>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LandAppend {
    source_commit_id: String,
    source_base_commit_id: String,
    description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct LandResult {
    landed_count: usize,
    target_bookmark: String,
    target_commit_id: String,
}

/// One member repository pinned inside an organization superproject: the
/// gitlink at `path` points at `commit_id` in the member repository.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct SuperprojectMember {
    path: String,
    commit_id: String,
}

/// Request body for [`smithers_compose_superproject`]. Members override the
/// gitlinks inherited from the parent commit; unlisted members keep the
/// parent's pin. The commit is written on top of `parent_change_id` when set,
/// otherwise on top of the current `bookmark` head (or the root commit when the
/// bookmark does not exist yet). The bookmark itself is never moved here;
/// landing does that.
#[derive(Debug, Clone, Deserialize)]
struct ComposeSuperprojectRequest {
    members: Vec<SuperprojectMember>,
    #[serde(default)]
    bookmark: String,
    #[serde(default)]
    parent_change_id: String,
    #[serde(default)]
    description: String,
}

/// A superproject commit: the change identity plus the full member vector it
/// pins. This is the cross-repository changeset as stored on repo-host.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct SuperprojectCommit {
    change_id: String,
    commit_id: String,
    parent_commit_ids: Vec<String>,
    description: String,
    members: Vec<SuperprojectMember>,
}

const GITMODULES_PATH: &str = ".gitmodules";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct Operation {
    operation_id: String,
    description: String,
    timestamp: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct SnapshotResult {
    change_id: String,
    snapshot_path: String,
    file_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct StatusFile {
    path: String,
    status: String,
    /// Whether the change is staged. jj has no staging index, so working-copy
    /// changes are always part of the (auto-snapshotted) change; we report them
    /// as staged so the client renders a coherent two-pane view.
    staged: bool,
    add: u32,
    del: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct WorkingTreeStatus {
    backend: String,
    branch: String,
    head: String,
    changes: Vec<StatusFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct WikiCommitResult {
    commit_sha: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct WikiPageContent {
    content: String,
    commit_sha: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct WikiRevision {
    commit_sha: String,
    message: String,
    author: String,
    email: String,
    timestamp: String,
}

#[derive(Debug)]
enum JjError {
    NotFound(String),
    LandingReceiptMissing,
    BadRequest(String),
    UnprocessableEntity(String),
    Conflict(String),
    Internal(String),
}

#[derive(Debug)]
enum FfiError {
    WorkspaceSourceMissing,
    LandingReceiptMissing,
    InvalidArgument(String),
    BadRequest(String),
    NotFound(String),
    UnprocessableEntity(String),
    Conflict(String),
    Internal(String),
}

impl FfiError {
    fn code(&self) -> &'static str {
        match self {
            Self::LandingReceiptMissing => "landing_receipt_missing",
            Self::WorkspaceSourceMissing => "workspace_source_missing",
            Self::InvalidArgument(_) => "invalid_argument",
            Self::BadRequest(_) => "bad_request",
            Self::NotFound(_) => "not_found",
            Self::UnprocessableEntity(_) => "unprocessable_entity",
            Self::Conflict(_) => "conflict",
            Self::Internal(_) => "internal",
        }
    }

    fn message(&self) -> &str {
        match self {
            Self::LandingReceiptMissing => "landing receipt not found",
            Self::WorkspaceSourceMissing => "workspace source not retained",
            Self::InvalidArgument(msg)
            | Self::BadRequest(msg)
            | Self::NotFound(msg)
            | Self::UnprocessableEntity(msg)
            | Self::Conflict(msg)
            | Self::Internal(msg) => msg,
        }
    }
}

impl From<JjError> for FfiError {
    fn from(value: JjError) -> Self {
        match value {
            JjError::LandingReceiptMissing => Self::LandingReceiptMissing,
            JjError::BadRequest(msg) => Self::BadRequest(msg),
            JjError::NotFound(msg) => Self::NotFound(msg),
            JjError::UnprocessableEntity(msg) => Self::UnprocessableEntity(msg),
            JjError::Conflict(msg) => Self::Conflict(msg),
            JjError::Internal(msg) => Self::Internal(msg),
        }
    }
}

#[derive(Debug)]
struct RepoHandle {
    repo_path: PathBuf,
    repo: Arc<ReadonlyRepo>,
}

impl RepoHandle {
    fn open(path: &Path) -> Result<Self, JjError> {
        if !path.exists() {
            return Err(JjError::NotFound("repository not found".to_string()));
        }

        let settings = create_settings(&UserConfig::default());
        let repo = load_repo(path, &settings).map_err(map_load_error)?;
        Ok(Self {
            repo_path: path.to_path_buf(),
            repo,
        })
    }

    fn list_bookmarks_paginated(
        &self,
        offset: usize,
        per_page: usize,
    ) -> Result<(Vec<Bookmark>, usize), JjError> {
        // The view stores bookmarks in name order. Count references without
        // loading their commits; only requested targets need object reads.
        let names = || {
            self.repo
                .view()
                .local_bookmarks()
                .filter(|(_, target)| target.added_ids().next().is_some())
                .map(|(name, _)| name)
        };
        let total_count = names().count();
        let mut page = Vec::with_capacity(per_page.min(total_count));
        for name in names().skip(offset).take(per_page) {
            if let Some(bookmark) = self.get_bookmark(name.as_str())? {
                page.push(bookmark);
            }
        }
        Ok((page, total_count))
    }

    fn get_bookmark(&self, name: &str) -> Result<Option<Bookmark>, JjError> {
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err(JjError::BadRequest("bookmark name is required".to_string()));
        }

        let ref_name = RefName::new(trimmed_name);
        let target = self.repo.view().get_local_bookmark(ref_name);
        let Some(commit_id) = target.added_ids().next() else {
            return Ok(None);
        };
        let commit = self.repo.store().get_commit(commit_id).map_err(|err| {
            JjError::Internal(format!("failed to read bookmark target commit: {err}"))
        })?;
        let name_matcher = StringMatcher::Exact(trimmed_name.to_string());
        let is_tracking_remote = self
            .repo
            .view()
            .remote_bookmarks_matching(&name_matcher, &StringMatcher::All)
            .next()
            .is_some();

        Ok(Some(Bookmark {
            name: trimmed_name.to_string(),
            target_change_id: commit.change_id().reverse_hex(),
            target_commit_id: commit_id.hex(),
            is_tracking_remote,
        }))
    }

    fn create_bookmark_if_absent(
        &self,
        name: &str,
        target_change_id: &str,
    ) -> Result<Bookmark, JjError> {
        if let Some(bookmark) = self.get_bookmark(name)? {
            return Ok(bookmark);
        }
        self.create_bookmark(name, target_change_id)
    }

    fn create_bookmark(&self, name: &str, target_change_id: &str) -> Result<Bookmark, JjError> {
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err(JjError::BadRequest("bookmark name is required".to_string()));
        }

        let commit_id = resolve_change_or_commit_id(&self.repo, target_change_id)?;
        self.ensure_bookmark_moves_forward(trimmed_name, Some(&commit_id))?;

        let mut tx = self.repo.start_transaction();
        tx.repo_mut().set_local_bookmark_target(
            RefName::new(trimmed_name),
            RefTarget::normal(commit_id.clone()),
        );
        tx.commit(format!("create bookmark {trimmed_name}"))
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to commit bookmark creation: {err}"))
            })?;

        let commit =
            self.repo.store().get_commit(&commit_id).map_err(|err| {
                JjError::Internal(format!("failed to read bookmark commit: {err}"))
            })?;

        Ok(Bookmark {
            name: trimmed_name.to_string(),
            target_change_id: commit.change_id().reverse_hex(),
            target_commit_id: commit_id.hex(),
            is_tracking_remote: false,
        })
    }

    fn delete_bookmark(&self, name: &str) -> Result<(), JjError> {
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err(JjError::BadRequest("bookmark name is required".to_string()));
        }

        let ref_name = RefName::new(trimmed_name);
        if self.repo.view().get_local_bookmark(ref_name).is_absent() {
            return Err(JjError::NotFound("bookmark not found".to_string()));
        }
        self.ensure_bookmark_moves_forward(trimmed_name, None)?;

        let mut tx = self.repo.start_transaction();
        tx.repo_mut()
            .set_local_bookmark_target(ref_name, RefTarget::absent());
        tx.commit(format!("delete bookmark {trimmed_name}"))
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to commit bookmark deletion: {err}"))
            })?;
        Ok(())
    }

    fn get_change(&self, change_id: &str) -> Result<Change, JjError> {
        let commit_id = resolve_change_or_commit_id(&self.repo, change_id)?;
        let commit = self
            .repo
            .store()
            .get_commit(&commit_id)
            .map_err(|err| JjError::Internal(format!("failed to load commit: {err}")))?;

        Ok(change_from_commit(&self.repo, &commit))
    }

    /// Apply the inverse of `revision` on top of `target_bookmark`, producing
    /// a new, unbookmarked jj change. This is the repository-side primitive
    /// behind the product revert flow; the API service creates the review or
    /// cross-repository changeset that will land the returned change.
    /// Apply the inverse of `revision` on top of `target_bookmark`: the diff
    /// from its parents, or from `base` when given (a landing's previous
    /// head, so the whole range a landing brought in is reverted).
    fn backout_change(
        &self,
        change_id: &str,
        revision: &str,
        target_bookmark: &str,
        base: &str,
    ) -> Result<Change, JjError> {
        let expected_change_id = change_id.trim();
        if expected_change_id.is_empty() {
            return Err(JjError::BadRequest("change_id is required".to_string()));
        }
        let revision = revision.trim();
        if revision.is_empty() {
            return Err(JjError::BadRequest("revision is required".to_string()));
        }
        let bookmark = target_bookmark.trim();
        if bookmark.is_empty() {
            return Err(JjError::BadRequest(
                "target_bookmark is required".to_string(),
            ));
        }

        let reverted_id = resolve_change_or_commit_id(&self.repo, revision)?;
        let reverted = self.repo.store().get_commit(&reverted_id).map_err(|err| {
            JjError::Internal(format!("failed to load revision to revert: {err}"))
        })?;
        if reverted.change_id().reverse_hex() != expected_change_id {
            return Err(JjError::BadRequest(
                "revision does not belong to change_id".to_string(),
            ));
        }

        let destination_ids: Vec<_> = self
            .repo
            .view()
            .get_local_bookmark(RefName::new(bookmark))
            .added_ids()
            .cloned()
            .collect();
        let destination_id = match destination_ids.as_slice() {
            [] => {
                return Err(JjError::NotFound(format!(
                    "target bookmark not found: {bookmark}"
                )))
            }
            [id] => id.clone(),
            _ => {
                return Err(JjError::Conflict(format!(
                    "target bookmark is conflicted: {bookmark}"
                )))
            }
        };
        let destination = self
            .repo
            .store()
            .get_commit(&destination_id)
            .map_err(|err| {
                JjError::Internal(format!("failed to load revert destination: {err}"))
            })?;
        let base = base.trim();
        let reverted_parent_tree = if base.is_empty() {
            reverted
                .parent_tree(self.repo.as_ref())
                .block_on()
                .map_err(|err| {
                    JjError::Internal(format!("failed to load reverted revision parents: {err}"))
                })?
        } else {
            let base_id = resolve_change_or_commit_id(&self.repo, base)?;
            self.repo
                .store()
                .get_commit(&base_id)
                .map_err(|err| JjError::Internal(format!("failed to load revert base: {err}")))?
                .tree()
        };
        let new_tree = MergedTree::merge(Merge::from_vec(vec![
            (
                destination.tree(),
                format!("{bookmark} (revert destination)"),
            ),
            (
                reverted.tree(),
                format!("{} (reverted revision)", reverted.id().hex()),
            ),
            (
                reverted_parent_tree,
                format!("parents of {} (reverted revision)", reverted.id().hex()),
            ),
        ]))
        .block_on()
        .map_err(|err| JjError::Internal(format!("failed to apply reverse change: {err}")))?;

        let description = backout_description(&reverted);
        let mut tx = self.repo.start_transaction();
        let commit = tx
            .repo_mut()
            .new_commit(vec![destination_id], new_tree)
            .set_description(description)
            .write()
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to write reverting change: {err}")))?;
        tx.commit(format!("revert commit {}", reverted.id().hex()))
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to commit revert transaction: {err}"))
            })?;

        Ok(change_from_commit(&self.repo, &commit))
    }

    /// The append-only bookmarks: the default bookmark and `mythical`. Main
    /// is never rewritten, and only the stack service rewrites mythical, by
    /// pushing it. Fails closed: without a known default, main cannot be told
    /// apart.
    fn append_only_bookmarks(&self) -> Result<[String; 2], JjError> {
        let default = default_git_bookmark(&self.repo_path)?
            .ok_or_else(|| JjError::Conflict("the default bookmark cannot be read".to_string()))?;
        Ok([default, MYTHICAL_BOOKMARK.to_owned()])
    }

    /// Every commit a bookmark names; a conflicted bookmark names each side.
    fn bookmark_heads(&self, name: &str) -> Vec<CommitId> {
        let target = self.repo.view().get_local_bookmark(RefName::new(name));
        target
            .added_ids()
            .chain(target.removed_ids())
            .cloned()
            .collect()
    }

    /// The append-only bookmark whose history contains `commit`: the jj revset
    /// `::(default | mythical)` membership.
    fn append_only_history_containing(&self, commit: &CommitId) -> Result<Option<String>, JjError> {
        use jj_lib::revset::ResolvedRevsetExpression;
        for name in self.append_only_bookmarks()? {
            let heads = self.bookmark_heads(&name);
            if heads.is_empty() {
                continue;
            }
            let history = ResolvedRevsetExpression::commits(heads)
                .ancestors()
                .evaluate(self.repo.as_ref())
                .map_err(|err| JjError::Internal(err.to_string()))?;
            if history.containing_fn()(commit)
                .block_on()
                .map_err(|err| JjError::Internal(err.to_string()))?
            {
                return Ok(Some(name));
            }
        }
        Ok(None)
    }

    /// Every operation that rewrites an existing change calls this first.
    fn ensure_rewritable(&self, commit: &CommitId) -> Result<(), JjError> {
        match self.append_only_history_containing(commit)? {
            Some(bookmark) => Err(JjError::Conflict(format!(
                "the change is in {bookmark}'s history, which is never rewritten"
            ))),
            None => Ok(()),
        }
    }

    /// Every operation that sets or deletes a bookmark calls this first: an
    /// existing append-only bookmark moves only to a descendant (`target`
    /// None deletes it, which is refused).
    fn ensure_bookmark_moves_forward(
        &self,
        name: &str,
        target: Option<&CommitId>,
    ) -> Result<(), JjError> {
        let mut forward = true;
        for head in &self.bookmark_heads(name) {
            forward &= match target {
                Some(target) => self
                    .repo
                    .index()
                    .is_ancestor(head, target)
                    .block_on()
                    .map_err(|err| JjError::Internal(err.to_string()))?,
                None => false,
            };
        }
        // Only a rewind or deletion needs the default, so an unreadable one
        // refuses nothing else.
        if forward
            || !self
                .append_only_bookmarks()?
                .iter()
                .any(|kept| kept == name)
        {
            return Ok(());
        }
        Err(JjError::Conflict(format!(
            "{name} only moves forward; its history is never rewritten"
        )))
    }

    /// Move the selected paths' diff into a new parent change while preserving
    /// the stable change ID and remaining diff in a rewritten original change.
    fn split_change(
        &self,
        change_id: &str,
        paths: &[String],
        description: &str,
    ) -> Result<SplitChangeResult, JjError> {
        if paths.is_empty() {
            return Err(JjError::BadRequest("paths must not be empty".to_string()));
        }

        let mut selected_paths = HashSet::with_capacity(paths.len());
        for path in paths {
            if path.trim().is_empty() {
                return Err(JjError::BadRequest(
                    "paths must not contain empty values".to_string(),
                ));
            }
            let repo_path = RepoPathBuf::from_internal_string(path)
                .map_err(|_| JjError::BadRequest(format!("invalid path: {path}")))?;
            selected_paths.insert(repo_path);
        }

        let commit_id = resolve_change_id(&self.repo, change_id)?;
        self.ensure_rewritable(&commit_id)?;
        let original =
            self.repo.store().get_commit(&commit_id).map_err(|err| {
                JjError::Internal(format!("failed to load change to split: {err}"))
            })?;
        if original.has_conflict() {
            return Err(JjError::Conflict(
                "conflicted changes cannot be split".to_string(),
            ));
        }

        let parent_tree = original
            .parent_tree(self.repo.as_ref())
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to load split change parents: {err}"))
            })?;
        let parent_tree_id = parent_tree
            .tree_ids()
            .clone()
            .into_resolved()
            .map_err(|_| {
                JjError::Conflict("change parent tree has unresolved conflicts".to_string())
            })?
            .clone();
        let mut selected_tree_builder = TreeBuilder::new(self.repo.store().clone(), parent_tree_id);
        let entries =
            collect_tree_diff(parent_tree.diff_stream(&original.tree(), &EverythingMatcher));
        let mut matched = 0usize;
        for entry in entries {
            if !selected_paths.contains(&entry.path) {
                continue;
            }
            let values = entry.values.map_err(|err| {
                JjError::Internal(format!("failed to read split path diff: {err}"))
            })?;
            let after = values.after.as_resolved().ok_or_else(|| {
                JjError::Conflict("selected path has unresolved conflicts".to_string())
            })?;
            match after {
                Some(value) => selected_tree_builder.set(entry.path, value.clone()),
                None => selected_tree_builder.remove(entry.path),
            }
            matched += 1;
        }
        if matched == 0 {
            return Err(JjError::UnprocessableEntity(
                "no listed path is in the change".to_string(),
            ));
        }

        let selected_tree_id = selected_tree_builder
            .write_tree()
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to write split tree: {err}")))?;
        let selected_tree = MergedTree::resolved(self.repo.store().clone(), selected_tree_id);
        let original_tree = original.tree();
        let original_parent_ids = original.parent_ids().to_vec();

        let mut tx = self.repo.start_transaction();
        let split = tx
            .repo_mut()
            .new_commit(original_parent_ids, selected_tree)
            .set_author(original.author().clone())
            .set_description(description.trim())
            .write()
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to write split change: {err}")))?;
        let rewritten_original = tx
            .repo_mut()
            .rewrite_commit(&original)
            .set_parents(vec![split.id().clone()])
            .set_tree(original_tree)
            .write()
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to rewrite original change: {err}"))
            })?;
        tx.repo_mut()
            .rebase_descendants()
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to rebase split descendants: {err}"))
            })?;
        tx.commit(format!(
            "split change {}",
            original.change_id().reverse_hex()
        ))
        .block_on()
        .map_err(|err| JjError::Internal(format!("failed to commit split transaction: {err}")))?;

        Ok(SplitChangeResult {
            original: change_from_commit(&self.repo, &rewritten_original),
            split: change_from_commit(&self.repo, &split),
        })
    }

    fn get_diff(&self, change_id: &str) -> Result<ChangeDiff, JjError> {
        let commit_id = resolve_change_or_commit_id(&self.repo, change_id)?;
        let commit =
            self.repo.store().get_commit(&commit_id).map_err(|err| {
                JjError::Internal(format!("failed to load commit for diff: {err}"))
            })?;

        let parent_tree = parent_tree(&self.repo, &commit)
            .map_err(|err| JjError::Internal(format!("failed to load parent commit: {err}")))?;
        let entries =
            collect_tree_diff(parent_tree.diff_stream(&commit.tree(), &EverythingMatcher));

        let mut file_diffs = Vec::new();
        for entry in entries {
            let path = entry.path.as_internal_file_string().to_string();
            if let Ok(diff) = entry.values {
                let change_type = if diff.before.is_absent() {
                    "added"
                } else if diff.after.is_absent() {
                    "deleted"
                } else {
                    "modified"
                };

                file_diffs.push(FileDiff {
                    path,
                    change_type: change_type.to_string(),
                });
            }
        }

        Ok(ChangeDiff {
            change_id: commit.change_id().reverse_hex(),
            file_diffs,
        })
    }

    /// Compares an immutable revision to another revision of the same change.
    /// When `from_commit_id` is present, jj rebases that revision's tree onto
    /// the destination revision's parents before comparing it with the
    /// destination. A parent-only rebase therefore contributes no changed
    /// files. When it is absent, the destination is compared with its own
    /// parent, which is the "show at revision" view.
    fn get_revision_diff(
        &self,
        from_commit_id: Option<&str>,
        to_commit_id: &str,
        path: Option<&str>,
    ) -> Result<RevisionChangeDiff, JjError> {
        let to_id = resolve_commit_id(&self.repo, to_commit_id)?;
        let to_commit = self.repo.store().get_commit(&to_id).map_err(|err| {
            JjError::Internal(format!(
                "failed to load destination revision for diff: {err}"
            ))
        })?;

        let from_tree = if let Some(from_commit_id) = from_commit_id {
            let from_id = resolve_commit_id(&self.repo, from_commit_id)?;
            let from_commit = self.repo.store().get_commit(&from_id).map_err(|err| {
                JjError::Internal(format!("failed to load source revision for diff: {err}"))
            })?;
            jj_lib::rewrite::rebase_to_dest_parent(self.repo.as_ref(), &[from_commit], &to_commit)
                .block_on()
                .map_err(|err| {
                    JjError::Internal(format!("failed to rebase source revision for diff: {err}"))
                })?
        } else {
            parent_tree(&self.repo, &to_commit).map_err(|err| {
                JjError::Internal(format!("failed to load destination parent for diff: {err}"))
            })?
        };

        let path = path
            .filter(|path| !path.is_empty())
            .map(|path| {
                RepoPathBuf::from_internal_string(path)
                    .map_err(|_| JjError::BadRequest("invalid path".to_string()))
            })
            .transpose()?;
        let matcher: Box<dyn jj_lib::matchers::Matcher> = match path.as_ref() {
            Some(path) => Box::new(FilesMatcher::new([path])),
            None => Box::new(EverythingMatcher),
        };
        let entries = collect_tree_diff(from_tree.diff_stream(&to_commit.tree(), matcher.as_ref()));

        let mut file_diffs = Vec::with_capacity(entries.len());
        for entry in entries {
            let path = entry.path.as_internal_file_string().to_string();
            let values = entry.values.map_err(|err| {
                JjError::Internal(format!("failed to read revision tree diff: {err}"))
            })?;
            let change_type = if values.before.is_absent() {
                "added"
            } else if values.after.is_absent() {
                "deleted"
            } else {
                "modified"
            };
            let old =
                revision_diff_content(self.repo.store().as_ref(), &entry.path, &values.before)?;
            let new =
                revision_diff_content(self.repo.store().as_ref(), &entry.path, &values.after)?;

            file_diffs.push(RevisionFileDiff {
                path,
                change_type: change_type.to_string(),
                is_binary: old.is_binary || new.is_binary,
                too_large: old.too_large || new.too_large,
                old_content: old.content,
                new_content: new.content,
            });
        }

        Ok(RevisionChangeDiff {
            change_id: to_commit.change_id().reverse_hex(),
            file_diffs,
        })
    }

    fn list_files(&self, change_id: &str) -> Result<Vec<ChangeFile>, JjError> {
        let diff = self.get_diff(change_id)?;
        Ok(diff
            .file_diffs
            .into_iter()
            .map(|file| ChangeFile { path: file.path })
            .collect())
    }

    fn list_files_at_change(
        &self,
        change_id: &str,
        prefix: Option<&str>,
    ) -> Result<Vec<ChangeFile>, JjError> {
        let commit_id = resolve_change_or_commit_id(&self.repo, change_id)?;
        let commit = self.repo.store().get_commit(&commit_id).map_err(|err| {
            JjError::Internal(format!("failed to load commit for tree listing: {err}"))
        })?;

        let prefix = prefix
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.trim_matches('/').to_string());

        let mut files = Vec::new();
        for (path, value) in commit.tree().entries() {
            let path = path.as_internal_file_string().to_string();
            if let Some(prefix) = prefix.as_deref() {
                if path != prefix && !path.starts_with(&(prefix.to_string() + "/")) {
                    continue;
                }
            }

            let value = value
                .map_err(|err| JjError::Internal(format!("failed to read tree entry: {err}")))?;
            let Some(_) = value.as_resolved() else {
                return Err(JjError::Conflict(format!(
                    "cannot list unresolved conflict at {path}"
                )));
            };

            if files.len() == 10_000 {
                return Err(JjError::BadRequest(
                    "tree listing exceeds 10000 files".to_string(),
                ));
            }
            files.push(ChangeFile { path });
        }

        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    }

    /// One page of one directory level, read from the tree object at
    /// `prefix` without flattening the rest of the tree.
    fn list_directory(
        &self,
        change_id: &str,
        prefix: &str,
        after: &str,
        limit: u32,
    ) -> Result<Vec<TreeEntry>, JjError> {
        let prefix = prefix.trim_matches('/');
        let dir = RepoPathBuf::from_internal_string(prefix)
            .map_err(|_| JjError::BadRequest(format!("invalid path: {prefix}")))?;
        let commit_id = resolve_change_or_commit_id(&self.repo, change_id)?;
        let commit = self.repo.store().get_commit(&commit_id).map_err(|err| {
            JjError::Internal(format!("failed to load commit for tree listing: {err}"))
        })?;
        let trees = commit
            .tree()
            .trees()
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to read tree: {err}")))?;
        let Some(trees) = trees
            .sub_tree_recursive(&dir)
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to read tree: {err}")))?
        else {
            return Ok(Vec::new());
        };
        let same_change = self.repo.store().merge_options().same_change;
        let mut entries = Vec::new();
        for (name, values) in jj_lib::merged_tree::all_merged_tree_entries(&trees) {
            if entries.len() == limit as usize {
                break;
            }
            let path = dir.join(name).as_internal_file_string().to_string();
            if path.as_str() <= after {
                continue;
            }
            let kind = match values.resolve_trivial(same_change) {
                Some(None) => continue,
                Some(Some(TreeValue::Tree(_))) => "dir",
                Some(Some(_)) => "file",
                None if values
                    .iter()
                    .flatten()
                    .all(|value| matches!(value, TreeValue::Tree(_))) =>
                {
                    "dir"
                }
                None => {
                    return Err(JjError::Conflict(format!(
                        "cannot list unresolved conflict at {path}"
                    )))
                }
            };
            entries.push(TreeEntry { path, kind });
        }
        Ok(entries)
    }

    fn get_conflicts(&self, change_id: &str) -> Result<Vec<Conflict>, JjError> {
        let commit_id = resolve_change_or_commit_id(&self.repo, change_id)?;
        let commit = self.repo.store().get_commit(&commit_id).map_err(|err| {
            JjError::Internal(format!("failed to load commit for conflicts: {err}"))
        })?;

        let mut conflicts = Vec::new();
        let store = self.repo.store();
        for (path, value) in commit.tree().conflicts() {
            let Ok(merged_value) = value else {
                continue;
            };

            let base_content = read_tree_value_content(
                store.as_ref(),
                &path,
                merged_value.removes().next().and_then(|term| term.as_ref()),
            )?;
            let left_content = read_tree_value_content(
                store.as_ref(),
                &path,
                merged_value.adds().next().and_then(|term| term.as_ref()),
            )?;
            let right_content = read_tree_value_content(
                store.as_ref(),
                &path,
                merged_value.adds().nth(1).and_then(|term| term.as_ref()),
            )?;

            conflicts.push(Conflict {
                file_path: path.as_internal_file_string().to_string(),
                conflict_type: "content".to_string(),
                base_content,
                left_content,
                right_content,
                hunks: materialize_conflict_hunks(store.as_ref(), &path, &merged_value),
                resolution_status: "unresolved".to_string(),
            });
        }

        Ok(conflicts)
    }

    /// Collect the gitlink entries of a commit's tree as superproject members.
    fn superproject_members_of(
        &self,
        commit: &jj_lib::commit::Commit,
    ) -> Result<Vec<SuperprojectMember>, JjError> {
        let mut members = Vec::new();
        for (path, value) in commit.tree().entries() {
            let value = value.map_err(|err| {
                JjError::Internal(format!("failed to read superproject tree entry: {err}"))
            })?;
            let Some(resolved) = value.as_resolved() else {
                return Err(JjError::Conflict(format!(
                    "superproject has an unresolved conflict at {}",
                    path.as_internal_file_string()
                )));
            };
            if let Some(TreeValue::GitSubmodule(id)) = resolved {
                members.push(SuperprojectMember {
                    path: path.as_internal_file_string().to_string(),
                    commit_id: id.hex(),
                });
            }
        }
        members.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(members)
    }

    fn superproject_commit(
        &self,
        commit: &jj_lib::commit::Commit,
    ) -> Result<SuperprojectCommit, JjError> {
        Ok(SuperprojectCommit {
            change_id: commit.change_id().reverse_hex(),
            commit_id: commit.id().hex(),
            parent_commit_ids: commit.parent_ids().iter().map(|id| id.hex()).collect(),
            description: commit.description().to_string(),
            members: self.superproject_members_of(commit)?,
        })
    }

    fn read_superproject(&self, revision: &str) -> Result<SuperprojectCommit, JjError> {
        let commit_id = resolve_change_or_commit_id(&self.repo, revision)?;
        let commit = self.repo.store().get_commit(&commit_id).map_err(|err| {
            JjError::Internal(format!("failed to load superproject commit: {err}"))
        })?;
        self.superproject_commit(&commit)
    }

    /// Write one superproject commit whose tree holds a gitlink per member and
    /// a generated `.gitmodules`. Only the tree and the commit are written; the
    /// caller lands the change (moves the bookmark) separately.
    fn compose_superproject(
        &self,
        request: &ComposeSuperprojectRequest,
    ) -> Result<SuperprojectCommit, JjError> {
        if request.members.is_empty() {
            return Err(JjError::BadRequest("members is required".to_string()));
        }
        let mut overrides: Vec<(RepoPathBuf, CommitId)> = Vec::with_capacity(request.members.len());
        let mut seen = HashSet::new();
        for member in &request.members {
            let path = member.path.trim();
            if !is_valid_member_path(path) {
                return Err(JjError::BadRequest(format!(
                    "invalid superproject member path: {:?}",
                    member.path
                )));
            }
            if !seen.insert(path.to_string()) {
                return Err(JjError::BadRequest(format!(
                    "duplicate superproject member path: {path}"
                )));
            }
            let commit_hex = member.commit_id.trim();
            if commit_hex.len() != 40 {
                return Err(JjError::BadRequest(format!(
                    "member commit id for {path} must be a full 40-hex git commit id"
                )));
            }
            let commit_id = CommitId::try_from_hex(commit_hex).ok_or_else(|| {
                JjError::BadRequest(format!(
                    "invalid member commit id for {path}: {:?}",
                    member.commit_id
                ))
            })?;
            let repo_path = RepoPathBuf::from_internal_string(path)
                .map_err(|_| JjError::BadRequest(format!("invalid member path: {path}")))?;
            overrides.push((repo_path, commit_id));
        }

        let store = self.repo.store();
        let parent_id = if !request.parent_change_id.trim().is_empty() {
            resolve_change_or_commit_id(&self.repo, &request.parent_change_id)?
        } else if !request.bookmark.trim().is_empty() {
            self.repo
                .view()
                .get_local_bookmark(RefName::new(request.bookmark.trim()))
                .added_ids()
                .next()
                .cloned()
                .unwrap_or_else(|| store.root_commit_id().clone())
        } else {
            store.root_commit_id().clone()
        };
        let parent_commit = store.get_commit(&parent_id).map_err(|err| {
            JjError::Internal(format!("failed to load superproject parent commit: {err}"))
        })?;
        let parent_tree_id = parent_commit
            .tree()
            .tree_ids()
            .clone()
            .into_resolved()
            .map_err(|_| {
                JjError::Conflict("superproject parent tree has unresolved conflicts".to_string())
            })?
            .clone();

        // Inherited pins first, then the overrides, so `.gitmodules` lists the
        // full member vector the new commit will carry. Inherited gitlinks may
        // have been pushed outside this API, so they face the same validation:
        // re-emitting a hostile name would poison the generated `.gitmodules`.
        let mut members: Vec<SuperprojectMember> = self.superproject_members_of(&parent_commit)?;
        for member in &members {
            if !is_valid_member_path(&member.path) {
                return Err(JjError::BadRequest(format!(
                    "invalid inherited superproject member path: {:?}",
                    member.path
                )));
            }
        }
        for (repo_path, commit_id) in &overrides {
            let path = repo_path.as_internal_file_string().to_string();
            match members.iter_mut().find(|m| m.path == path) {
                Some(existing) => existing.commit_id = commit_id.hex(),
                None => members.push(SuperprojectMember {
                    path,
                    commit_id: commit_id.hex(),
                }),
            }
        }
        members.sort_by(|a, b| a.path.cmp(&b.path));

        let mut tree_builder = TreeBuilder::new(store.clone(), parent_tree_id);
        for (repo_path, commit_id) in overrides {
            tree_builder.set(repo_path, TreeValue::GitSubmodule(commit_id));
        }
        let gitmodules = render_gitmodules(&members);
        let gitmodules_path = RepoPathBuf::from_internal_string(GITMODULES_PATH)
            .map_err(|_| JjError::Internal("invalid .gitmodules path".to_string()))?;
        let mut body = gitmodules.as_bytes();
        let file_id = store
            .write_file(&gitmodules_path, &mut body)
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to write .gitmodules: {err}")))?;
        tree_builder.set(
            gitmodules_path,
            TreeValue::File {
                id: file_id,
                executable: false,
                copy_id: CopyId::placeholder(),
            },
        );
        let tree_id = tree_builder.write_tree().block_on().map_err(|err| {
            JjError::Internal(format!("failed to write superproject tree: {err}"))
        })?;
        let tree = jj_lib::merged_tree::MergedTree::resolved(store.clone(), tree_id);

        let description = if request.description.trim().is_empty() {
            format!("changeset: pin {} member(s)", members.len())
        } else {
            request.description.trim().to_string()
        };
        let mut tx = self.repo.start_transaction();
        let commit = tx
            .repo_mut()
            .new_commit(vec![parent_id], tree)
            .set_description(description)
            .write()
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to write superproject commit: {err}"))
            })?;
        tx.commit("compose superproject changeset")
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to commit superproject transaction: {err}"))
            })?;

        Ok(SuperprojectCommit {
            change_id: commit.change_id().reverse_hex(),
            commit_id: commit.id().hex(),
            parent_commit_ids: commit.parent_ids().iter().map(|id| id.hex()).collect(),
            description: commit.description().to_string(),
            members,
        })
    }

    fn land_changes(
        &self,
        change_ids: &[String],
        target_bookmark: &str,
    ) -> Result<LandResult, JjError> {
        self.land_request(&LandRequest {
            change_ids: change_ids.to_vec(),
            target_bookmark: target_bookmark.to_string(),
            ..Default::default()
        })
    }

    fn append_required_suffix(
        &self,
        current: &CommitId,
        append: &LandAppend,
        recorded_append_source: &Option<String>,
    ) -> Result<Vec<CommitId>, JjError> {
        let landed = CommitId::try_from_hex(&append.source_commit_id)
            .ok_or_else(|| JjError::BadRequest("invalid append source".into()))?;
        let current_commit = self
            .repo
            .store()
            .get_commit(current)
            .map_err(|e| JjError::Internal(e.to_string()))?;
        let mut base = self
            .repo
            .store()
            .get_commit(
                &CommitId::try_from_hex(&append.source_base_commit_id)
                    .expect("validated immutable commit"),
            )
            .map_err(|e| JjError::BadRequest(e.to_string()))?;
        if base.tree().has_conflict() || base.tree().tree_ids() != current_commit.tree().tree_ids()
        {
            return Err(JjError::Conflict(
                "append source base does not match the target tree".to_string(),
            ));
        }
        // Tree equality alone cannot authenticate the caller's starting
        // history: a forged base could include an unreviewed rewritten owner
        // and then revert its tree. Anchor it to the native main receipt.
        let anchor_id = match &recorded_append_source {
            Some(id) => CommitId::try_from_hex(id).ok_or_else(|| {
                JjError::Internal("native append receipt has an invalid source".into())
            })?,
            None => current.clone(),
        };
        let anchor = self
            .repo
            .store()
            .get_commit(&anchor_id)
            .map_err(|e| JjError::Internal(e.to_string()))?;
        if anchor.tree().tree_ids() != current_commit.tree().tree_ids() {
            return Err(JjError::Conflict(
                "native append anchor does not match main".into(),
            ));
        }
        // Clients may pin the public main revision. A previous append has a
        // distinct source-history anchor authenticated by its native receipt.
        // Continue from that anchor so subsequent appends include only new work.
        if base.id() == current {
            base = anchor.clone();
        }
        let mut anchored = false;
        let mut cursor = base.clone();
        for _ in 0..100_000 {
            if cursor.id() == &anchor_id {
                anchored = true;
                break;
            }
            if cursor.tree().tree_ids() != current_commit.tree().tree_ids() {
                break;
            }
            match cursor.parent_ids() {
                [parent] => {
                    cursor = self
                        .repo
                        .store()
                        .get_commit(parent)
                        .map_err(|e| JjError::Internal(e.to_string()))?
                }
                _ => break,
            }
        }
        // The caller cannot omit an earlier rewritten owner or a descendant.
        // The first shared immutable ancestor ends the complete new linear
        // suffix that must be reviewed, even when existing main has merges.
        let mut original_ancestors = std::collections::HashSet::new();
        // Authenticated main may contain Git merges. All of its ancestors are
        // already trusted; only the new suffix below must be linear.
        let mut pending = vec![base.id().clone()];
        while let Some(id) = pending.pop() {
            if original_ancestors.contains(&id) {
                continue;
            }
            if original_ancestors.len() >= 100_000 {
                return Err(JjError::BadRequest(
                    "append history exceeds 100000 commits".into(),
                ));
            }
            let commit = self
                .repo
                .store()
                .get_commit(&id)
                .map_err(|e| JjError::Internal(e.to_string()))?;
            original_ancestors.insert(id);
            pending.extend(commit.parent_ids().iter().cloned());
        }
        if !anchored {
            // First import of an independent mythical history has no trusted
            // mapping yet. Every current source commit must be reviewed.
            original_ancestors.clear();
            original_ancestors.insert(self.repo.store().root_commit_id().clone());
        }
        let mut required = Vec::new();
        let mut cursor = self
            .repo
            .store()
            .get_commit(&landed)
            .map_err(|e| JjError::Internal(e.to_string()))?;
        while !original_ancestors.contains(cursor.id()) {
            if required.len() >= 1024 {
                return Err(JjError::BadRequest(
                    "append rewritten suffix exceeds 1024 changes".into(),
                ));
            }
            required.push(cursor.id().clone());
            match cursor.parent_ids() {
                [parent] => {
                    cursor = self
                        .repo
                        .store()
                        .get_commit(parent)
                        .map_err(|e| JjError::Internal(e.to_string()))?
                }
                _ => {
                    return Err(JjError::Conflict(
                        "append source must share a linear immutable prefix with its source base"
                            .into(),
                    ))
                }
            }
        }
        required.reverse();
        Ok(required)
    }

    fn land_request(&self, request: &LandRequest) -> Result<LandResult, JjError> {
        let bookmark = request.target_bookmark.trim();
        if request.change_ids.is_empty() || bookmark.is_empty() {
            return Err(JjError::BadRequest(
                "change_ids and target_bookmark are required".to_string(),
            ));
        }
        if let Some(append) = &request.append {
            let immutable = |id: &str| {
                id.len() == 40
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            };
            if request.operation_key.is_empty()
                || !request.expected_commit_id.as_deref().is_some_and(immutable)
                || !immutable(&append.source_commit_id)
                || !immutable(&append.source_base_commit_id)
                || append.description.trim().is_empty()
                || append.description.len() > 32768
                || request.change_ids.len() > 1024
                || !request.change_ids.iter().all(|id| immutable(id))
            {
                return Err(JjError::BadRequest("append requires immutable commit IDs, an operation key, and a bounded description".to_string()));
            }
        }
        let mut canonical = request.clone();
        canonical.lookup_only = false;
        let request_json =
            serde_json::to_string(&canonical).map_err(|e| JjError::Internal(e.to_string()))?;
        let mut recorded_append_source: Option<String> = None;
        // The receipt lives in the very same jj operation as the bookmark move.
        // A crash between storage commit and HTTP/SQL acknowledgement is replayable.
        if !request.operation_key.is_empty() {
            let mut operations = Box::pin(op_walk::walk_ancestors(std::slice::from_ref(
                self.repo.operation(),
            )));
            while let Some(operation) = operations.next().block_on() {
                let operation = operation.map_err(|e| JjError::Internal(e.to_string()))?;
                let attrs = &operation.metadata().attributes;
                if request.append.is_some() {
                    if let (Some(saved_request), Some(saved_result)) = (
                        attrs.get("smithers.land.request"),
                        attrs.get("smithers.land.result"),
                    ) {
                        if let (Ok(saved_request), Ok(saved_result)) = (
                            serde_json::from_str::<LandRequest>(saved_request),
                            serde_json::from_str::<LandResult>(saved_result),
                        ) {
                            if let Some(saved_append) = saved_request.append {
                                if Some(saved_result.target_commit_id.as_str())
                                    == request.expected_commit_id.as_deref()
                                    && saved_result.target_bookmark == bookmark
                                    && saved_request.target_bookmark == bookmark
                                    && attrs.get("smithers.land.key")
                                        == Some(&saved_request.operation_key)
                                {
                                    if recorded_append_source
                                        .as_ref()
                                        .is_some_and(|id| id != &saved_append.source_commit_id)
                                    {
                                        return Err(JjError::Conflict(
                                            "target has ambiguous native append receipts".into(),
                                        ));
                                    }
                                    recorded_append_source = Some(saved_append.source_commit_id);
                                }
                            }
                        }
                    }
                }
                if attrs.get("smithers.land.key") == Some(&request.operation_key) {
                    if attrs.get("smithers.land.request") != Some(&request_json) {
                        return Err(JjError::Conflict(
                            "landing operation key was reused with different input".to_string(),
                        ));
                    }
                    return serde_json::from_str(attrs.get("smithers.land.result").ok_or_else(
                        || JjError::Internal("landing receipt is incomplete".to_string()),
                    )?)
                    .map_err(|e| JjError::Internal(e.to_string()));
                }
            }
        }
        if request.lookup_only {
            if request.append.is_some() {
                return Err(JjError::LandingReceiptMissing);
            }
            return Err(JjError::NotFound("landing receipt not found".to_string()));
        }
        let mut resolved = Vec::with_capacity(request.change_ids.len());
        for change in &request.change_ids {
            let id = resolve_change_or_commit_id(&self.repo, change)?;
            let commit = self
                .repo
                .store()
                .get_commit(&id)
                .map_err(|e| JjError::Internal(e.to_string()))?;
            if commit.tree().has_conflict() {
                return Err(JjError::Conflict(
                    "cannot land an unresolved conflict".to_string(),
                ));
            }
            resolved.push(id);
        }
        for pair in resolved.windows(2) {
            if request.append.is_none()
                && !self
                    .repo
                    .index()
                    .is_ancestor(&pair[0], &pair[1])
                    .block_on()
                    .map_err(|e| JjError::Internal(e.to_string()))?
            {
                return Err(JjError::Conflict(
                    "changes must form a stack in ancestor order".to_string(),
                ));
            }
        }
        let bookmark_name = RefName::new(bookmark);
        let target = self.repo.view().get_local_bookmark(bookmark_name);
        if target.has_conflict() {
            return Err(JjError::Conflict(
                "target bookmark is conflicted".to_string(),
            ));
        }
        let existing = target.as_normal().cloned();
        if let Some(expected) = &request.expected_commit_id {
            if existing.as_ref().map(|id| id.hex()).unwrap_or_default() != *expected {
                return Err(JjError::Conflict(
                    "target bookmark changed since landing was prepared".to_string(),
                ));
            }
        }
        let landed = resolved.last().unwrap().clone();
        let mut final_commit = landed.clone();
        let mut tx = self.repo.start_transaction();
        if let Some(append) = &request.append {
            if landed.hex() != append.source_commit_id {
                return Err(JjError::Conflict(
                    "append source is not the reviewed stack tip".to_string(),
                ));
            }
            let current = existing.ok_or_else(|| {
                JjError::Conflict("append target bookmark must exist".to_string())
            })?;
            let required =
                self.append_required_suffix(&current, append, &recorded_append_source)?;
            if required != resolved {
                return Err(JjError::Conflict("append requires the complete ordered current suffix after the shared immutable prefix".into()));
            }
            let source = self
                .repo
                .store()
                .get_commit(&landed)
                .map_err(|e| JjError::Internal(e.to_string()))?;
            let commit = tx
                .repo_mut()
                .new_commit(vec![current], source.tree())
                .set_description(&append.description)
                .write()
                .block_on()
                .map_err(|e| JjError::Internal(e.to_string()))?;
            final_commit = commit.id().clone();
        } else if let Some(current) = existing {
            if self
                .repo
                .index()
                .is_ancestor(&landed, &current)
                .block_on()
                .map_err(|e| JjError::Internal(e.to_string()))?
            {
                final_commit = current;
            } else if !self
                .repo
                .index()
                .is_ancestor(&current, &landed)
                .block_on()
                .map_err(|e| JjError::Internal(e.to_string()))?
            {
                let current_commit = self
                    .repo
                    .store()
                    .get_commit(&current)
                    .map_err(|e| JjError::Internal(e.to_string()))?;
                let landed_commit = self
                    .repo
                    .store()
                    .get_commit(&landed)
                    .map_err(|e| JjError::Internal(e.to_string()))?;
                let tree = jj_lib::rewrite::merge_commit_trees(
                    self.repo.as_ref(),
                    &[current_commit, landed_commit],
                )
                .block_on()
                .map_err(|e| JjError::Internal(e.to_string()))?;
                if tree.has_conflict() {
                    return Err(JjError::Conflict(
                        "landing produced merge conflicts".to_string(),
                    ));
                }
                let merged = tx
                    .repo_mut()
                    .new_commit(vec![current, landed], tree)
                    .set_description(format!(
                        "land {} change(s) into {bookmark}",
                        request.change_ids.len()
                    ))
                    .write()
                    .block_on()
                    .map_err(|e| JjError::Internal(e.to_string()))?;
                final_commit = merged.id().clone();
            }
        }
        tx.repo_mut()
            .set_local_bookmark_target(bookmark_name, RefTarget::normal(final_commit.clone()));
        let result = LandResult {
            landed_count: request.change_ids.len(),
            target_bookmark: bookmark.to_string(),
            target_commit_id: final_commit.hex(),
        };
        if !request.operation_key.is_empty() {
            tx.set_attribute(
                "smithers.land.key".to_string(),
                request.operation_key.clone(),
            );
            tx.set_attribute("smithers.land.request".to_string(), request_json);
            tx.set_attribute(
                "smithers.land.result".to_string(),
                serde_json::to_string(&result).map_err(|e| JjError::Internal(e.to_string()))?,
            );
        }
        tx.commit(format!("land {} change(s)", request.change_ids.len()))
            .block_on()
            .map_err(|e| JjError::Internal(e.to_string()))?;
        Ok(result)
    }

    fn list_operations_paginated(
        &self,
        offset: usize,
        per_page: usize,
    ) -> Result<(Vec<Operation>, usize), JjError> {
        let mut stream = Box::pin(op_walk::walk_ancestors(std::slice::from_ref(
            self.repo.operation(),
        )));
        let mut page = Vec::new();
        let mut total_count = 0;
        while let Some(op) = stream.next().block_on() {
            let op =
                op.map_err(|err| JjError::Internal(format!("failed to read operation: {err}")))?;
            if total_count >= offset && page.len() < per_page {
                page.push(Operation {
                    operation_id: op.id().hex(),
                    description: op.metadata().description.clone(),
                    timestamp: format_timestamp(&op.metadata().time.end),
                });
            }
            total_count += 1;
        }
        Ok((page, total_count))
    }

    fn list_changes_paginated(
        &self,
        offset: usize,
        per_page: usize,
    ) -> Result<(Vec<Change>, usize), JjError> {
        use jj_lib::revset::ResolvedRevsetExpression;
        // jj's index streams child-before-parent IDs. Only the requested page
        // loads commit objects and computes file/conflict metadata.
        let expression = ResolvedRevsetExpression::all().minus(&ResolvedRevsetExpression::root());
        let revset = expression
            .evaluate(self.repo.as_ref())
            .map_err(|e| JjError::Internal(e.to_string()))?;
        let (lower, upper) = revset
            .count_estimate()
            .map_err(|e| JjError::Internal(e.to_string()))?;
        let total = if upper == Some(lower) {
            lower
        } else {
            let mut count = 0;
            let mut ids = revset.stream();
            while let Some(id) = ids.next().block_on() {
                id.map_err(|e| JjError::Internal(e.to_string()))?;
                count += 1;
            }
            count
        };
        let mut ids = revset.stream().skip(offset).take(per_page);
        let mut changes = Vec::with_capacity(per_page.min(total));
        while let Some(id) = ids.next().block_on() {
            let id = id.map_err(|e| JjError::Internal(e.to_string()))?;
            let commit = self
                .repo
                .store()
                .get_commit(&id)
                .map_err(|e| JjError::Internal(e.to_string()))?;
            changes.push(change_from_commit(&self.repo, &commit));
        }
        Ok((changes, total))
    }

    fn get_file_content(&self, change_id: &str, path: &str) -> Result<FileContent, JjError> {
        if path.trim().is_empty() {
            return Err(JjError::BadRequest("path is required".to_string()));
        }

        let commit_id = resolve_change_or_commit_id(&self.repo, change_id)?;
        let commit = self.repo.store().get_commit(&commit_id).map_err(|err| {
            JjError::Internal(format!("failed to load commit for file read: {err}"))
        })?;

        let repo_path = RepoPathBuf::from_internal_string(path)
            .map_err(|_| JjError::BadRequest("invalid path".to_string()))?;

        let value = commit
            .tree()
            .path_value(&repo_path)
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to read tree path: {err}")))?;

        if let Some(Some(TreeValue::File { id, .. })) = value.as_resolved() {
            let Some(content) = read_file_content(
                self.repo.store().as_ref(),
                &repo_path,
                id,
                MAX_BLOB_READ_BYTES,
            )
            .map_err(|err| JjError::Internal(format!("failed to read file blob: {err}")))?
            else {
                return Ok(FileContent {
                    path: path.to_string(),
                    content: String::new(),
                    encoding: "utf8".to_string(),
                    too_large: true,
                });
            };
            let (content, encoding) = match String::from_utf8(content) {
                Ok(text) => (text, "utf8"),
                Err(err) => (BASE64_STANDARD.encode(err.as_bytes()), "base64"),
            };
            return Ok(FileContent {
                path: path.to_string(),
                content,
                encoding: encoding.to_string(),
                too_large: false,
            });
        }

        Err(JjError::NotFound("file not found in change".to_string()))
    }

    fn create_snapshot(&self, change_id: &str) -> Result<SnapshotResult, JjError> {
        let commit_id = resolve_change_or_commit_id(&self.repo, change_id)?;
        let commit = self.repo.store().get_commit(&commit_id).map_err(|err| {
            JjError::Internal(format!("failed to load commit for snapshot: {err}"))
        })?;

        let snapshot_root = self.repo_path.join(".smithers").join("snapshots");
        std::fs::create_dir_all(&snapshot_root)
            .map_err(|err| JjError::Internal(format!("failed to create snapshot root: {err}")))?;

        let snapshot_path = snapshot_root.join(commit.change_id().reverse_hex());
        reset_snapshot_dir(&snapshot_path)?;
        let file_count = tree_export::materialize(&commit.tree(), &snapshot_path, false)?;

        Ok(SnapshotResult {
            change_id: commit.change_id().reverse_hex(),
            snapshot_path: snapshot_path.display().to_string(),
            file_count,
        })
    }

    fn ensure_wiki_repo(repo_path: &Path) -> Result<bool, JjError> {
        if repo_path.exists() {
            let settings = create_settings(&UserConfig {
                name: "Smithers Wiki".to_string(),
                email: "wiki@smithers.sh".to_string(),
            });
            load_repo(repo_path, &settings).map_err(map_load_error)?;
            return Ok(false);
        }

        init_repo(repo_path)?;
        Ok(true)
    }

    fn ensure_docs_repo(repo_path: &Path) -> Result<bool, JjError> {
        if repo_path.exists() {
            let settings = create_settings(&UserConfig {
                name: "Smithers Docs".to_string(),
                email: "docs@smithers.sh".to_string(),
            });
            load_repo(repo_path, &settings).map_err(map_load_error)?;
            return Ok(false);
        }

        init_repo(repo_path)?;
        Ok(true)
    }

    fn commit_wiki_page(
        repo_path: &Path,
        page_name: &str,
        content: &str,
        author_name: &str,
        author_email: &str,
        message: &str,
    ) -> Result<WikiCommitResult, JjError> {
        let page_name = validate_wiki_page_name(page_name)?;
        let settings = create_settings(&UserConfig {
            name: normalize_author_name(author_name).to_string(),
            email: normalize_author_email(author_email).to_string(),
        });
        let (_, repo) = load_repo_at_head(repo_path, &settings).map_err(map_load_error)?;
        let wc_id = working_copy_commit_id(&repo)?;
        let store = repo.store();
        let parent_commit = store.get_commit(&wc_id).map_err(|err| {
            JjError::Internal(format!("failed to load wiki working-copy commit: {err}"))
        })?;
        let parent_tree_id = parent_commit
            .tree()
            .tree_ids()
            .clone()
            .into_resolved()
            .map_err(|_| {
                JjError::Conflict("wiki working-copy tree has unresolved conflicts".to_string())
            })?
            .clone();

        let file_path = RepoPathBuf::from_internal_string(&page_name)
            .map_err(|_| JjError::BadRequest("invalid wiki page name".to_string()))?;
        let mut tree_builder = TreeBuilder::new(store.clone(), parent_tree_id);
        let mut body = content.as_bytes();
        let file_id = store
            .write_file(&file_path, &mut body)
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to write wiki page content: {err}"))
            })?;
        tree_builder.set(
            file_path,
            TreeValue::File {
                id: file_id,
                executable: false,
                copy_id: CopyId::placeholder(),
            },
        );
        let tree_id = tree_builder
            .write_tree()
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to write wiki page tree: {err}")))?;
        let tree = jj_lib::merged_tree::MergedTree::resolved(store.clone(), tree_id);

        let mut tx = repo.start_transaction();
        let commit = tx
            .repo_mut()
            .new_commit(vec![wc_id], tree)
            .set_description(normalize_wiki_message(message, &page_name, "Update"))
            .write()
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to write wiki page commit: {err}")))?;
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), commit.id().clone())
            .map_err(|err| {
                JjError::Internal(format!("failed to update wiki working copy: {err}"))
            })?;
        tx.commit(format!("wiki commit {}", commit.id().hex()))
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to commit wiki transaction: {err}"))
            })?;

        Ok(WikiCommitResult {
            commit_sha: commit.id().hex(),
        })
    }

    fn get_wiki_page_content(
        repo_path: &Path,
        page_name: &str,
        commit_sha: Option<&str>,
    ) -> Result<WikiPageContent, JjError> {
        let page_name = validate_wiki_page_name(page_name)?;
        let settings = create_settings(&UserConfig {
            name: "Smithers Wiki".to_string(),
            email: "wiki@smithers.sh".to_string(),
        });
        let (_, repo) = load_repo_at_head(repo_path, &settings).map_err(map_load_error)?;
        let commit_id =
            if let Some(commit_sha) = commit_sha.map(str::trim).filter(|value| !value.is_empty()) {
                resolve_commit_id(&repo, commit_sha)?
            } else {
                working_copy_commit_id(&repo)?
            };
        let commit = repo
            .store()
            .get_commit(&commit_id)
            .map_err(|err| JjError::Internal(format!("failed to load wiki commit: {err}")))?;
        let file_path = RepoPathBuf::from_internal_string(&page_name)
            .map_err(|_| JjError::BadRequest("invalid wiki page name".to_string()))?;
        let value = commit
            .tree()
            .path_value(&file_path)
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to read wiki path: {err}")))?;

        if let Some(Some(TreeValue::File { id, .. })) = value.as_resolved() {
            let content =
                read_file_content(repo.store().as_ref(), &file_path, id, MAX_BLOB_READ_BYTES)
                    .map_err(|err| {
                        JjError::Internal(format!("failed to read wiki page blob: {err}"))
                    })?
                    .ok_or_else(|| {
                        JjError::BadRequest("wiki page is too large to return".to_string())
                    })?;
            return Ok(WikiPageContent {
                content: String::from_utf8_lossy(&content).to_string(),
                commit_sha: commit.id().hex(),
            });
        }

        Err(JjError::NotFound("wiki page not found".to_string()))
    }

    fn list_wiki_page_history(
        repo_path: &Path,
        page_name: &str,
        limit: usize,
    ) -> Result<Vec<WikiRevision>, JjError> {
        let page_name = validate_wiki_page_name(page_name)?;
        let settings = create_settings(&UserConfig {
            name: "Smithers Wiki".to_string(),
            email: "wiki@smithers.sh".to_string(),
        });
        let (_, repo) = load_repo_at_head(repo_path, &settings).map_err(map_load_error)?;
        let file_path = RepoPathBuf::from_internal_string(&page_name)
            .map_err(|_| JjError::BadRequest("invalid wiki page name".to_string()))?;
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        let mut revisions = Vec::new();

        for head_id in repo.view().heads() {
            queue.push_back(head_id.clone());
        }

        while let Some(commit_id) = queue.pop_front() {
            if !visited.insert(commit_id.clone()) {
                continue;
            }

            let commit = match repo.store().get_commit(&commit_id) {
                Ok(commit) => commit,
                Err(_) => continue,
            };

            for parent_id in commit.parent_ids() {
                queue.push_back(parent_id.clone());
            }

            if commit.parent_ids().is_empty() || !commit_touches_path(&repo, &commit, &file_path)? {
                continue;
            }

            let author = commit.author();
            revisions.push(WikiRevision {
                commit_sha: commit.id().hex(),
                message: commit.description().trim().to_string(),
                author: author.name.clone(),
                email: author.email.clone(),
                timestamp: format_timestamp(&author.timestamp),
            });
        }

        revisions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        if limit > 0 {
            revisions.truncate(limit);
        }
        if revisions.is_empty() {
            return Err(JjError::NotFound("wiki page not found".to_string()));
        }

        Ok(revisions)
    }

    fn delete_wiki_page(
        repo_path: &Path,
        page_name: &str,
        author_name: &str,
        author_email: &str,
    ) -> Result<(), JjError> {
        let page_name = validate_wiki_page_name(page_name)?;
        let settings = create_settings(&UserConfig {
            name: normalize_author_name(author_name).to_string(),
            email: normalize_author_email(author_email).to_string(),
        });
        let (_, repo) = load_repo_at_head(repo_path, &settings).map_err(map_load_error)?;
        let wc_id = working_copy_commit_id(&repo)?;
        let store = repo.store();
        let parent_commit = store.get_commit(&wc_id).map_err(|err| {
            JjError::Internal(format!("failed to load wiki working-copy commit: {err}"))
        })?;
        let parent_tree_id = parent_commit
            .tree()
            .tree_ids()
            .clone()
            .into_resolved()
            .map_err(|_| {
                JjError::Conflict("wiki working-copy tree has unresolved conflicts".to_string())
            })?
            .clone();

        let file_path = RepoPathBuf::from_internal_string(&page_name)
            .map_err(|_| JjError::BadRequest("invalid wiki page name".to_string()))?;
        let existing = parent_commit
            .tree()
            .path_value(&file_path)
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to inspect wiki page before delete: {err}"))
            })?;
        if existing
            .as_resolved()
            .and_then(|value| value.as_ref())
            .is_none()
        {
            return Err(JjError::NotFound("wiki page not found".to_string()));
        }

        let mut tree_builder = TreeBuilder::new(store.clone(), parent_tree_id);
        tree_builder.remove(file_path);
        let tree_id = tree_builder
            .write_tree()
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to write wiki delete tree: {err}")))?;
        let tree = jj_lib::merged_tree::MergedTree::resolved(store.clone(), tree_id);

        let mut tx = repo.start_transaction();
        let commit = tx
            .repo_mut()
            .new_commit(vec![wc_id], tree)
            .set_description(format!("Delete {page_name} page"))
            .write()
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to write wiki delete commit: {err}"))
            })?;
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), commit.id().clone())
            .map_err(|err| {
                JjError::Internal(format!("failed to update wiki working copy: {err}"))
            })?;
        tx.commit(format!("wiki delete {}", commit.id().hex()))
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to commit wiki delete transaction: {err}"))
            })?;

        Ok(())
    }

    fn commit_doc(
        repo_path: &Path,
        file_path: &str,
        content: &str,
        author_name: &str,
        author_email: &str,
        message: &str,
    ) -> Result<WikiCommitResult, JjError> {
        let file_path = validate_document_path(file_path)?;
        let settings = create_settings(&UserConfig {
            name: normalize_sidecar_author_name(author_name, "Smithers Docs").to_string(),
            email: normalize_sidecar_author_email(author_email, "docs@smithers.sh").to_string(),
        });
        let (_, repo) = load_repo_at_head(repo_path, &settings).map_err(map_load_error)?;
        let wc_id = working_copy_commit_id(&repo)?;
        let store = repo.store();
        let parent_commit = store.get_commit(&wc_id).map_err(|err| {
            JjError::Internal(format!("failed to load docs working-copy commit: {err}"))
        })?;
        let parent_tree_id = parent_commit
            .tree()
            .tree_ids()
            .clone()
            .into_resolved()
            .map_err(|_| {
                JjError::Conflict("docs working-copy tree has unresolved conflicts".to_string())
            })?
            .clone();

        let repo_path = RepoPathBuf::from_internal_string(&file_path)
            .map_err(|_| JjError::BadRequest("invalid document path".to_string()))?;
        let mut tree_builder = TreeBuilder::new(store.clone(), parent_tree_id);
        let mut body = content.as_bytes();
        let file_id = store
            .write_file(&repo_path, &mut body)
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to write document content: {err}")))?;
        tree_builder.set(
            repo_path,
            TreeValue::File {
                id: file_id,
                executable: false,
                copy_id: CopyId::placeholder(),
            },
        );
        let tree_id = tree_builder
            .write_tree()
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to write document tree: {err}")))?;
        let tree = jj_lib::merged_tree::MergedTree::resolved(store.clone(), tree_id);

        let mut tx = repo.start_transaction();
        let commit = tx
            .repo_mut()
            .new_commit(vec![wc_id], tree)
            .set_description(normalize_document_message(message, &file_path, "Update"))
            .write()
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to write document commit: {err}")))?;
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), commit.id().clone())
            .map_err(|err| {
                JjError::Internal(format!("failed to update docs working copy: {err}"))
            })?;
        tx.commit(format!("docs commit {}", commit.id().hex()))
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to commit docs transaction: {err}"))
            })?;

        Ok(WikiCommitResult {
            commit_sha: commit.id().hex(),
        })
    }

    fn get_doc_content(
        repo_path: &Path,
        file_path: &str,
        commit_sha: Option<&str>,
    ) -> Result<WikiPageContent, JjError> {
        let file_path = validate_document_path(file_path)?;
        let settings = create_settings(&UserConfig {
            name: "Smithers Docs".to_string(),
            email: "docs@smithers.sh".to_string(),
        });
        let (_, repo) = load_repo_at_head(repo_path, &settings).map_err(map_load_error)?;
        let commit_id =
            if let Some(commit_sha) = commit_sha.map(str::trim).filter(|value| !value.is_empty()) {
                resolve_commit_id(&repo, commit_sha)?
            } else {
                working_copy_commit_id(&repo)?
            };
        let commit = repo
            .store()
            .get_commit(&commit_id)
            .map_err(|err| JjError::Internal(format!("failed to load document commit: {err}")))?;
        let repo_path = RepoPathBuf::from_internal_string(&file_path)
            .map_err(|_| JjError::BadRequest("invalid document path".to_string()))?;
        let value = commit
            .tree()
            .path_value(&repo_path)
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to read document path: {err}")))?;

        if let Some(Some(TreeValue::File { id, .. })) = value.as_resolved() {
            let content =
                read_file_content(repo.store().as_ref(), &repo_path, id, MAX_BLOB_READ_BYTES)
                    .map_err(|err| {
                        JjError::Internal(format!("failed to read document blob: {err}"))
                    })?
                    .ok_or_else(|| {
                        JjError::BadRequest("document is too large to return".to_string())
                    })?;
            return Ok(WikiPageContent {
                content: String::from_utf8_lossy(&content).to_string(),
                commit_sha: commit.id().hex(),
            });
        }

        Err(JjError::NotFound("document not found".to_string()))
    }

    fn list_doc_history(
        repo_path: &Path,
        file_path: &str,
        limit: usize,
    ) -> Result<Vec<WikiRevision>, JjError> {
        let file_path = validate_document_path(file_path)?;
        let settings = create_settings(&UserConfig {
            name: "Smithers Docs".to_string(),
            email: "docs@smithers.sh".to_string(),
        });
        let (_, repo) = load_repo_at_head(repo_path, &settings).map_err(map_load_error)?;
        let repo_path = RepoPathBuf::from_internal_string(&file_path)
            .map_err(|_| JjError::BadRequest("invalid document path".to_string()))?;
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        let mut revisions = Vec::new();

        for head_id in repo.view().heads() {
            queue.push_back(head_id.clone());
        }

        while let Some(commit_id) = queue.pop_front() {
            if !visited.insert(commit_id.clone()) {
                continue;
            }

            let commit = match repo.store().get_commit(&commit_id) {
                Ok(commit) => commit,
                Err(_) => continue,
            };

            for parent_id in commit.parent_ids() {
                queue.push_back(parent_id.clone());
            }

            if commit.parent_ids().is_empty() || !commit_touches_path(&repo, &commit, &repo_path)? {
                continue;
            }

            let author = commit.author();
            revisions.push(WikiRevision {
                commit_sha: commit.id().hex(),
                message: commit.description().trim().to_string(),
                author: author.name.clone(),
                email: author.email.clone(),
                timestamp: format_timestamp(&author.timestamp),
            });
        }

        revisions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        if limit > 0 {
            revisions.truncate(limit);
        }
        if revisions.is_empty() {
            return Err(JjError::NotFound("document not found".to_string()));
        }

        Ok(revisions)
    }

    fn delete_doc(
        repo_path: &Path,
        file_path: &str,
        author_name: &str,
        author_email: &str,
    ) -> Result<(), JjError> {
        let file_path = validate_document_path(file_path)?;
        let settings = create_settings(&UserConfig {
            name: normalize_sidecar_author_name(author_name, "Smithers Docs").to_string(),
            email: normalize_sidecar_author_email(author_email, "docs@smithers.sh").to_string(),
        });
        let (_, repo) = load_repo_at_head(repo_path, &settings).map_err(map_load_error)?;
        let wc_id = working_copy_commit_id(&repo)?;
        let store = repo.store();
        let parent_commit = store.get_commit(&wc_id).map_err(|err| {
            JjError::Internal(format!("failed to load docs working-copy commit: {err}"))
        })?;
        let parent_tree_id = parent_commit
            .tree()
            .tree_ids()
            .clone()
            .into_resolved()
            .map_err(|_| {
                JjError::Conflict("docs working-copy tree has unresolved conflicts".to_string())
            })?
            .clone();

        let repo_path = RepoPathBuf::from_internal_string(&file_path)
            .map_err(|_| JjError::BadRequest("invalid document path".to_string()))?;
        let existing = parent_commit
            .tree()
            .path_value(&repo_path)
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to inspect document before delete: {err}"))
            })?;
        if existing
            .as_resolved()
            .and_then(|value| value.as_ref())
            .is_none()
        {
            return Err(JjError::NotFound("document not found".to_string()));
        }

        let mut tree_builder = TreeBuilder::new(store.clone(), parent_tree_id);
        tree_builder.remove(repo_path);
        let tree_id = tree_builder.write_tree().block_on().map_err(|err| {
            JjError::Internal(format!("failed to write document delete tree: {err}"))
        })?;
        let tree = jj_lib::merged_tree::MergedTree::resolved(store.clone(), tree_id);

        let mut tx = repo.start_transaction();
        let commit = tx
            .repo_mut()
            .new_commit(vec![wc_id], tree)
            .set_description(normalize_document_message("", &file_path, "Delete"))
            .write()
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to write document delete commit: {err}"))
            })?;
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), commit.id().clone())
            .map_err(|err| {
                JjError::Internal(format!("failed to update docs working copy: {err}"))
            })?;
        tx.commit(format!("docs delete {}", commit.id().hex()))
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to commit docs delete transaction: {err}"))
            })?;

        Ok(())
    }
}

fn map_load_error(err: impl std::fmt::Display) -> JjError {
    let msg = err.to_string();
    if msg.contains("No such file")
        || msg.contains("not found")
        || msg.contains("failed to load workspace")
    {
        JjError::NotFound("repository not found".to_string())
    } else {
        JjError::Internal(msg)
    }
}

/// A member path becomes a gitlink entry and three lines of the generated
/// `.gitmodules` (section header, `path`, `url`). Restrict it to the
/// repository-name alphabet (`repoNameRegex` in the API service) so it can
/// never break out of the `[submodule "..."]` header or smuggle INI lines:
/// quotes and newlines close the section and inject attacker-chosen keys
/// (e.g. a replacement `url`) even without any `/` in the name.
fn is_valid_member_path(path: &str) -> bool {
    !path.is_empty()
        && path != GITMODULES_PATH
        && path
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// Render a `.gitmodules` file for the member vector. Relative URLs keep the
/// superproject cloneable from any host that serves sibling repositories at
/// `<owner>/<repo>` (Smithers git smart HTTP and GitHub both do).
fn render_gitmodules(members: &[SuperprojectMember]) -> String {
    let mut out = String::new();
    for member in members {
        out.push_str(&format!(
            "[submodule \"{path}\"]\n\tpath = {path}\n\turl = ../{path}\n",
            path = member.path
        ));
    }
    out
}

fn resolve_change_id(repo: &Arc<ReadonlyRepo>, change_id: &str) -> Result<CommitId, JjError> {
    let trimmed = change_id.trim();
    if trimmed.is_empty() {
        return Err(JjError::BadRequest("change_id is required".to_string()));
    }

    match core_resolve_change_id(repo, trimmed) {
        ChangeIdResolution::Found(commit_id) => Ok(commit_id),
        ChangeIdResolution::Ambiguous => Err(JjError::BadRequest(format!(
            "ambiguous change ID prefix: {trimmed}"
        ))),
        ChangeIdResolution::NotFound => Err(JjError::NotFound("change not found".to_string())),
    }
}

fn resolve_change_or_commit_id(
    repo: &Arc<ReadonlyRepo>,
    change_or_commit_id: &str,
) -> Result<CommitId, JjError> {
    let trimmed = change_or_commit_id.trim();
    if trimmed.is_empty() {
        return Err(JjError::BadRequest("change_id is required".to_string()));
    }

    match core_resolve_change_id(repo, trimmed) {
        ChangeIdResolution::Found(commit_id) => Ok(commit_id),
        ChangeIdResolution::Ambiguous => Err(JjError::BadRequest(format!(
            "ambiguous change ID prefix: {trimmed}"
        ))),
        ChangeIdResolution::NotFound => resolve_commit_id(repo, trimmed),
    }
}

// Keep revision diff transport bounded before it crosses the FFI boundary.
// The Go diff builder applies a stricter combined-file and request budget.
const MAX_REVISION_DIFF_BLOB_BYTES: u64 = 1 << 20;

fn revision_diff_content(
    store: &jj_lib::store::Store,
    path: &jj_lib::repo_path::RepoPath,
    value: &jj_lib::merge::MergedTreeValue,
) -> Result<RevisionDiffContent, JjError> {
    let Some(resolved) = value.as_resolved() else {
        return Ok(RevisionDiffContent {
            content: String::new(),
            is_binary: true,
            too_large: false,
        });
    };
    let Some(TreeValue::File { id, .. }) = resolved else {
        return Ok(RevisionDiffContent {
            content: String::new(),
            is_binary: resolved.is_some(),
            too_large: false,
        });
    };
    let Some(content) = read_file_content(store, path, id, MAX_REVISION_DIFF_BLOB_BYTES)
        .map_err(|err| JjError::Internal(format!("failed to read revision diff blob: {err}")))?
    else {
        return Ok(RevisionDiffContent {
            content: String::new(),
            is_binary: false,
            too_large: true,
        });
    };
    match String::from_utf8(content) {
        Ok(content) => Ok(RevisionDiffContent {
            content,
            is_binary: false,
            too_large: false,
        }),
        Err(_) => Ok(RevisionDiffContent {
            content: String::new(),
            is_binary: true,
            too_large: false,
        }),
    }
}

fn resolve_commit_id(repo: &Arc<ReadonlyRepo>, commit_id: &str) -> Result<CommitId, JjError> {
    let trimmed = commit_id.trim();
    if trimmed.is_empty() {
        return Err(JjError::BadRequest("commit_sha is required".to_string()));
    }

    // Notes refs are not jj bookmarks and their commits need not be indexed.
    // A full SHA identifies an object directly; prefixes still use the index.
    if trimmed.len() == 40 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        let id = CommitId::try_from_hex(trimmed).expect("validated full SHA");
        if repo.store().get_commit(&id).is_ok() {
            return Ok(id);
        }
    }

    // Full immutable IDs can address retained historical objects outside the
    // visible JJ index. Prefix resolution still requires the native index.
    if trimmed.len() == 40
        && trimmed
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        let id = CommitId::try_from_hex(trimmed).expect("validated commit ID");
        return repo
            .store()
            .get_commit(&id)
            .map(|_| id)
            .map_err(|_| JjError::NotFound("commit not found".into()));
    }
    match core_resolve_commit_id(repo, trimmed) {
        ChangeIdResolution::Found(commit_id) => Ok(commit_id),
        ChangeIdResolution::Ambiguous => Err(JjError::BadRequest(format!(
            "ambiguous commit SHA prefix: {trimmed}"
        ))),
        ChangeIdResolution::NotFound => Err(JjError::NotFound("commit not found".to_string())),
    }
}

fn working_copy_commit_id(repo: &Arc<ReadonlyRepo>) -> Result<CommitId, JjError> {
    repo.view()
        .get_wc_commit_id(WorkspaceName::DEFAULT)
        .cloned()
        .ok_or_else(|| JjError::Internal("working copy commit is missing".to_string()))
}

fn backout_description(commit: &jj_lib::commit::Commit) -> String {
    let change_id = commit.change_id().reverse_hex();
    let short_id = &change_id[..8.min(change_id.len())];
    let mut description = format!(
        "Revert {short_id}\n\nThis reverts commit {}.",
        commit.id().hex()
    );
    if let Some(trailers) = description_trailer_block(commit.description()) {
        description.push_str("\n\n");
        description.push_str(trailers);
    }
    description
}

// Preserve the original description's final git-trailer paragraph so issue
// and agent provenance links survive a product-level revert. A paragraph is
// considered a trailer block only when every non-empty line is `Token: value`.
fn description_trailer_block(description: &str) -> Option<&str> {
    let trimmed = description.trim_end();
    let block = trimmed
        .rsplit_once("\n\n")
        .map_or(trimmed, |(_, tail)| tail);
    if block.is_empty() {
        return None;
    }
    let is_trailer = block.lines().all(|line| {
        let Some((key, value)) = line.split_once(':') else {
            return false;
        };
        !key.is_empty()
            && !value.trim().is_empty()
            && key
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    });
    is_trailer.then_some(block)
}

fn change_from_commit(repo: &Arc<ReadonlyRepo>, commit: &jj_lib::commit::Commit) -> Change {
    let parent_commit_id = commit
        .parent_ids()
        .first()
        .map(|id| id.hex())
        .unwrap_or_default();
    let parent_change_ids = commit
        .parent_ids()
        .iter()
        .filter_map(|id| repo.store().get_commit(id).ok())
        .map(|commit| commit.change_id().reverse_hex())
        .collect();

    let author = commit.author();

    Change {
        change_id: commit.change_id().reverse_hex(),
        commit_id: commit.id().hex(),
        parent_commit_id,
        description: commit.description().trim().to_string(),
        author_name: author.name.clone(),
        author_email: author.email.clone(),
        timestamp: format_timestamp(&author.timestamp),
        has_conflict: commit.has_conflict(),
        is_empty: commit.is_empty(repo.as_ref()).block_on().unwrap_or(false),
        parent_change_ids,
    }
}

fn read_tree_value_content(
    store: &jj_lib::store::Store,
    path: &RepoPathBuf,
    value: Option<&TreeValue>,
) -> Result<Option<String>, JjError> {
    let Some(TreeValue::File { id, .. }) = value else {
        return Ok(None);
    };

    // A conflict side larger than the blob cap is omitted rather than buffered:
    // the conflict is still reported, just without inline content.
    let Some(content) = read_file_content(store, path, id, MAX_BLOB_READ_BYTES)
        .map_err(|err| JjError::Internal(format!("failed to read conflict file blob: {err}")))?
    else {
        return Ok(None);
    };
    Ok(Some(String::from_utf8_lossy(&content).to_string()))
}

fn materialize_conflict_hunks(
    store: &jj_lib::store::Store,
    path: &RepoPathBuf,
    merged_value: &jj_lib::merge::MergedTreeValue,
) -> Option<String> {
    let file_merge = merged_value.to_file_merge()?;
    // extract_as_single_hunk buffers every conflict side in memory with no
    // size limit, so verify each side fits the blob cap first and skip hunk
    // rendering when one does not.
    for file_id in file_merge.iter().flatten() {
        match read_file_content(store, path, file_id, MAX_BLOB_READ_BYTES) {
            Ok(Some(_)) => {}
            _ => return None,
        }
    }
    let contents = extract_as_single_hunk(&file_merge, store, path)
        .block_on()
        .ok()?;
    let options = ConflictMaterializeOptions {
        marker_style: ConflictMarkerStyle::Diff,
        marker_len: None,
        merge: store.merge_options().clone(),
    };

    Some(
        String::from_utf8_lossy(
            materialize_merge_result_to_bytes(&contents, &ConflictLabels::unlabeled(), &options)
                .as_ref(),
        )
        .to_string(),
    )
}

fn reset_snapshot_dir(snapshot_path: &Path) -> Result<(), JjError> {
    if snapshot_path.exists() {
        std::fs::remove_dir_all(snapshot_path)
            .map_err(|err| JjError::Internal(format!("failed to reset snapshot path: {err}")))?;
    }
    std::fs::create_dir_all(snapshot_path)
        .map_err(|err| JjError::Internal(format!("failed to create snapshot path: {err}")))?;
    Ok(())
}

fn commit_touches_path(
    repo: &Arc<ReadonlyRepo>,
    commit: &jj_lib::commit::Commit,
    path: &RepoPathBuf,
) -> Result<bool, JjError> {
    let parent_tree = parent_tree(repo, commit)
        .map_err(|err| JjError::Internal(format!("failed to load parent commit: {err}")))?;
    let path_string = path.as_internal_file_string();

    for entry in collect_tree_diff(parent_tree.diff_stream(&commit.tree(), &EverythingMatcher)) {
        if entry.path.as_internal_file_string() == path_string {
            return Ok(true);
        }
    }

    Ok(false)
}

fn validate_wiki_page_name(page_name: &str) -> Result<String, JjError> {
    let trimmed = page_name.trim();
    let starts_with_alnum = trimmed
        .chars()
        .next()
        .map(|c| c.is_alphanumeric())
        .unwrap_or(false);
    if trimmed.is_empty()
        || trimmed.len() > 255
        || !starts_with_alnum
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed == "."
        || trimmed == ".."
    {
        return Err(JjError::BadRequest("invalid wiki page name".to_string()));
    }

    Ok(trimmed.to_string())
}

fn validate_document_path(file_path: &str) -> Result<String, JjError> {
    let trimmed = file_path.trim().trim_matches('/');
    if trimmed.is_empty() || trimmed.len() > 1024 || trimmed.contains('\\') {
        return Err(JjError::BadRequest("invalid document path".to_string()));
    }

    let mut normalized = Vec::new();
    for segment in trimmed.split('/') {
        let clean = segment.trim();
        if clean.is_empty() || clean == "." || clean == ".." || clean.contains('\0') {
            return Err(JjError::BadRequest("invalid document path".to_string()));
        }
        normalized.push(clean);
    }

    Ok(normalized.join("/"))
}

fn normalize_author_name(author_name: &str) -> &str {
    normalize_sidecar_author_name(author_name, "Smithers Wiki")
}

fn normalize_sidecar_author_name<'a>(author_name: &'a str, fallback: &'a str) -> &'a str {
    let trimmed = author_name.trim();
    if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    }
}

fn normalize_author_email(author_email: &str) -> &str {
    normalize_sidecar_author_email(author_email, "wiki@smithers.sh")
}

fn normalize_sidecar_author_email<'a>(author_email: &'a str, fallback: &'a str) -> &'a str {
    let trimmed = author_email.trim();
    if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    }
}

fn normalize_wiki_message(message: &str, page_name: &str, action: &str) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        format!("{action} {page_name} page")
    } else {
        trimmed.to_string()
    }
}

fn normalize_document_message(message: &str, file_path: &str, action: &str) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        format!("{action} {file_path}")
    } else {
        trimmed.to_string()
    }
}

fn init_repo(repo_path: &Path) -> Result<(), JjError> {
    if let Some(parent) = repo_path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            JjError::Internal(format!(
                "failed to create parent repo directory {}: {err}",
                parent.display()
            ))
        })?;
    }

    if let Err(err) = std::fs::create_dir(repo_path) {
        if err.kind() == std::io::ErrorKind::AlreadyExists {
            return Err(JjError::Conflict("repository already exists".to_string()));
        }
        return Err(JjError::Internal(format!(
            "failed to create repo dir: {err}"
        )));
    }

    let settings = create_settings(&UserConfig::default());
    if let Err(err) =
        Workspace::init_internal_git(&settings, repo_path, gix::hash::Kind::Sha1).block_on()
    {
        let _ = std::fs::remove_dir_all(repo_path);
        return Err(JjError::Internal(format!(
            "failed to init jj workspace at {}: {err}",
            repo_path.display()
        )));
    }

    Ok(())
}

fn auto_init_repo(repo_path: &Path, bookmark_name: &str, repo_name: &str) -> Result<(), JjError> {
    let trimmed_bookmark = bookmark_name.trim();
    if trimmed_bookmark.is_empty() {
        return Err(JjError::BadRequest("bookmark name is required".to_string()));
    }

    init_repo(repo_path)?;

    // Everything below this point mutates a repository created by this call.
    // If any jj/git operation fails, remove the partial directory so a retry
    // does not fail forever with "repository already exists".
    let result: Result<(), JjError> = (|| {
        let settings = create_settings(&UserConfig::default());
        let (_, repo) = load_repo_at_head(repo_path, &settings).map_err(map_load_error)?;
        let wc_id = working_copy_commit_id(&repo)?;
        let store = repo.store();
        let parent_commit = store.get_commit(&wc_id).map_err(|err| {
            JjError::Internal(format!("failed to load working-copy commit: {err}"))
        })?;
        let parent_tree_id = parent_commit
            .tree()
            .tree_ids()
            .clone()
            .into_resolved()
            .map_err(|_| {
                JjError::Conflict("working-copy tree has unresolved conflicts".to_string())
            })?
            .clone();

        let readme_path = RepoPathBuf::from_internal_string("README.md")
            .map_err(|_| JjError::Internal("invalid README path".to_string()))?;
        let trimmed_repo_name = repo_name.trim();
        let readme_title = if trimmed_repo_name.is_empty() {
            repo_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("repository")
        } else {
            trimmed_repo_name
        };
        let readme_content = format!("# {readme_title}\n");
        let mut tree_builder = TreeBuilder::new(store.clone(), parent_tree_id);
        let mut body = readme_content.as_bytes();
        let file_id = store
            .write_file(&readme_path, &mut body)
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to write README content: {err}")))?;
        tree_builder.set(
            readme_path,
            TreeValue::File {
                id: file_id,
                executable: false,
                copy_id: CopyId::placeholder(),
            },
        );
        let tree_id = tree_builder
            .write_tree()
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to write README tree: {err}")))?;
        let tree = jj_lib::merged_tree::MergedTree::resolved(store.clone(), tree_id);

        let mut tx = repo.start_transaction();
        let commit = tx
            .repo_mut()
            .new_commit(vec![wc_id], tree)
            .set_description("Initial commit")
            .write()
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to write initial commit: {err}")))?;
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), commit.id().clone())
            .map_err(|err| JjError::Internal(format!("failed to update working copy: {err}")))?;
        tx.repo_mut().set_local_bookmark_target(
            RefName::new(trimmed_bookmark),
            RefTarget::normal(commit.id().clone()),
        );
        tx.commit(format!("auto init repo {}", commit.id().hex()))
            .block_on()
            .map_err(|err| {
                JjError::Internal(format!("failed to commit auto-init transaction: {err}"))
            })?;

        export_git_refs(repo_path)?;

        // jj exports local bookmarks as refs/heads/* but does not select a Git
        // default branch. The internal bare repository therefore keeps the
        // initializer's unborn HEAD (typically master), so upload-pack omits
        // both HEAD and the symref capability even though the requested
        // bookmark exists. Point HEAD at the auto-init bookmark after export so
        // every Git client checks out the README commit.
        persist_default_git_bookmark(repo_path, trimmed_bookmark)?;
        let git_head = repo_path.join(".jj/repo/store/git/HEAD");
        std::fs::write(&git_head, format!("ref: refs/heads/{trimmed_bookmark}\n")).map_err(
            |err| {
                JjError::Internal(format!(
                    "failed to set git HEAD to default bookmark {trimmed_bookmark}: {err}"
                ))
            },
        )?;

        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_dir_all(repo_path);
    }
    result
}

fn import_git_refs(repo_path: &Path) -> Result<(), JjError> {
    let handle = RepoHandle::open(repo_path)?;
    let mut tx = handle.repo.start_transaction();

    let import_options = GitImportOptions {
        abandon_unreachable_commits: true,
        record_synthetic_predecessors: false,
        remote_auto_track_bookmarks: HashMap::new(),
    };

    jj_lib::git::import_refs(tx.repo_mut(), &import_options)
        .block_on()
        .map_err(|err| JjError::Internal(format!("failed to import git refs: {err}")))?;

    // import_refs records abandoned commits when Git refs are deleted or
    // force-moved. jj transactions may not be committed while those rewrites
    // are still pending: Transaction::commit deliberately panics in that
    // state. Rebase any descendants before publishing the imported view so a
    // mirror refresh cannot leave Git updated while JJ remains stale.
    tx.repo_mut()
        .rebase_descendants()
        .block_on()
        .map_err(|err| {
            JjError::Internal(format!(
                "failed to rebase descendants after importing git refs: {err}"
            ))
        })?;

    if tx.repo().has_changes() {
        tx.commit("import git refs")
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to commit transaction: {err}")))?;
    }

    Ok(())
}

fn export_git_refs(repo_path: &Path) -> Result<(), JjError> {
    // jj exports its working-copy commit to Git HEAD as a detached OID. A
    // repository server needs HEAD to remain a symref to the chosen default
    // branch, or a fresh Git clone silently checks out the old working copy
    // after a landing. Keep the choice outside HEAD so a retry after a crash
    // between export and repair can restore it.
    let default_bookmark = default_git_bookmark(repo_path)?;
    let handle = RepoHandle::open(repo_path)?;
    let mut tx = handle.repo.start_transaction();

    let stats = jj_lib::git::export_refs(tx.repo_mut())
        .map_err(|err| JjError::Internal(format!("failed to export git refs: {err}")))?;

    // Commit before inspecting per-ref failures so refs that did export keep
    // their jj export-tracking state instead of being re-exported forever.
    if tx.repo().has_changes() {
        tx.commit("export git refs")
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to commit transaction: {err}")))?;
    }

    // export_refs reports refs it skipped (git-invalid name, conflicted state,
    // divergence with the git backend, ...) via stats rather than Err. Silently
    // ignoring them leaves jj advertising bookmarks that don't exist as git
    // refs, so clones/mirrors quietly miss branches. Surface them as an error.
    let failed: Vec<String> = stats
        .failed_bookmarks
        .iter()
        .chain(stats.failed_tags.iter())
        .map(|(symbol, reason)| format!("{symbol}: {reason}"))
        .collect();
    if let Some(bookmark) = default_bookmark {
        persist_default_git_bookmark(repo_path, &bookmark)?;
        let git_head = repo_path.join(".jj/repo/store/git/HEAD");
        std::fs::write(&git_head, format!("ref: refs/heads/{bookmark}\n"))
            .map_err(|err| JjError::Internal(format!("failed to restore git HEAD: {err}")))?;
    }

    if !failed.is_empty() {
        return Err(JjError::Internal(format!(
            "failed to export git refs: {}",
            failed.join("; ")
        )));
    }

    Ok(())
}

fn default_git_bookmark(repo_path: &Path) -> Result<Option<String>, JjError> {
    let git_dir = repo_path.join(".jj/repo/store/git");
    let marker = git_dir.join("smithers-default-bookmark");
    let saved = match std::fs::read_to_string(&marker) {
        Ok(value) => Some(value),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let head = std::fs::read_to_string(git_dir.join("HEAD"))
                .map_err(|err| JjError::Internal(format!("failed to read git HEAD: {err}")))?;
            head.strip_prefix("ref: refs/heads/")
                .map(str::to_owned)
                .or_else(|| {
                    // Older repositories have no marker and jj may already have
                    // detached HEAD. Git enumerates both loose and packed refs.
                    let output = std::process::Command::new("git")
                        .arg("--git-dir")
                        .arg(&git_dir)
                        .args(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"])
                        .output()
                        .ok()?;
                    if !output.status.success() {
                        return None;
                    }
                    let names = String::from_utf8(output.stdout).ok()?;
                    let branches: Vec<&str> = names.lines().collect();
                    (branches.len() == 1).then(|| branches[0].to_owned())
                })
        }
        Err(err) => {
            return Err(JjError::Internal(format!(
                "failed to read default bookmark: {err}"
            )))
        }
    };
    let Some(bookmark) = saved else {
        return Ok(None);
    };
    let bookmark = bookmark.trim_end_matches('\n').trim_end_matches('\r');
    if !valid_default_git_bookmark(bookmark) {
        return Err(JjError::Internal(
            "invalid default Git bookmark marker".to_string(),
        ));
    }
    Ok(Some(bookmark.to_owned()))
}

fn persist_default_git_bookmark(repo_path: &Path, bookmark: &str) -> Result<(), JjError> {
    if !valid_default_git_bookmark(bookmark) {
        return Err(JjError::BadRequest(
            "invalid default Git bookmark".to_string(),
        ));
    }
    let git_dir = repo_path.join(".jj/repo/store/git");
    let marker = git_dir.join("smithers-default-bookmark");
    let pending = git_dir.join("smithers-default-bookmark.pending");
    std::fs::write(&pending, format!("{bookmark}\n"))
        .and_then(|()| std::fs::rename(&pending, &marker))
        .map_err(|err| JjError::Internal(format!("failed to persist default Git bookmark: {err}")))
}

fn valid_default_git_bookmark(name: &str) -> bool {
    if name.is_empty()
        || name == "@"
        || name == "HEAD"
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.contains("..")
        || name.contains("@{")
    {
        return false;
    }
    for component in name.split('/') {
        if component.is_empty() || component.starts_with('.') || component.ends_with(".lock") {
            return false;
        }
    }
    !name
        .chars()
        .any(|ch| ch.is_control() || " ~^:?*[\\".contains(ch))
}

/// Classify a tree-diff entry into a working-tree status code, mirroring how
/// `jj status` / `git status` label paths.
fn status_code_from_diff(before_absent: bool, after_absent: bool) -> &'static str {
    if before_absent {
        "added"
    } else if after_absent {
        "deleted"
    } else {
        "modified"
    }
}

/// Count added/deleted lines between two blobs with a minimal LCS-free heuristic:
/// lines present only in the new content are additions, lines present only in the
/// old content are deletions. This matches the magnitude `git`/`jj` report closely
/// enough for the status dashboard's `+/-` badges without pulling in a diff crate.
fn line_delta(before: Option<&[u8]>, after: Option<&[u8]>) -> (u32, u32) {
    fn lines(bytes: Option<&[u8]>) -> Vec<&str> {
        match bytes {
            Some(b) => std::str::from_utf8(b)
                .ok()
                .map(|s| s.lines().collect())
                .unwrap_or_default(),
            None => Vec::new(),
        }
    }
    let before_lines = lines(before);
    let after_lines = lines(after);
    let mut before_counts: HashMap<&str, i64> = HashMap::new();
    for line in &before_lines {
        *before_counts.entry(line).or_default() += 1;
    }
    let mut after_counts: HashMap<&str, i64> = HashMap::new();
    for line in &after_lines {
        *after_counts.entry(line).or_default() += 1;
    }
    let mut add: u32 = 0;
    let mut del: u32 = 0;
    for (line, after_n) in &after_counts {
        let before_n = before_counts.get(line).copied().unwrap_or(0);
        if after_n > &before_n {
            add += (after_n - before_n) as u32;
        }
    }
    for (line, before_n) in &before_counts {
        let after_n = after_counts.get(line).copied().unwrap_or(0);
        if before_n > &after_n {
            del += (before_n - after_n) as u32;
        }
    }
    (add, del)
}

/// Read a tree value's blob if it is a regular file; symlinks/conflicts return
/// `None` (we still classify the path, just without a line delta).
fn diff_blob(
    store: &jj_lib::store::Store,
    path: &RepoPathBuf,
    value: &TreeValue,
) -> Option<Vec<u8>> {
    if let TreeValue::File { id, .. } = value {
        read_file_content(store, path, id, MAX_BLOB_READ_BYTES)
            .ok()
            .flatten()
    } else {
        None
    }
}

/// Compute the live working-tree status for a jj workspace.
///
/// Loads the workspace, snapshots the working copy (so on-disk edits are
/// reflected exactly like `jj status`), then diffs the snapshot tree against the
/// working-copy commit's parent. The snapshot lock is released WITHOUT `finish()`
/// so the call is read-only: it never persists a new working-copy operation.
///
/// Works for both pure-jj and git-colocated workspaces because every plue repo is
/// a jj workspace over an internal/colocated git backend — the `backend` field
/// reports which store backs it.
fn get_working_tree_status(repo_path: &Path) -> Result<WorkingTreeStatus, JjError> {
    if !repo_path.exists() {
        return Err(JjError::NotFound("repository not found".to_string()));
    }

    let settings = create_settings(&UserConfig::default());
    let mut workspace = Workspace::load(
        &settings,
        repo_path,
        &jj_lib::default_backend_factories::default_backend_factories(),
        &jj_lib::default_backend_factories::default_working_copy_factories(),
    )
    .map_err(map_load_error)?;

    let repo = workspace
        .repo_loader()
        .load_at_head()
        .block_on()
        .map_err(|err| JjError::Internal(format!("failed to load repo at head: {err}")))?;

    let wc_name = workspace.workspace_name().to_owned();
    let wc_commit_id = repo
        .view()
        .get_wc_commit_id(&wc_name)
        .cloned()
        .ok_or_else(|| JjError::Internal("working copy commit is missing".to_string()))?;
    let wc_commit = repo
        .store()
        .get_commit(&wc_commit_id)
        .map_err(|err| JjError::Internal(format!("failed to load working-copy commit: {err}")))?;

    // Backend detection: the store reports "git" for both internal and colocated
    // git backends; anything else is a native jj backend.
    let backend = repo
        .store()
        .backend_impl::<jj_lib::git_backend::GitBackend>()
        .map(|_| "git")
        .unwrap_or("jj");

    // Snapshot the working copy to capture on-disk edits. We take the lock,
    // snapshot, then drop the lock without finishing so the operation log is
    // untouched (read-only status).
    let new_tree = {
        let operation_id = repo.operation().id().clone();
        let mut locked_ws = workspace
            .start_working_copy_mutation()
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to lock working copy: {err}")))?;
        let options = SnapshotOptions {
            base_ignores: GitIgnoreFile::empty(),
            progress: None,
            start_tracking_matcher: &EverythingMatcher,
            force_tracking_matcher: &NothingMatcher,
            max_new_file_size: u64::MAX,
        };
        let (new_tree, _stats) = locked_ws
            .locked_wc()
            .snapshot(&options)
            .block_on()
            .map_err(|err| JjError::Internal(format!("failed to snapshot working copy: {err}")))?;
        // Release the lock without finish(): nothing is persisted.
        let _ = operation_id;
        new_tree
    };

    let parent_tree = parent_tree(&repo, &wc_commit)
        .map_err(|err| JjError::Internal(format!("failed to load parent tree: {err}")))?;

    let store = repo.store();
    let mut changes = Vec::new();
    for entry in collect_tree_diff(parent_tree.diff_stream(&new_tree, &EverythingMatcher)) {
        let path = entry.path.as_internal_file_string().to_string();
        let Ok(diff) = entry.values else { continue };
        let before = diff.before.as_resolved().and_then(|v| v.clone());
        let after = diff.after.as_resolved().and_then(|v| v.clone());
        let before_absent = before.is_none();
        let after_absent = after.is_none();
        if before_absent && after_absent {
            continue;
        }
        let before_blob = before
            .as_ref()
            .and_then(|v| diff_blob(store, &entry.path, v));
        let after_blob = after
            .as_ref()
            .and_then(|v| diff_blob(store, &entry.path, v));
        let (add, del) = line_delta(before_blob.as_deref(), after_blob.as_deref());
        changes.push(StatusFile {
            path,
            status: status_code_from_diff(before_absent, after_absent).to_string(),
            staged: true,
            add,
            del,
        });
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));

    // Branch: the local bookmark(s) pointing at the working-copy commit's parent
    // (the "checked out" branch), falling back to the WC change id.
    let head = wc_commit.change_id().reverse_hex()
        [..8.min(wc_commit.change_id().reverse_hex().len())]
        .to_string();
    let branch = current_branch(&repo, &wc_commit).unwrap_or_else(|| head.clone());

    Ok(WorkingTreeStatus {
        backend: backend.to_string(),
        branch,
        head,
        changes,
    })
}

/// Find the bookmark the working copy is "on": a local bookmark pointing at the
/// working-copy commit or its first parent. Mirrors how `jj` shows the current
/// branch in its status output.
fn current_branch(repo: &Arc<ReadonlyRepo>, wc_commit: &jj_lib::commit::Commit) -> Option<String> {
    let candidates: Vec<CommitId> = std::iter::once(wc_commit.id().clone())
        .chain(wc_commit.parent_ids().iter().cloned())
        .collect();
    let mut best: Option<String> = None;
    for (name, target) in repo.view().local_bookmarks() {
        for commit_id in target.added_ids() {
            if candidates.iter().any(|c| c == commit_id) {
                let name = name.as_str().to_string();
                // Prefer a bookmark on the parent (the branch we're working on)
                // but any match is better than the bare change id.
                if best.is_none() {
                    best = Some(name);
                }
            }
        }
    }
    best
}

fn json_ptr<T: Serialize>(value: &T) -> *mut c_char {
    match serde_json::to_string(value)
        .ok()
        .and_then(|json| CString::new(json).ok())
    {
        Some(cstr) => cstr.into_raw(),
        None => CString::new(
            serde_json::json!({
                "error": "failed to serialize response",
                "code": "internal",
            })
            .to_string(),
        )
        .expect("fallback JSON is valid")
        .into_raw(),
    }
}

fn error_ptr(err: FfiError) -> *mut c_char {
    json_ptr(&ErrorResponse {
        error: err.message().to_string(),
        code: err.code(),
    })
}

fn execute<T, F>(op: F) -> *mut c_char
where
    T: Serialize,
    F: FnOnce() -> Result<T, FfiError>,
{
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(op)) {
        Ok(Ok(value)) => json_ptr(&value),
        Ok(Err(err)) => error_ptr(err),
        Err(_) => error_ptr(FfiError::Internal("operation panicked".to_string())),
    }
}

fn parse_c_string(ptr: *const c_char, arg_name: &'static str) -> Result<String, FfiError> {
    if ptr.is_null() {
        return Err(FfiError::InvalidArgument(format!(
            "{arg_name} must not be null"
        )));
    }

    let value = unsafe {
        // SAFETY: the caller must pass a valid NUL-terminated C string.
        CStr::from_ptr(ptr)
    };

    value
        .to_str()
        .map(str::to_owned)
        .map_err(|_| FfiError::InvalidArgument(format!("{arg_name} must contain valid UTF-8")))
}

fn parse_optional_c_string(
    ptr: *const c_char,
    arg_name: &'static str,
) -> Result<Option<String>, FfiError> {
    if ptr.is_null() {
        return Ok(None);
    }
    parse_c_string(ptr, arg_name).map(Some)
}

fn normalize_repo_path(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    workspace_root_from_path(&path).unwrap_or(path)
}

fn workspace_root_from_path(path: &Path) -> Option<PathBuf> {
    if is_jj_workspace_root(path) {
        return Some(path.to_path_buf());
    }

    let file_name = path.file_name().and_then(|value| value.to_str());
    let parent = path.parent();
    let grandparent = parent.and_then(Path::parent);

    if file_name == Some(".jj") && path.join("repo").join("store").is_dir() {
        return parent.map(Path::to_path_buf);
    }

    if file_name == Some("repo")
        && parent
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            == Some(".jj")
        && path.join("store").is_dir()
    {
        return grandparent.map(Path::to_path_buf);
    }

    if is_jj_store_path(path) {
        return grandparent.and_then(Path::parent).map(Path::to_path_buf);
    }

    None
}

fn is_jj_workspace_root(path: &Path) -> bool {
    path.join(".jj").is_dir()
}

fn is_jj_store_path(path: &Path) -> bool {
    path.is_dir()
        && path.file_name().and_then(|value| value.to_str()) == Some("store")
        && path
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            == Some("repo")
        && path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            == Some(".jj")
}

fn resolve_repo_path_for_delete(path: &Path) -> Result<PathBuf, FfiError> {
    if !path.exists() {
        return Err(FfiError::NotFound("repository not found".to_string()));
    }

    let repo_path = normalize_repo_path(&path.display().to_string());
    let metadata = [".jj", ".jj/repo", ".jj/repo/store", ".jj/repo/store/git"];
    if metadata.iter().any(|part| {
        !std::fs::symlink_metadata(repo_path.join(part))
            .is_ok_and(|item| item.is_dir() && !item.file_type().is_symlink())
    }) || !repo_path.join(".jj/repo/store/git/HEAD").is_file()
    {
        return Err(FfiError::NotFound("not a jj repository".to_string()));
    }

    Ok(repo_path)
}

fn open_repo(store_path: *const c_char) -> Result<RepoHandle, FfiError> {
    let store_path = parse_c_string(store_path, "store_path")?;
    let repo_path = normalize_repo_path(&store_path);
    RepoHandle::open(&repo_path).map_err(FfiError::from)
}

fn parse_pagination(page: u32, per_page: u32) -> Result<(usize, usize), FfiError> {
    let page = match page {
        0 => return Err(FfiError::BadRequest("page must be at least 1".to_string())),
        value => value,
    };
    let per_page = match per_page {
        0 => {
            return Err(FfiError::BadRequest(
                "per_page must be at least 1".to_string(),
            ));
        }
        value if value > PAGINATION_MAX_PER_PAGE => {
            return Err(FfiError::BadRequest(format!(
                "per_page must not exceed {PAGINATION_MAX_PER_PAGE}"
            )));
        }
        value => value,
    };

    let offset = usize::try_from(page - 1)
        .ok()
        .and_then(|page| {
            usize::try_from(per_page)
                .ok()
                .and_then(|per_page| page.checked_mul(per_page))
        })
        .ok_or_else(|| FfiError::BadRequest("page/per_page combination overflows".to_string()))?;

    Ok((offset, per_page as usize))
}

fn remove_repo_dir(path: &Path) -> Result<(), FfiError> {
    let repo_path = resolve_repo_path_for_delete(path)?;
    std::fs::remove_dir_all(&repo_path)
        .map_err(|err| FfiError::Internal(format!("failed to delete repository: {err}")))?;
    Ok(())
}

/// Initialize a jj repository and return a JSON response string.
///
/// # Safety
/// - `store_path` may be NULL; NULL or invalid UTF-8 returns an error JSON
///   envelope.
/// - Any non-NULL `store_path` must point to a valid NUL-terminated C string
///   for the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_init_repo(store_path: *const c_char) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        let repo_path = normalize_repo_path(&store_path);
        init_repo(&repo_path).map_err(FfiError::from)?;
        Ok(InitRepoResponse {
            status: "ok",
            path: repo_path.display().to_string(),
        })
    })
}

/// Initialize a jj repository with an initial README commit and bookmark.
///
/// # Safety
/// - `store_path`, `bookmark_name`, and `repo_name` may be NULL; NULL or
///   invalid UTF-8 returns an error JSON envelope.
/// - Any non-NULL pointer must point to a valid NUL-terminated C string for
///   the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_auto_init_repo(
    store_path: *const c_char,
    bookmark_name: *const c_char,
    repo_name: *const c_char,
) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        let bookmark_name = parse_c_string(bookmark_name, "bookmark_name")?;
        let repo_name = parse_c_string(repo_name, "repo_name")?;
        let repo_path = normalize_repo_path(&store_path);
        auto_init_repo(&repo_path, &bookmark_name, &repo_name).map_err(FfiError::from)?;
        Ok(InitRepoResponse {
            status: "ok",
            path: repo_path.display().to_string(),
        })
    })
}

/// Delete a jj repository and return a JSON response string.
///
/// # Safety
/// - `store_path` may be NULL; NULL or invalid UTF-8 returns an error JSON
///   envelope.
/// - Any non-NULL `store_path` must point to a valid NUL-terminated C string
///   for the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_delete_repo(store_path: *const c_char) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        remove_repo_dir(Path::new(&store_path))?;
        Ok(StatusResponse { status: "ok" })
    })
}

/// Import Git refs into the jj repository and return a JSON response string.
///
/// # Safety
/// - `store_path` may be NULL; NULL or invalid UTF-8 returns an error JSON
///   envelope.
/// - Any non-NULL `store_path` must point to a valid NUL-terminated C string
///   for the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_import_git_refs(store_path: *const c_char) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        let repo_path = normalize_repo_path(&store_path);
        import_git_refs(&repo_path).map_err(FfiError::from)?;
        Ok(StatusResponse { status: "ok" })
    })
}

/// Export jj refs to Git and return a JSON response string.
///
/// # Safety
/// - `store_path` may be NULL; NULL or invalid UTF-8 returns an error JSON
///   envelope.
/// - Any non-NULL `store_path` must point to a valid NUL-terminated C string
///   for the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_export_git_refs(store_path: *const c_char) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        let repo_path = normalize_repo_path(&store_path);
        export_git_refs(&repo_path).map_err(FfiError::from)?;
        Ok(StatusResponse { status: "ok" })
    })
}

/// List changes and return a paginated JSON response string.
///
/// # Safety
/// - `store_path` may be NULL; NULL or invalid UTF-8 returns an error JSON
///   envelope.
/// - Any non-NULL `store_path` must point to a valid NUL-terminated C string
///   for the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_list_changes(
    store_path: *const c_char,
    page: u32,
    per_page: u32,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let (offset, per_page) = parse_pagination(page, per_page)?;
        let (items, total_count) = handle
            .list_changes_paginated(offset, per_page)
            .map_err(FfiError::from)?;
        Ok(PaginatedResponse { items, total_count })
    })
}

/// Fetch a single change and return a JSON response string.
///
/// # Safety
/// - `store_path` and `change_id` may be NULL; NULL or invalid UTF-8 returns
///   an error JSON envelope.
/// - Any non-NULL pointer must point to a valid NUL-terminated C string for
///   the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_get_change(
    store_path: *const c_char,
    change_id: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let change_id = parse_c_string(change_id, "change_id")?;
        handle.get_change(&change_id).map_err(FfiError::from)
    })
}

/// Create an unbookmarked change that reverses `revision` on top of the
/// current `target_bookmark` and return the generated change as JSON. A
/// non-empty `base` reverses the diff from `base` to `revision` instead of
/// the diff from `revision`'s parents. (Named for the `base` argument, so a
/// Go binary built for the older four-argument symbol fails to load.)
///
/// # Safety
/// - All pointers may be NULL; NULL or invalid UTF-8 returns an error JSON
///   envelope.
/// - Any non-NULL pointer must point to a valid NUL-terminated C string for
///   the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - Callers must serialize repository mutations.
#[no_mangle]
pub extern "C" fn smithers_backout_change_range(
    store_path: *const c_char,
    change_id: *const c_char,
    revision: *const c_char,
    target_bookmark: *const c_char,
    base: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let change_id = parse_c_string(change_id, "change_id")?;
        let revision = parse_c_string(revision, "revision")?;
        let target_bookmark = parse_c_string(target_bookmark, "target_bookmark")?;
        let base = parse_c_string(base, "base")?;
        handle
            .backout_change(&change_id, &revision, &target_bookmark, &base)
            .map_err(FfiError::from)
    })
}

/// Split selected paths out of a change and return both resulting changes.
///
/// `paths_json` must be a JSON array of repository-relative path strings. The
/// original stable change ID retains the unselected diff; a new parent change
/// receives the selected diff and optional description.
///
/// # Safety
/// - All pointers may be NULL; NULL or invalid UTF-8 returns an error JSON
///   envelope.
/// - Any non-NULL pointer must point to a valid NUL-terminated C string for
///   the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - Callers must serialize repository mutations.
#[no_mangle]
pub extern "C" fn smithers_split_change(
    store_path: *const c_char,
    change_id: *const c_char,
    paths_json: *const c_char,
    description: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let change_id = parse_c_string(change_id, "change_id")?;
        let paths_json = parse_c_string(paths_json, "paths_json")?;
        let description = parse_c_string(description, "description")?;
        let paths: Vec<String> = serde_json::from_str(&paths_json)
            .map_err(|err| FfiError::BadRequest(format!("invalid paths: {err}")))?;
        handle
            .split_change(&change_id, &paths, &description)
            .map_err(FfiError::from)
    })
}

/// Fetch a change diff and return a JSON response string.
///
/// # Safety
/// - `store_path` and `change_id` may be NULL; NULL or invalid UTF-8 returns
///   an error JSON envelope.
/// - Any non-NULL pointer must point to a valid NUL-terminated C string for
///   the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_get_diff(
    store_path: *const c_char,
    change_id: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let change_id = parse_c_string(change_id, "change_id")?;
        handle.get_diff(&change_id).map_err(FfiError::from)
    })
}

/// Fetch an immutable revision-to-revision interdiff and return JSON.
///
/// An empty or NULL `from_commit_id` compares `to_commit_id` with its parent.
/// Otherwise the source revision is rebased onto the destination revision's
/// parent before their trees are compared. `path` optionally selects one exact
/// repository path.
///
/// # Safety
/// - String pointers may be NULL only where documented and otherwise must be
///   valid NUL-terminated UTF-8 for the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - Callers must coordinate access to the repository path.
#[no_mangle]
pub extern "C" fn smithers_get_revision_diff(
    store_path: *const c_char,
    from_commit_id: *const c_char,
    to_commit_id: *const c_char,
    path: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let from_commit_id = parse_optional_c_string(from_commit_id, "from_commit_id")?
            .filter(|value| !value.trim().is_empty());
        let to_commit_id = parse_c_string(to_commit_id, "to_commit_id")?;
        let path = parse_optional_c_string(path, "path")?.filter(|value| !value.is_empty());
        handle
            .get_revision_diff(from_commit_id.as_deref(), &to_commit_id, path.as_deref())
            .map_err(FfiError::from)
    })
}

/// List files changed by a change and return a JSON response string.
///
/// # Safety
/// - `store_path` and `change_id` may be NULL; NULL or invalid UTF-8 returns
///   an error JSON envelope.
/// - Any non-NULL pointer must point to a valid NUL-terminated C string for
///   the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_get_files(
    store_path: *const c_char,
    change_id: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let change_id = parse_c_string(change_id, "change_id")?;
        handle.list_files(&change_id).map_err(FfiError::from)
    })
}

/// List files from the full tree at a change and return a JSON response string.
///
/// # Safety
/// - `store_path` and `change_id` may be NULL; NULL or invalid UTF-8 returns
///   an error JSON envelope.
/// - `prefix` may be NULL, in which case no prefix filter is applied.
/// - Any non-NULL pointer must point to a valid NUL-terminated C string for
///   the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_list_tree_files(
    store_path: *const c_char,
    change_id: *const c_char,
    prefix: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let change_id = parse_c_string(change_id, "change_id")?;
        let prefix = parse_optional_c_string(prefix, "prefix")?;
        handle
            .list_files_at_change(&change_id, prefix.as_deref())
            .map_err(FfiError::from)
    })
}

/// List one directory page at a change. The returned envelope is freed with
/// [`smithers_free_string`].
#[no_mangle]
pub extern "C" fn smithers_list_directory(
    store_path: *const c_char,
    change_id: *const c_char,
    prefix: *const c_char,
    after: *const c_char,
    limit: u32,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let change_id = parse_c_string(change_id, "change_id")?;
        let prefix = parse_c_string(prefix, "prefix")?;
        let after = parse_c_string(after, "after")?;
        handle
            .list_directory(&change_id, &prefix, &after, limit)
            .map_err(FfiError::from)
    })
}

/// Fetch change conflicts and return a JSON response string.
///
/// # Safety
/// - `store_path` and `change_id` may be NULL; NULL or invalid UTF-8 returns
///   an error JSON envelope.
/// - Any non-NULL pointer must point to a valid NUL-terminated C string for
///   the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_get_conflicts(
    store_path: *const c_char,
    change_id: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let change_id = parse_c_string(change_id, "change_id")?;
        handle.get_conflicts(&change_id).map_err(FfiError::from)
    })
}

/// Land a complete stack atomically, with optional compare-and-swap and a durable receipt.
///
/// # Safety
/// - Both pointers may be NULL; NULL or invalid UTF-8 returns an error envelope.
/// - Non-NULL pointers must reference NUL-terminated strings for the call.
/// - Free the returned pointer with [`smithers_free_string`] exactly once.
/// - The caller must serialize mutations of the same repository.
#[unsafe(no_mangle)]
pub extern "C" fn smithers_land_changes(
    store_path: *const c_char,
    request_json: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let json = parse_c_string(request_json, "request_json")?;
        let request: LandRequest = serde_json::from_str(&json)
            .map_err(|e| FfiError::from(JjError::BadRequest(e.to_string())))?;
        handle.land_request(&request).map_err(FfiError::from)
    })
}

/// Verify a retained original source through its native immutable ref.
#[unsafe(no_mangle)]
pub extern "C" fn smithers_read_workspace_source(
    store_path: *const c_char,
    request_json: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let json = parse_c_string(request_json, "request_json")?;
        let request = serde_json::from_str(&json)
            .map_err(|_| FfiError::BadRequest("invalid workspace source request".into()))?;
        workspace_source::read(&handle.repo, request)
    })
}

/// Append capability marker: older libraries cannot silently perform ordinary landing.
#[unsafe(no_mangle)]
pub extern "C" fn smithers_land_append(
    store_path: *const c_char,
    request_json: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let json = parse_c_string(request_json, "request_json")?;
        let request: LandRequest = serde_json::from_str(&json)
            .map_err(|e| FfiError::from(JjError::BadRequest(e.to_string())))?;
        if request.append.is_none() {
            return Err(FfiError::from(JjError::BadRequest(
                "append is required".to_string(),
            )));
        }
        handle.land_request(&request).map_err(FfiError::from)
    })
}

/// Land a change onto a bookmark and return a JSON response string.
///
/// # Safety
/// - `store_path`, `change_id`, and `target_bookmark` may be NULL; NULL or
///   invalid UTF-8 returns an error JSON envelope.
/// - Any non-NULL pointer must point to a valid NUL-terminated C string for
///   the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_land_change(
    store_path: *const c_char,
    change_id: *const c_char,
    target_bookmark: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let change_id = parse_c_string(change_id, "change_id")?;
        let target_bookmark = parse_c_string(target_bookmark, "target_bookmark")?;
        handle
            .land_changes(&[change_id], &target_bookmark)
            .map_err(FfiError::from)
    })
}

/// Compose one organization-superproject commit (a gitlink per member plus a
/// generated `.gitmodules`) and return it as JSON. The bookmark is not moved.
///
/// # Safety
/// - `store_path` and `request_json` may be NULL; NULL or invalid UTF-8
///   returns an error JSON envelope.
/// - Any non-NULL pointer must point to a valid NUL-terminated C string for
///   the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_compose_superproject(
    store_path: *const c_char,
    request_json: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let request_json = parse_c_string(request_json, "request_json")?;
        let request: ComposeSuperprojectRequest = serde_json::from_str(&request_json)
            .map_err(|err| FfiError::BadRequest(format!("invalid superproject request: {err}")))?;
        handle
            .compose_superproject(&request)
            .map_err(FfiError::from)
    })
}

/// Read the member vector pinned by a superproject commit (by change id or
/// commit id) and return it as JSON.
///
/// # Safety
/// - `store_path` and `revision` follow the same pointer and ownership contract
///   as [`smithers_compose_superproject`].
#[no_mangle]
pub extern "C" fn smithers_read_superproject(
    store_path: *const c_char,
    revision: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let revision = parse_c_string(revision, "revision")?;
        handle.read_superproject(&revision).map_err(FfiError::from)
    })
}

/// List bookmarks and return a paginated JSON response string.
///
/// # Safety
/// - `store_path` may be NULL; NULL or invalid UTF-8 returns an error JSON
///   envelope.
/// - Any non-NULL `store_path` must point to a valid NUL-terminated C string
///   for the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_list_bookmarks(
    store_path: *const c_char,
    page: u32,
    per_page: u32,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let (offset, per_page) = parse_pagination(page, per_page)?;
        let (items, total_count) = handle
            .list_bookmarks_paginated(offset, per_page)
            .map_err(FfiError::from)?;
        Ok(PaginatedResponse { items, total_count })
    })
}

/// Create a bookmark and return a JSON response string.
///
/// # Safety
/// - `store_path`, `name`, and `change_id` may be NULL; NULL or invalid UTF-8
///   returns an error JSON envelope.
/// - Any non-NULL pointer must point to a valid NUL-terminated C string for
///   the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_create_bookmark(
    store_path: *const c_char,
    name: *const c_char,
    change_id: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let name = parse_c_string(name, "name")?;
        let change_id = parse_c_string(change_id, "change_id")?;
        handle
            .create_bookmark(&name, &change_id)
            .map_err(FfiError::from)
    })
}

/// Return an existing bookmark without moving it, or create it when absent.
/// This performs a direct name lookup instead of enumerating every bookmark.
///
/// # Safety
/// - `store_path`, `name`, and `change_id` follow the same pointer and ownership
///   contract as [`smithers_create_bookmark`].
#[no_mangle]
pub extern "C" fn smithers_create_bookmark_if_absent(
    store_path: *const c_char,
    name: *const c_char,
    change_id: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let name = parse_c_string(name, "name")?;
        let change_id = parse_c_string(change_id, "change_id")?;
        handle
            .create_bookmark_if_absent(&name, &change_id)
            .map_err(FfiError::from)
    })
}

/// Delete a bookmark and return a JSON response string.
///
/// # Safety
/// - `store_path` and `name` may be NULL; NULL or invalid UTF-8 returns an
///   error JSON envelope.
/// - Any non-NULL pointer must point to a valid NUL-terminated C string for
///   the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_delete_bookmark(
    store_path: *const c_char,
    name: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let name = parse_c_string(name, "name")?;
        handle.delete_bookmark(&name).map_err(FfiError::from)?;
        Ok(StatusResponse { status: "ok" })
    })
}

/// Fetch file content at a change and return a JSON response string.
///
/// # Safety
/// - `store_path`, `change_id`, and `path` may be NULL; NULL or invalid UTF-8
///   returns an error JSON envelope.
/// - Any non-NULL pointer must point to a valid NUL-terminated C string for
///   the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_get_file_content(
    store_path: *const c_char,
    change_id: *const c_char,
    path: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let change_id = parse_c_string(change_id, "change_id")?;
        let path = parse_c_string(path, "path")?;
        handle
            .get_file_content(&change_id, &path)
            .map_err(FfiError::from)
    })
}

/// Create a snapshot for a change and return a JSON response string.
///
/// # Safety
/// - `store_path` and `change_id` may be NULL; NULL or invalid UTF-8 returns
///   an error JSON envelope.
/// - Any non-NULL pointer must point to a valid NUL-terminated C string for
///   the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_create_snapshot(
    store_path: *const c_char,
    change_id: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let change_id = parse_c_string(change_id, "change_id")?;
        handle.create_snapshot(&change_id).map_err(FfiError::from)
    })
}

/// List operations and return a paginated JSON response string.
///
/// # Safety
/// - `store_path` may be NULL; NULL or invalid UTF-8 returns an error JSON
///   envelope.
/// - Any non-NULL `store_path` must point to a valid NUL-terminated C string
///   for the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_list_operations(
    store_path: *const c_char,
    page: u32,
    per_page: u32,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(store_path)?;
        let (offset, per_page) = parse_pagination(page, per_page)?;
        let (items, total_count) = handle
            .list_operations_paginated(offset, per_page)
            .map_err(FfiError::from)?;
        Ok(PaginatedResponse { items, total_count })
    })
}

/// Initialize a wiki repository and return whether it was newly created.
///
/// # Safety
/// - `store_path` may be NULL; NULL or invalid UTF-8 returns an error JSON
///   envelope.
/// - Any non-NULL `store_path` must point to a valid NUL-terminated C string
///   for the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
#[no_mangle]
pub extern "C" fn smithers_init_wiki_repo(store_path: *const c_char) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        let created =
            RepoHandle::ensure_wiki_repo(Path::new(&store_path)).map_err(FfiError::from)?;
        Ok(serde_json::json!({ "created": created }))
    })
}

/// Initialize a docs repository and return whether it was newly created.
///
/// # Safety
/// - `store_path` may be NULL; NULL or invalid UTF-8 returns an error JSON
///   envelope.
/// - Any non-NULL `store_path` must point to a valid NUL-terminated C string
///   for the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
#[no_mangle]
pub extern "C" fn smithers_init_docs_repo(store_path: *const c_char) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        let created =
            RepoHandle::ensure_docs_repo(Path::new(&store_path)).map_err(FfiError::from)?;
        Ok(serde_json::json!({ "created": created }))
    })
}

/// Create or update a wiki page and return the resulting commit SHA.
///
/// # Safety
/// - All non-NULL pointers must point to valid NUL-terminated C strings for the
///   duration of the call.
/// - `message`, `author_name`, and `author_email` may be NULL.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
#[no_mangle]
pub extern "C" fn smithers_commit_wiki_page(
    store_path: *const c_char,
    page_name: *const c_char,
    content: *const c_char,
    author_name: *const c_char,
    author_email: *const c_char,
    message: *const c_char,
) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        let page_name = parse_c_string(page_name, "page_name")?;
        let content = parse_c_string(content, "content")?;
        let author_name = parse_optional_c_string(author_name, "author_name")?.unwrap_or_default();
        let author_email =
            parse_optional_c_string(author_email, "author_email")?.unwrap_or_default();
        let message = parse_optional_c_string(message, "message")?.unwrap_or_default();

        RepoHandle::commit_wiki_page(
            Path::new(&store_path),
            &page_name,
            &content,
            &author_name,
            &author_email,
            &message,
        )
        .map_err(FfiError::from)
    })
}

/// Project an accepted wiki revision. Caller serializes the sidecar write lock.
/// Both pointers must be valid NUL-terminated UTF-8 for the duration of the call.
#[no_mangle]
pub extern "C" fn smithers_project_wiki_revision(
    store_path: *const c_char,
    request_json: *const c_char,
) -> *mut c_char {
    execute(|| {
        let path = parse_c_string(store_path, "store_path")?;
        let json = parse_c_string(request_json, "request_json")?;
        if json.len() > 2 << 20 {
            return Err(FfiError::InvalidArgument("wiki revision too large".into()));
        }
        let request = serde_json::from_str(&json)
            .map_err(|_| FfiError::InvalidArgument("invalid wiki revision".into()))?;
        wiki_projection::project(Path::new(&path), request).map_err(FfiError::from)
    })
}

/// Merge or replace Markdown in a Yjs document, without opening a repository.
/// The Go wiki service owns authorization, persistence and revision ordering.
///
/// # Safety
/// `request_json` must reference a valid NUL-terminated UTF-8 string. Release
/// the returned JSON with [`smithers_free_string`] exactly once.
#[no_mangle]
pub extern "C" fn smithers_wiki_document(request_json: *const c_char) -> *mut c_char {
    execute(|| {
        let json = parse_c_string(request_json, "request_json")?;
        if json.len() > 13 * 1024 * 1024 {
            return Err(FfiError::InvalidArgument(
                "wiki document request is too large".into(),
            ));
        }
        let request = serde_json::from_str(&json)
            .map_err(|_| FfiError::InvalidArgument("invalid wiki document request".into()))?;
        wiki_document::execute(request)
    })
}

/// Create or update a docs-sidecar file and return the resulting commit SHA.
///
/// # Safety
/// - All non-NULL pointers must point to valid NUL-terminated C strings for the
///   duration of the call.
/// - `message`, `author_name`, and `author_email` may be NULL.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
#[no_mangle]
pub extern "C" fn smithers_commit_doc(
    store_path: *const c_char,
    file_path: *const c_char,
    content: *const c_char,
    author_name: *const c_char,
    author_email: *const c_char,
    message: *const c_char,
) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        let file_path = parse_c_string(file_path, "file_path")?;
        let content = parse_c_string(content, "content")?;
        let author_name = parse_optional_c_string(author_name, "author_name")?.unwrap_or_default();
        let author_email =
            parse_optional_c_string(author_email, "author_email")?.unwrap_or_default();
        let message = parse_optional_c_string(message, "message")?.unwrap_or_default();

        RepoHandle::commit_doc(
            Path::new(&store_path),
            &file_path,
            &content,
            &author_name,
            &author_email,
            &message,
        )
        .map_err(FfiError::from)
    })
}

/// Read wiki page content at the requested commit, or the working copy when the
/// commit SHA is omitted.
///
/// # Safety
/// - `store_path` and `page_name` may be NULL; NULL or invalid UTF-8 returns an
///   error JSON envelope.
/// - `commit_sha` may be NULL.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
#[no_mangle]
pub extern "C" fn smithers_get_wiki_page_content(
    store_path: *const c_char,
    page_name: *const c_char,
    commit_sha: *const c_char,
) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        let page_name = parse_c_string(page_name, "page_name")?;
        let commit_sha = parse_optional_c_string(commit_sha, "commit_sha")?;

        RepoHandle::get_wiki_page_content(Path::new(&store_path), &page_name, commit_sha.as_deref())
            .map_err(FfiError::from)
    })
}

/// Read docs-sidecar file content at the requested commit, or the working copy
/// when the commit SHA is omitted.
///
/// # Safety
/// - `store_path` and `file_path` may be NULL; NULL or invalid UTF-8 returns an
///   error JSON envelope.
/// - `commit_sha` may be NULL.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
#[no_mangle]
pub extern "C" fn smithers_get_doc_content(
    store_path: *const c_char,
    file_path: *const c_char,
    commit_sha: *const c_char,
) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        let file_path = parse_c_string(file_path, "file_path")?;
        let commit_sha = parse_optional_c_string(commit_sha, "commit_sha")?;

        RepoHandle::get_doc_content(Path::new(&store_path), &file_path, commit_sha.as_deref())
            .map_err(FfiError::from)
    })
}

/// List wiki page revisions.
///
/// # Safety
/// - `store_path` and `page_name` may be NULL; NULL or invalid UTF-8 returns an
///   error JSON envelope.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
#[no_mangle]
pub extern "C" fn smithers_list_wiki_page_history(
    store_path: *const c_char,
    page_name: *const c_char,
    limit: u32,
) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        let page_name = parse_c_string(page_name, "page_name")?;

        RepoHandle::list_wiki_page_history(Path::new(&store_path), &page_name, limit as usize)
            .map_err(FfiError::from)
    })
}

/// List docs-sidecar file revisions.
///
/// # Safety
/// - `store_path` and `file_path` may be NULL; NULL or invalid UTF-8 returns an
///   error JSON envelope.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
#[no_mangle]
pub extern "C" fn smithers_list_doc_history(
    store_path: *const c_char,
    file_path: *const c_char,
    limit: u32,
) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        let file_path = parse_c_string(file_path, "file_path")?;

        RepoHandle::list_doc_history(Path::new(&store_path), &file_path, limit as usize)
            .map_err(FfiError::from)
    })
}

/// Delete a wiki page.
///
/// # Safety
/// - `store_path` and `page_name` may be NULL; NULL or invalid UTF-8 returns an
///   error JSON envelope.
/// - `author_name` and `author_email` may be NULL.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
#[no_mangle]
pub extern "C" fn smithers_delete_wiki_page(
    store_path: *const c_char,
    page_name: *const c_char,
    author_name: *const c_char,
    author_email: *const c_char,
) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        let page_name = parse_c_string(page_name, "page_name")?;
        let author_name = parse_optional_c_string(author_name, "author_name")?.unwrap_or_default();
        let author_email =
            parse_optional_c_string(author_email, "author_email")?.unwrap_or_default();

        RepoHandle::delete_wiki_page(
            Path::new(&store_path),
            &page_name,
            &author_name,
            &author_email,
        )
        .map_err(FfiError::from)?;
        Ok(StatusResponse { status: "ok" })
    })
}

/// Delete a docs-sidecar file.
///
/// # Safety
/// - `store_path` and `file_path` may be NULL; NULL or invalid UTF-8 returns an
///   error JSON envelope.
/// - `author_name` and `author_email` may be NULL.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
#[no_mangle]
pub extern "C" fn smithers_delete_doc(
    store_path: *const c_char,
    file_path: *const c_char,
    author_name: *const c_char,
    author_email: *const c_char,
) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        let file_path = parse_c_string(file_path, "file_path")?;
        let author_name = parse_optional_c_string(author_name, "author_name")?.unwrap_or_default();
        let author_email =
            parse_optional_c_string(author_email, "author_email")?.unwrap_or_default();

        RepoHandle::delete_doc(
            Path::new(&store_path),
            &file_path,
            &author_name,
            &author_email,
        )
        .map_err(FfiError::from)?;
        Ok(StatusResponse { status: "ok" })
    })
}

/// Compute the live working-tree status (changed files + branch/head + backend)
/// for the repository at `store_path` and return a JSON `WorkingTreeStatus`.
///
/// # Safety
/// - `store_path` may be NULL; NULL or invalid UTF-8 returns an error JSON
///   envelope.
/// - Any non-NULL `store_path` must point to a valid NUL-terminated C string for
///   the duration of the call.
/// - The returned pointer is owned by the caller and must be freed with
///   [`smithers_free_string`] exactly once.
/// - The library does not synchronize concurrent mutations of the same
///   repository path; callers must provide that coordination.
#[no_mangle]
pub extern "C" fn smithers_get_working_tree_status(store_path: *const c_char) -> *mut c_char {
    execute(|| {
        let store_path = parse_c_string(store_path, "store_path")?;
        let repo_path = normalize_repo_path(&store_path);
        get_working_tree_status(&repo_path).map_err(FfiError::from)
    })
}

/// Free a string returned by another Smithers FFI export.
///
/// # Safety
/// - `ptr` may be NULL.
/// - Any non-NULL `ptr` must have been returned by this library via
///   `CString::into_raw`, must not already have been freed, and must be freed
///   exactly once with this function.
/// - Callers must not race multiple frees of the same pointer across threads.
#[no_mangle]
pub unsafe extern "C" fn smithers_free_string(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }

    // SAFETY: the pointer must have been allocated by `CString::into_raw`.
    unsafe {
        drop(CString::from_raw(ptr));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::jj_core::{create_settings, load_repo_at_head, UserConfig};
    use jj_lib::backend::{CopyId, TreeValue};
    use jj_lib::merged_tree::MergedTree;
    use jj_lib::ref_name::WorkspaceName;
    use jj_lib::repo::Repo;
    use jj_lib::repo_path::RepoPathBuf;
    use jj_lib::tree_builder::TreeBuilder;
    use serde_json::Value;
    use tempfile::TempDir;

    fn repo_path(tmp: &TempDir) -> PathBuf {
        tmp.path().join("alice").join("demo")
    }

    fn c_path(path: &Path) -> CString {
        CString::new(path.display().to_string()).expect("path CString")
    }

    fn c_string(value: &str) -> CString {
        CString::new(value).expect("string CString")
    }

    unsafe fn take_json(ptr: *mut c_char) -> Value {
        let text = CStr::from_ptr(ptr)
            .to_str()
            .expect("valid UTF-8")
            .to_string();
        unsafe { smithers_free_string(ptr) };
        serde_json::from_str(&text).expect("valid JSON")
    }

    fn current_change_id(repo_path: &Path) -> String {
        let settings = create_settings(&UserConfig::default());
        let (_, repo) = load_repo_at_head(repo_path, &settings).expect("load repo");
        let wc_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("wc commit id")
            .clone();
        repo.store()
            .get_commit(&wc_id)
            .expect("wc commit")
            .change_id()
            .reverse_hex()
    }

    fn current_commit_id(repo_path: &Path) -> String {
        let settings = create_settings(&UserConfig::default());
        let (_, repo) = load_repo_at_head(repo_path, &settings).expect("load repo");
        repo.view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("wc commit id")
            .hex()
    }

    fn create_commit_with_files<C: AsRef<[u8]>>(
        repo_path: &Path,
        description: &str,
        files: &[(&str, C)],
    ) -> String {
        let settings = create_settings(&UserConfig::default());
        let (_, repo) = load_repo_at_head(repo_path, &settings).expect("load repo");
        let store = repo.store();
        let wc_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("wc id")
            .clone();
        let parent_commit = store.get_commit(&wc_id).expect("parent commit");
        let parent_tree_id = parent_commit
            .tree()
            .tree_ids()
            .clone()
            .into_resolved()
            .expect("resolved tree")
            .clone();

        let mut tree_builder = TreeBuilder::new(store.clone(), parent_tree_id);
        for (path, content) in files {
            let path = RepoPathBuf::from_internal_string(*path).expect("valid path");
            let file_id = store
                .write_file(&path, &mut content.as_ref())
                .block_on()
                .expect("write file");
            tree_builder.set(
                path,
                TreeValue::File {
                    id: file_id,
                    executable: false,
                    copy_id: CopyId::placeholder(),
                },
            );
        }
        let tree = MergedTree::resolved(
            store.clone(),
            tree_builder.write_tree().block_on().expect("write tree"),
        );

        let mut tx = repo.start_transaction();
        let commit = tx
            .repo_mut()
            .new_commit(vec![wc_id], tree)
            .set_description(description)
            .write()
            .block_on()
            .expect("write commit");
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), commit.id().clone())
            .expect("set wc");
        let repo = tx.commit("test commit").block_on().expect("commit tx");

        let wc_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("wc id")
            .clone();
        repo.store()
            .get_commit(&wc_id)
            .expect("wc commit")
            .change_id()
            .reverse_hex()
    }

    /// Land `files` as a committed baseline, then leave an empty working-copy
    /// change (`@`) on top of it and materialize the baseline tree on disk.
    ///
    /// This reproduces the production shape that `smithers_get_working_tree_status`
    /// is queried against: a real checkout whose on-disk contents match the
    /// committed parent, with an empty `@` so a pristine working copy reports no
    /// changes (jj diffs `@` against its parent). On-disk edits made afterward
    /// then surface as the only working-tree changes.
    fn seed_committed_baseline_with_empty_wc(repo_path: &Path, files: &[(&str, &str)]) {
        // 1. Commit the baseline. This sets `@` to the baseline commit itself.
        create_commit_with_files(repo_path, "baseline", files);

        // 2. Add an empty child commit on top and make it the new `@`, so the
        //    working copy is a fresh empty change over the committed baseline.
        let settings = create_settings(&UserConfig::default());
        let (_, repo) = load_repo_at_head(repo_path, &settings).expect("reload repo");
        let baseline_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("baseline wc id")
            .clone();
        let baseline_commit = repo
            .store()
            .get_commit(&baseline_id)
            .expect("baseline commit");
        let baseline_tree = baseline_commit.tree();

        let mut tx = repo.start_transaction();
        let empty_wc = tx
            .repo_mut()
            .new_commit(vec![baseline_id], baseline_tree)
            .set_description("")
            .write()
            .block_on()
            .expect("write empty wc commit");
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), empty_wc.id().clone())
            .expect("set empty wc");
        tx.commit("test: empty working copy on baseline")
            .block_on()
            .expect("commit empty-wc tx");

        // 3. Materialize the baseline files on disk so the on-disk working copy is
        //    consistent with the committed tree (the snapshot will reconstruct the
        //    same tree, yielding a clean status).
        for (path, content) in files {
            let full = repo_path.join(path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).expect("create parent dirs");
            }
            std::fs::write(&full, content.as_bytes()).expect("materialize baseline file");
        }
    }

    #[test]
    fn export_git_refs_surfaces_refs_that_fail_git_export() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);
        let _ = unsafe { take_json(smithers_init_repo(repo_path_c.as_ptr())) };

        // Record a bookmark whose name jj accepts but git rejects, bypassing
        // the API-layer name validation the way corrupted/legacy state would.
        let settings = create_settings(&UserConfig::default());
        let (_, repo) = load_repo_at_head(&repo_path, &settings).expect("load repo");
        let wc_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("wc id")
            .clone();
        let mut tx = repo.start_transaction();
        tx.repo_mut()
            .set_local_bookmark_target(RefName::new("bad..name"), RefTarget::normal(wc_id));
        tx.commit("create git-invalid bookmark")
            .block_on()
            .expect("commit bookmark");
        persist_default_git_bookmark(&repo_path, "main").expect("save default bookmark");
        std::fs::write(
            repo_path.join(".jj/repo/store/git/HEAD"),
            "0000000000000000000000000000000000000000\n",
        )
        .expect("simulate detached HEAD");

        let err = export_git_refs(&repo_path).expect_err("export must surface the failed ref");
        match err {
            JjError::Internal(message) => assert!(
                message.contains("bad..name"),
                "error must name the failed ref: {message}"
            ),
            other => panic!("unexpected error variant: {other:?}"),
        }
        assert_eq!(
            std::fs::read_to_string(repo_path.join(".jj/repo/store/git/HEAD"))
                .expect("read restored HEAD"),
            "ref: refs/heads/main\n"
        );
    }

    #[test]
    fn legacy_detached_git_head_uses_sole_branch() {
        let tmp = TempDir::new().expect("tempdir");
        let path = repo_path(&tmp);
        auto_init_repo(&path, "main", "demo").expect("initialize repository");
        let git_dir = path.join(".jj/repo/store/git");
        std::fs::remove_file(git_dir.join("smithers-default-bookmark"))
            .expect("remove legacy marker");
        std::fs::write(
            git_dir.join("HEAD"),
            "0000000000000000000000000000000000000000\n",
        )
        .expect("detach HEAD");
        assert_eq!(
            default_git_bookmark(&path).expect("read default"),
            Some("main".to_owned())
        );
    }

    #[test]
    fn notes_tree_listing_is_bounded() {
        let tmp = TempDir::new().unwrap();
        let path = repo_path(&tmp);
        init_repo(&path).unwrap();
        let git = gix::open(path.join(".jj/repo/store/git")).unwrap();
        let blob = git.write_blob(b"story").unwrap().detach();
        let signature = gix::actor::SignatureRef::from_bytes(
            b"Librarian <librarian@example.com> 1711398853 +0000",
        )
        .unwrap();
        for count in [10_000, 10_001] {
            let tree = git
                .write_object(gix::objs::Tree {
                    entries: (0..count)
                        .map(|i| gix::objs::tree::Entry {
                            mode: gix::objs::tree::EntryKind::Blob.into(),
                            filename: format!("{i:040x}").into(),
                            oid: blob,
                        })
                        .collect(),
                })
                .unwrap()
                .detach();
            let id = git
                .commit_as(
                    signature,
                    signature,
                    format!("refs/notes/test-{count}"),
                    "notes",
                    tree,
                    std::iter::empty::<gix::ObjectId>(),
                )
                .unwrap()
                .detach();
            let handle = RepoHandle::open(&path).unwrap();
            let listing = handle.list_files_at_change(&id.to_string(), None);
            if count == 10_000 {
                assert_eq!(listing.unwrap().len(), count);
            } else {
                assert!(matches!(listing, Err(JjError::BadRequest(_))));
            }
            assert_eq!(
                handle
                    .get_file_content(&id.to_string(), &format!("{:040x}", count - 1))
                    .unwrap()
                    .content,
                "story"
            );
        }
    }

    #[test]
    fn directory_pages_read_one_level_of_a_tree_over_ten_thousand_files() {
        let tmp = TempDir::new().unwrap();
        let path = repo_path(&tmp);
        init_repo(&path).unwrap();
        let git = gix::open(path.join(".jj/repo/store/git")).unwrap();
        let blob = git.write_blob(b"x").unwrap().detach();
        let file = |name: String| gix::objs::tree::Entry {
            mode: gix::objs::tree::EntryKind::Blob.into(),
            filename: name.into(),
            oid: blob,
        };
        let tree = |entries: Vec<gix::objs::tree::Entry>| {
            let mut entries = entries;
            entries.sort();
            git.write_object(gix::objs::Tree { entries })
                .unwrap()
                .detach()
        };
        let big = tree((0..12_000).map(|i| file(format!("f{i:05}"))).collect());
        let nested = tree(vec![gix::objs::tree::Entry {
            mode: gix::objs::tree::EntryKind::Tree.into(),
            filename: "big".into(),
            oid: big,
        }]);
        let root = tree(vec![
            file("README.md".into()),
            gix::objs::tree::Entry {
                mode: gix::objs::tree::EntryKind::Tree.into(),
                filename: "a".into(),
                oid: big,
            },
            gix::objs::tree::Entry {
                mode: gix::objs::tree::EntryKind::Tree.into(),
                filename: "src".into(),
                oid: nested,
            },
        ]);
        let signature = gix::actor::SignatureRef::from_bytes(
            b"Smithers <smithers@example.com> 1711398853 +0000",
        )
        .unwrap();
        let id = git
            .commit_as(
                signature,
                signature,
                "refs/heads/big",
                "big",
                root,
                std::iter::empty::<gix::ObjectId>(),
            )
            .unwrap()
            .detach()
            .to_string();
        let handle = RepoHandle::open(&path).unwrap();
        assert!(matches!(
            handle.list_files_at_change(&id, None),
            Err(JjError::BadRequest(_))
        ));
        let page = |prefix: &str, after: &str, limit: u32| {
            handle
                .list_directory(&id, prefix, after, limit)
                .unwrap()
                .into_iter()
                .map(|entry| (entry.path, entry.kind))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            page("", "", 5),
            vec![
                ("README.md".to_string(), "file"),
                ("a".to_string(), "dir"),
                ("src".to_string(), "dir"),
            ]
        );
        assert_eq!(page("", "README.md", 1), vec![("a".to_string(), "dir")]);
        assert_eq!(
            page("/src/big/", "src/big/f09999", 2),
            vec![
                ("src/big/f10000".to_string(), "file"),
                ("src/big/f10001".to_string(), "file"),
            ]
        );
        let mut after = String::new();
        let mut seen = 0;
        loop {
            let entries = page("src/big", &after, 1000);
            let Some(last) = entries.last() else { break };
            after = last.0.clone();
            seen += entries.len();
        }
        assert_eq!(seen, 12_000);
        assert_eq!(page("src/big/f00001", "", 5), vec![]);
        assert_eq!(page("missing", "", 5), vec![]);
    }

    #[test]
    fn notes_commit_is_readable_without_a_jj_bookmark() {
        let tmp = TempDir::new().unwrap();
        let path = repo_path(&tmp);
        init_repo(&path).unwrap();
        let git = gix::open(path.join(".jj/repo/store/git")).unwrap();
        let blob = git.write_blob(b"story").unwrap().detach();
        let tree = git
            .write_object(gix::objs::Tree {
                entries: vec![gix::objs::tree::Entry {
                    mode: gix::objs::tree::EntryKind::Blob.into(),
                    filename: "abcdef".into(),
                    oid: blob,
                }],
            })
            .unwrap()
            .detach();
        let signature = gix::actor::SignatureRef::from_bytes(
            b"Librarian <librarian@example.com> 1711398853 +0000",
        )
        .unwrap();
        let id = git
            .commit_as(
                signature,
                signature,
                "refs/notes/mythical",
                "notes",
                tree,
                std::iter::empty::<gix::ObjectId>(),
            )
            .unwrap()
            .detach();
        import_git_refs(&path).unwrap();
        export_git_refs(&path).unwrap();
        let handle = RepoHandle::open(&path).unwrap();
        assert!(matches!(
            core_resolve_commit_id(&handle.repo, &id.to_string()),
            ChangeIdResolution::NotFound
        ));
        let file = handle.get_file_content(&id.to_string(), "abcdef").unwrap();
        assert_eq!(file.content, "story");
        assert!(matches!(
            handle.get_file_content(&"f".repeat(40), "abcdef"),
            Err(JjError::NotFound(_))
        ));
        assert_eq!(
            git.find_reference("refs/notes/mythical")
                .unwrap()
                .id()
                .to_string(),
            id.to_string()
        );
    }

    #[test]
    fn import_git_refs_rebases_descendants_after_git_ref_deletion() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        auto_init_repo(&repo_path, "main", "demo").expect("auto init repo");

        let settings = create_settings(&UserConfig::default());
        let (_, repo) = load_repo_at_head(&repo_path, &settings).expect("load repo");
        let old_main = repo
            .view()
            .get_local_bookmark("main".as_ref())
            .as_normal()
            .expect("normal main bookmark")
            .clone();
        let backend = repo
            .store()
            .backend_impl::<jj_lib::git_backend::GitBackend>()
            .expect("git backend");
        let git_repo = backend.git_repo();
        git_repo
            .find_reference("refs/heads/main")
            .expect("git main ref")
            .delete()
            .expect("delete git main ref");

        // Deleting an imported ref records the old commit as abandoned. This
        // used to panic inside Transaction::commit because the pending rewrite
        // was never finalized with rebase_descendants().
        import_git_refs(&repo_path).expect("import deleted git ref");

        let (_, repo) = load_repo_at_head(&repo_path, &settings).expect("reload repo");
        assert!(
            repo.view().get_local_bookmark("main".as_ref()).is_absent(),
            "deleted Git branch must be removed from the JJ view"
        );
        assert!(
            !repo.view().heads().contains(&old_main),
            "abandoned Git head must not remain visible in JJ"
        );
    }

    #[test]
    fn ffi_backout_change_reverses_exact_revision_on_target_and_preserves_trailers() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        auto_init_repo(&repo_path, "main", "demo").expect("auto init repo");
        let repo_path_c = c_path(&repo_path);

        let original_change = create_commit_with_files(
            &repo_path,
            "Add feature\n\nIssue: 456\nAgent-Session: session-1",
            &[("feature.txt", "enabled\n")],
        );
        let original_commit = current_commit_id(&repo_path);
        let original_change_c = c_string(&original_change);
        let original_commit_c = c_string(&original_commit);
        let main_c = c_string("main");
        let no_base_c = c_string("");
        let landed = unsafe {
            take_json(smithers_land_change(
                repo_path_c.as_ptr(),
                original_change_c.as_ptr(),
                main_c.as_ptr(),
            ))
        };
        assert_eq!(landed["target_commit_id"], original_commit);

        let reverting = unsafe {
            take_json(smithers_backout_change_range(
                repo_path_c.as_ptr(),
                original_change_c.as_ptr(),
                original_commit_c.as_ptr(),
                main_c.as_ptr(),
                no_base_c.as_ptr(),
            ))
        };
        let reverting_change = reverting["change_id"].as_str().expect("change id");
        assert_ne!(reverting_change, original_change);
        assert_eq!(reverting["parent_commit_id"], original_commit);
        assert_eq!(reverting["has_conflict"], false);
        let description = reverting["description"].as_str().expect("description");
        assert!(description.starts_with(&format!("Revert {}", &original_change[..8])));
        assert!(description.contains(&format!("This reverts commit {original_commit}.")));
        assert!(description.ends_with("Issue: 456\nAgent-Session: session-1"));

        let reverting_change_c = c_string(reverting_change);
        let diff = unsafe {
            take_json(smithers_get_diff(
                repo_path_c.as_ptr(),
                reverting_change_c.as_ptr(),
            ))
        };
        assert_eq!(diff["file_diffs"][0]["path"], "feature.txt");
        assert_eq!(diff["file_diffs"][0]["change_type"], "deleted");
    }

    #[test]
    fn ffi_split_change_moves_selected_paths_and_preserves_original_id() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);
        let _ = unsafe { take_json(smithers_init_repo(repo_path_c.as_ptr())) };
        let original_change = create_commit_with_files(
            &repo_path,
            "Original description",
            &[("src/a.txt", "a\n"), ("src/b.txt", "b\n")],
        );

        let original_c = c_string(&original_change);
        let paths_c = c_string(r#"["src/a.txt","missing.txt"]"#);
        let description_c = c_string("Extract a");
        let result = unsafe {
            take_json(smithers_split_change(
                repo_path_c.as_ptr(),
                original_c.as_ptr(),
                paths_c.as_ptr(),
                description_c.as_ptr(),
            ))
        };

        assert_eq!(result["original"]["change_id"], original_change);
        assert_eq!(result["original"]["description"], "Original description");
        assert_eq!(result["split"]["description"], "Extract a");
        let split_change = result["split"]["change_id"].as_str().expect("split id");
        assert_ne!(split_change, original_change);
        assert_eq!(result["original"]["parent_change_ids"][0], split_change);

        let split_c = c_string(split_change);
        let split_diff =
            unsafe { take_json(smithers_get_diff(repo_path_c.as_ptr(), split_c.as_ptr())) };
        assert_eq!(
            split_diff["file_diffs"]
                .as_array()
                .expect("split diff")
                .len(),
            1
        );
        assert_eq!(split_diff["file_diffs"][0]["path"], "src/a.txt");

        let original_diff =
            unsafe { take_json(smithers_get_diff(repo_path_c.as_ptr(), original_c.as_ptr())) };
        assert_eq!(
            original_diff["file_diffs"]
                .as_array()
                .expect("original diff")
                .len(),
            1
        );
        assert_eq!(original_diff["file_diffs"][0]["path"], "src/b.txt");
    }

    #[test]
    fn ffi_split_change_returns_unprocessable_when_no_path_matches() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);
        let _ = unsafe { take_json(smithers_init_repo(repo_path_c.as_ptr())) };
        let original_change =
            create_commit_with_files(&repo_path, "Original", &[("src/a.txt", "a\n")]);

        let original_c = c_string(&original_change);
        let paths_c = c_string(r#"["missing.txt"]"#);
        let description_c = c_string("");
        let result = unsafe {
            take_json(smithers_split_change(
                repo_path_c.as_ptr(),
                original_c.as_ptr(),
                paths_c.as_ptr(),
                description_c.as_ptr(),
            ))
        };
        assert_eq!(result["code"], "unprocessable_entity");
        assert_eq!(result["error"], "no listed path is in the change");
    }

    #[test]
    fn ffi_split_change_refuses_history_of_default_and_mythical() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);
        let _ = unsafe { take_json(smithers_init_repo(repo_path_c.as_ptr())) };
        persist_default_git_bookmark(&repo_path, "trunk").expect("save default bookmark");
        let files: &[(&str, &str)] = &[("a.txt", "a\n"), ("b.txt", "b\n")];
        let landed = create_commit_with_files(&repo_path, "Landed", files);
        let tip = create_commit_with_files(&repo_path, "Tip", &[("c.txt", "c\n")]);
        let stacked = create_commit_with_files(&repo_path, "Stacked", &[("d.txt", "d\n")]);
        let pending = create_commit_with_files(&repo_path, "Pending", &[("e.txt", "e\n")]);
        let bookmark = |name: &str, change: &str| {
            let (name, change) = (c_string(name), c_string(change));
            let created = unsafe {
                take_json(smithers_create_bookmark(
                    repo_path_c.as_ptr(),
                    name.as_ptr(),
                    change.as_ptr(),
                ))
            };
            assert!(created.get("code").is_none(), "{created}");
        };
        bookmark("trunk", &tip);
        bookmark("mythical", &stacked);
        let split = |change: &str, path: &str| {
            let (change, paths) = (c_string(change), c_string(&format!(r#"["{path}"]"#)));
            let description = c_string("part");
            unsafe {
                take_json(smithers_split_change(
                    repo_path_c.as_ptr(),
                    change.as_ptr(),
                    paths.as_ptr(),
                    description.as_ptr(),
                ))
            }
        };

        // `::trunk` and `::mythical`, an ancestor or the head itself, are
        // never rewritten; nothing moves.
        for (change, path, bookmark) in [
            (&landed, "a.txt", "trunk"),
            (&tip, "c.txt", "trunk"),
            (&stacked, "d.txt", "mythical"),
        ] {
            let refused = split(change, path);
            assert_eq!(refused["code"], "conflict", "{refused}");
            assert_eq!(
                refused["error"],
                format!("the change is in {bookmark}'s history, which is never rewritten")
            );
        }
        let handle = RepoHandle::open(&repo_path).expect("open");
        let head = |name: &str| {
            handle
                .repo
                .view()
                .get_local_bookmark(RefName::new(name))
                .as_normal()
                .cloned()
                .expect("bookmark")
        };
        let trunk_commit = resolve_change_id(&handle.repo, &tip).expect("tip");
        assert_eq!(head("trunk"), trunk_commit);

        // A change above both is still split.
        let result = split(&pending, "e.txt");
        assert_eq!(result["original"]["change_id"], pending, "{result}");
    }

    #[test]
    fn ffi_split_change_fails_closed_without_a_default_bookmark() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);
        let _ = unsafe { take_json(smithers_init_repo(repo_path_c.as_ptr())) };
        let change = create_commit_with_files(&repo_path, "Change", &[("a.txt", "a\n")]);
        let git_dir = repo_path.join(".jj/repo/store/git");
        std::fs::write(
            git_dir.join("HEAD"),
            "0000000000000000000000000000000000000000\n",
        )
        .expect("detach HEAD");
        for name in ["one", "two"] {
            let (name, change) = (c_string(name), c_string(&change));
            let _ = unsafe {
                take_json(smithers_create_bookmark(
                    repo_path_c.as_ptr(),
                    name.as_ptr(),
                    change.as_ptr(),
                ))
            };
        }
        export_git_refs(&repo_path).expect("export");
        std::fs::write(
            git_dir.join("HEAD"),
            "0000000000000000000000000000000000000000\n",
        )
        .expect("detach HEAD");

        let (change_c, paths, description) =
            (c_string(&change), c_string(r#"["a.txt"]"#), c_string(""));
        let refused = unsafe {
            take_json(smithers_split_change(
                repo_path_c.as_ptr(),
                change_c.as_ptr(),
                paths.as_ptr(),
                description.as_ptr(),
            ))
        };
        assert_eq!(refused["code"], "conflict", "{refused}");
        assert_eq!(refused["error"], "the default bookmark cannot be read");
    }

    #[test]
    fn ffi_append_only_bookmarks_only_move_forward() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);
        let _ = unsafe { take_json(smithers_init_repo(repo_path_c.as_ptr())) };
        persist_default_git_bookmark(&repo_path, "trunk").expect("save default bookmark");
        let base = create_commit_with_files(&repo_path, "Base", &[("a.txt", "a\n")]);
        let tip = create_commit_with_files(&repo_path, "Tip", &[("b.txt", "b\n")]);
        let set = |name: &str, change: &str| {
            let (name, change) = (c_string(name), c_string(change));
            unsafe {
                take_json(smithers_create_bookmark(
                    repo_path_c.as_ptr(),
                    name.as_ptr(),
                    change.as_ptr(),
                ))
            }
        };
        let delete = |name: &str| {
            let name = c_string(name);
            unsafe {
                take_json(smithers_delete_bookmark(
                    repo_path_c.as_ptr(),
                    name.as_ptr(),
                ))
            }
        };
        for name in ["trunk", "mythical", "topic"] {
            assert!(set(name, &base).get("code").is_none(), "create {name}");
            assert!(set(name, &tip).get("code").is_none(), "forward {name}");
        }
        for name in ["trunk", "mythical"] {
            let rewound = set(name, &base);
            assert_eq!(rewound["code"], "conflict", "{rewound}");
            assert_eq!(
                rewound["error"],
                format!("{name} only moves forward; its history is never rewritten")
            );
            assert_eq!(delete(name)["code"], "conflict", "delete {name}");
        }
        assert!(
            set("topic", &base).get("code").is_none(),
            "other bookmarks move freely"
        );
        assert!(delete("topic").get("code").is_none());
    }

    #[test]
    fn backout_description_ignores_non_trailer_final_paragraph() {
        assert_eq!(description_trailer_block("Summary\n\nordinary prose"), None);
        assert_eq!(
            description_trailer_block("Summary\n\nIssue: 456\nReviewed-by: Ada"),
            Some("Issue: 456\nReviewed-by: Ada")
        );
    }

    fn create_conflicted_change(repo_path: &Path) -> String {
        let settings = create_settings(&UserConfig::default());
        let _ = load_repo_at_head(repo_path, &settings).expect("load repo");
        let base_change = create_commit_with_files(repo_path, "base", &[("shared.txt", "base\n")]);
        let settings = create_settings(&UserConfig::default());
        let (_, repo) = load_repo_at_head(repo_path, &settings).expect("reload repo");
        let base_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("base wc id")
            .clone();
        let _ = base_change;

        let main_change =
            create_commit_with_files(repo_path, "main", &[("shared.txt", "main version\n")]);
        let settings = create_settings(&UserConfig::default());
        let (_, repo) = load_repo_at_head(repo_path, &settings).expect("reload repo");
        let main_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("main wc id")
            .clone();

        let mut tx = repo.start_transaction();
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), base_id.clone())
            .expect("reset wc to base");
        let _repo = tx.commit("reset wc").block_on().expect("commit reset");
        let _ = main_change;

        create_commit_with_files(repo_path, "feature", &[("shared.txt", "feature version\n")]);
        let settings = create_settings(&UserConfig::default());
        let (_, repo) = load_repo_at_head(repo_path, &settings).expect("reload repo");
        let feature_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("feature wc id")
            .clone();

        let main_commit = repo.store().get_commit(&main_id).expect("main commit");
        let feature_commit = repo
            .store()
            .get_commit(&feature_id)
            .expect("feature commit");
        let merged_tree =
            jj_lib::rewrite::merge_commit_trees(repo.as_ref(), &[main_commit, feature_commit])
                .block_on()
                .expect("merge commit trees");
        assert!(merged_tree.has_conflict(), "expected conflicted merge tree");

        let mut tx = repo.start_transaction();
        let merge_commit = tx
            .repo_mut()
            .new_commit(vec![main_id, feature_id], merged_tree)
            .set_description("conflicted merge")
            .write()
            .block_on()
            .expect("write merge commit");
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), merge_commit.id().clone())
            .expect("set merge wc");
        let repo = tx
            .commit("commit conflicted merge")
            .block_on()
            .expect("commit merge");

        let merge_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("merge wc id")
            .clone();
        repo.store()
            .get_commit(&merge_id)
            .expect("merge commit")
            .change_id()
            .reverse_hex()
    }

    #[test]
    fn ffi_repo_lifecycle_returns_json_and_deletes_repo() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);

        let init = unsafe { take_json(smithers_init_repo(repo_path_c.as_ptr())) };
        assert_eq!(init["status"], "ok");
        assert_eq!(init["path"], repo_path.display().to_string());
        assert!(repo_path.is_dir());

        let delete = unsafe { take_json(smithers_delete_repo(repo_path_c.as_ptr())) };
        assert_eq!(delete["status"], "ok");
        assert!(!repo_path.exists());
        assert!(repo_path.parent().expect("repo parent").is_dir());

        let delete_again = unsafe { take_json(smithers_delete_repo(repo_path_c.as_ptr())) };
        assert_eq!(delete_again["code"], "not_found");
    }

    #[test]
    fn ffi_auto_init_repo_creates_readme_and_bookmark() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);
        let bookmark_name = c_string("trunk");
        let repo_name = c_string("demo");
        let readme_path = c_string("README.md");

        let init = unsafe {
            take_json(smithers_auto_init_repo(
                repo_path_c.as_ptr(),
                bookmark_name.as_ptr(),
                repo_name.as_ptr(),
            ))
        };
        assert_eq!(init["status"], "ok");

        let bookmarks = unsafe { take_json(smithers_list_bookmarks(repo_path_c.as_ptr(), 1, 30)) };
        assert_eq!(bookmarks["total_count"], 1);
        assert_eq!(bookmarks["items"][0]["name"], "trunk");

        let change_id = current_change_id(&repo_path);
        let change_id_c = c_string(&change_id);
        let readme = unsafe {
            take_json(smithers_get_file_content(
                repo_path_c.as_ptr(),
                change_id_c.as_ptr(),
                readme_path.as_ptr(),
            ))
        };
        assert_eq!(readme["path"], "README.md");
        assert_eq!(readme["content"], "# demo\n");
        assert_eq!(
            std::fs::read_to_string(repo_path.join(".jj/repo/store/git/HEAD"))
                .expect("read git HEAD"),
            "ref: refs/heads/trunk\n"
        );
    }

    #[test]
    fn auto_init_repo_removes_partial_directory_when_git_export_fails() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);

        // jj permits this bookmark spelling, but Git rejects spaces in ref
        // names. The failure happens after init_repo has created the directory.
        let err = auto_init_repo(&repo_path, "invalid bookmark", "demo")
            .expect_err("git ref export should reject the bookmark");

        assert!(format!("{err:?}").contains("export"));
        assert!(
            !repo_path.exists(),
            "failed auto-init must not leave a path that blocks retries"
        );
    }

    #[test]
    fn ffi_delete_repo_rejects_non_jj_directory() {
        let tmp = TempDir::new().expect("tempdir");
        let dir = tmp.path().join("not-a-repo");
        std::fs::create_dir_all(&dir).expect("create dir");
        let dir_c = c_path(&dir);

        let response = unsafe { take_json(smithers_delete_repo(dir_c.as_ptr())) };
        assert_eq!(response["code"], "not_found");
        assert_eq!(response["error"], "not a jj repository");
        assert!(dir.is_dir());
    }

    #[test]
    fn ffi_delete_repo_rejects_directory_with_empty_jj_dir() {
        let tmp = TempDir::new().expect("tempdir");
        let dir = tmp.path().join("not-a-repo");
        let marker = dir.join("important.txt");
        std::fs::create_dir_all(dir.join(".jj")).expect("create fake jj dir");
        std::fs::write(&marker, "keep me").expect("write marker");
        let dir_c = c_path(&dir);

        let response = unsafe { take_json(smithers_delete_repo(dir_c.as_ptr())) };
        assert_eq!(response["code"], "not_found");
        assert_eq!(response["error"], "not a jj repository");
        assert!(dir.is_dir());
        assert!(marker.is_file());
    }

    #[test]
    fn ffi_delete_repo_rejects_directory_with_fake_jj_store() {
        let tmp = TempDir::new().expect("tempdir");
        let dir = tmp.path().join("not-a-repo");
        let marker = dir.join("important.txt");
        std::fs::create_dir_all(dir.join(".jj").join("repo").join("store"))
            .expect("create fake jj store");
        std::fs::write(&marker, "keep me").expect("write marker");
        let dir_c = c_path(&dir);

        let response = unsafe { take_json(smithers_delete_repo(dir_c.as_ptr())) };
        assert_eq!(response["code"], "not_found");
        assert_eq!(response["error"], "not a jj repository");
        assert!(dir.is_dir());
        assert!(marker.is_file());
    }

    #[test]
    fn ffi_delete_repo_removes_unloadable_jj_repository() {
        let tmp = TempDir::new().expect("tempdir");
        let path = repo_path(&tmp);
        init_repo(&path).expect("initialize real repository");
        std::fs::remove_dir_all(path.join(".jj/repo/op_heads")).expect("corrupt operation heads");
        let settings = create_settings(&UserConfig::default());
        assert!(load_repo_at_head(&path, &settings).is_err());
        let response = unsafe { take_json(smithers_delete_repo(c_path(&path).as_ptr())) };
        assert_eq!(response["status"], "ok");
        assert!(!path.exists());
    }

    #[test]
    fn ffi_bookmarks_support_workspace_and_store_paths() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);
        let _ = unsafe { take_json(smithers_init_repo(repo_path_c.as_ptr())) };
        let change_id = current_change_id(&repo_path);

        let store_path = repo_path.join(".jj").join("repo").join("store");
        let store_path_c = c_path(&store_path);
        let name = c_string("topic");
        let change_id_c = c_string(&change_id);

        let created = unsafe {
            take_json(smithers_create_bookmark(
                store_path_c.as_ptr(),
                name.as_ptr(),
                change_id_c.as_ptr(),
            ))
        };
        assert_eq!(created["name"], "topic");
        assert_eq!(created["target_change_id"], change_id);

        let missing_change_id = c_string("change-that-does-not-exist");
        let existing = unsafe {
            take_json(smithers_create_bookmark_if_absent(
                store_path_c.as_ptr(),
                name.as_ptr(),
                missing_change_id.as_ptr(),
            ))
        };
        assert_eq!(existing["name"], "topic");
        assert_eq!(existing["target_change_id"], change_id);

        let listed = unsafe { take_json(smithers_list_bookmarks(store_path_c.as_ptr(), 1, 30)) };
        assert_eq!(listed["total_count"], 1);
        assert_eq!(listed["items"][0]["name"], "topic");

        let deleted = unsafe {
            take_json(smithers_delete_bookmark(
                store_path_c.as_ptr(),
                name.as_ptr(),
            ))
        };
        assert_eq!(deleted["status"], "ok");
    }

    #[test]
    fn ffi_changes_files_snapshots_and_operations_return_expected_shapes() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);
        let _ = unsafe { take_json(smithers_init_repo(repo_path_c.as_ptr())) };
        let change_id = create_commit_with_files(
            &repo_path,
            "seed files",
            &[("README.md", "hello\n"), ("src/main.rs", "fn main() {}\n")],
        );
        let change_id_c = c_string(&change_id);
        let commit_id = current_commit_id(&repo_path);
        let commit_id_c = c_string(&commit_id);
        let readme_path = c_string("README.md");

        let changes = unsafe { take_json(smithers_list_changes(repo_path_c.as_ptr(), 1, 30)) };
        assert!(changes["total_count"].as_u64().expect("total_count") >= 1);

        let change = unsafe {
            take_json(smithers_get_change(
                repo_path_c.as_ptr(),
                change_id_c.as_ptr(),
            ))
        };
        assert_eq!(change["change_id"], change_id);
        assert!(change.get("commit_id").is_some());
        assert!(change["parent_commit_id"]
            .as_str()
            .is_some_and(|parent| !parent.is_empty()));

        let diff = unsafe {
            take_json(smithers_get_diff(
                repo_path_c.as_ptr(),
                change_id_c.as_ptr(),
            ))
        };
        assert_eq!(diff["change_id"], change_id);
        assert!(diff["file_diffs"].as_array().expect("file diffs").len() >= 2);

        let files = unsafe {
            take_json(smithers_get_files(
                repo_path_c.as_ptr(),
                change_id_c.as_ptr(),
            ))
        };
        assert!(files
            .as_array()
            .expect("files")
            .iter()
            .any(|file| file["path"] == "README.md"));

        let file = unsafe {
            take_json(smithers_get_file_content(
                repo_path_c.as_ptr(),
                change_id_c.as_ptr(),
                readme_path.as_ptr(),
            ))
        };
        assert_eq!(file["path"], "README.md");
        assert_eq!(file["content"], "hello\n");
        assert_eq!(file["encoding"], "utf8");
        assert_eq!(file["too_large"], false);

        let tree_from_commit = unsafe {
            take_json(smithers_list_tree_files(
                repo_path_c.as_ptr(),
                commit_id_c.as_ptr(),
                std::ptr::null(),
            ))
        };
        assert!(tree_from_commit
            .as_array()
            .expect("tree files")
            .iter()
            .any(|file| file["path"] == "README.md"));

        let empty = c_string("");
        let root = unsafe {
            take_json(smithers_list_directory(
                repo_path_c.as_ptr(),
                commit_id_c.as_ptr(),
                empty.as_ptr(),
                empty.as_ptr(),
                2,
            ))
        };
        assert_eq!(
            root,
            serde_json::json!([
                { "path": "README.md", "kind": "file" },
                { "path": "src", "kind": "dir" }
            ])
        );
        let src = c_string("src");
        let nested = unsafe {
            take_json(smithers_list_directory(
                repo_path_c.as_ptr(),
                commit_id_c.as_ptr(),
                src.as_ptr(),
                empty.as_ptr(),
                1,
            ))
        };
        assert_eq!(
            nested,
            serde_json::json!([{ "path": "src/main.rs", "kind": "file" }])
        );
        let after = c_string("README.md");
        let page = unsafe {
            take_json(smithers_list_directory(
                repo_path_c.as_ptr(),
                commit_id_c.as_ptr(),
                empty.as_ptr(),
                after.as_ptr(),
                1,
            ))
        };
        assert_eq!(page, serde_json::json!([{ "path": "src", "kind": "dir" }]));

        let file_from_commit = unsafe {
            take_json(smithers_get_file_content(
                repo_path_c.as_ptr(),
                commit_id_c.as_ptr(),
                readme_path.as_ptr(),
            ))
        };
        assert_eq!(file_from_commit["path"], "README.md");
        assert_eq!(file_from_commit["content"], "hello\n");

        let snapshot = unsafe {
            take_json(smithers_create_snapshot(
                repo_path_c.as_ptr(),
                change_id_c.as_ptr(),
            ))
        };
        let snapshot_path = snapshot["snapshot_path"].as_str().expect("snapshot_path");
        let snapshot_count = snapshot["file_count"].as_u64().expect("file_count");
        assert!(snapshot_count >= 1);
        assert!(Path::new(snapshot_path).join("README.md").is_file());

        let operations =
            unsafe { take_json(smithers_list_operations(repo_path_c.as_ptr(), 1, 30)) };
        assert!(operations["total_count"].as_u64().expect("total_count") >= 1);
        assert!(operations["items"][0].get("operation_id").is_some());
    }

    #[test]
    fn revision_interdiff_ignores_parent_only_rebases_and_supports_show_at_revision() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);
        let _ = unsafe { take_json(smithers_init_repo(repo_path_c.as_ptr())) };

        let settings = create_settings(&UserConfig::default());
        let (_, repo) = load_repo_at_head(&repo_path, &settings).expect("load repo");
        let store = repo.store().clone();
        let root_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("wc id")
            .clone();
        let root = store.get_commit(&root_id).expect("root commit");

        let write_tree = |parent: &jj_lib::commit::Commit, files: &[(&str, &str)]| {
            let parent_tree_id = parent
                .tree_ids()
                .clone()
                .into_resolved()
                .expect("resolved parent tree")
                .clone();
            let mut builder = TreeBuilder::new(store.clone(), parent_tree_id);
            for (path, content) in files {
                let path = RepoPathBuf::from_internal_string(*path).expect("valid path");
                let file_id = store
                    .write_file(&path, &mut content.as_bytes())
                    .block_on()
                    .expect("write file");
                builder.set(
                    path,
                    TreeValue::File {
                        id: file_id,
                        executable: false,
                        copy_id: CopyId::placeholder(),
                    },
                );
            }
            MergedTree::resolved(
                store.clone(),
                builder.write_tree().block_on().expect("write tree"),
            )
        };

        let mut tx = repo.start_transaction();
        let base = tx
            .repo_mut()
            .new_commit(
                vec![root_id],
                write_tree(&root, &[("shared.txt", "base one\n")]),
            )
            .write()
            .block_on()
            .expect("write base");
        let revision_a = tx
            .repo_mut()
            .new_commit(
                vec![base.id().clone()],
                write_tree(&base, &[("feature.txt", "feature\n")]),
            )
            .write()
            .block_on()
            .expect("write revision a");
        let new_parent = tx
            .repo_mut()
            .new_commit(
                vec![base.id().clone()],
                write_tree(&base, &[("shared.txt", "base two\n")]),
            )
            .write()
            .block_on()
            .expect("write new parent");
        let revision_b_tree = write_tree(&new_parent, &[("feature.txt", "feature\n")]);
        let revision_b = tx
            .repo_mut()
            .rewrite_commit(&revision_a)
            .set_parents(vec![new_parent.id().clone()])
            .set_tree(revision_b_tree)
            .write()
            .block_on()
            .expect("write revision b");
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), revision_b.id().clone())
            .expect("set wc");
        tx.repo_mut()
            .rebase_descendants()
            .block_on()
            .expect("finalize rewrites");
        tx.commit("create rebased revision")
            .block_on()
            .expect("commit transaction");

        let revision_a_c = c_string(&revision_a.id().hex());
        let revision_b_c = c_string(&revision_b.id().hex());
        let interdiff = unsafe {
            take_json(smithers_get_revision_diff(
                repo_path_c.as_ptr(),
                revision_a_c.as_ptr(),
                revision_b_c.as_ptr(),
                std::ptr::null(),
            ))
        };
        assert_eq!(interdiff["file_diffs"], serde_json::json!([]));

        let feature_path = c_string("feature.txt");
        let at_revision = unsafe {
            take_json(smithers_get_revision_diff(
                repo_path_c.as_ptr(),
                std::ptr::null(),
                revision_b_c.as_ptr(),
                feature_path.as_ptr(),
            ))
        };
        assert_eq!(
            at_revision["file_diffs"].as_array().expect("diffs").len(),
            1
        );
        assert_eq!(at_revision["file_diffs"][0]["path"], "feature.txt");
        assert_eq!(at_revision["file_diffs"][0]["change_type"], "added");
        assert_eq!(at_revision["file_diffs"][0]["old_content"], "");
        assert_eq!(at_revision["file_diffs"][0]["new_content"], "feature\n");
    }

    #[test]
    fn ffi_get_file_content_returns_binary_blobs_as_base64() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);
        let _ = unsafe { take_json(smithers_init_repo(repo_path_c.as_ptr())) };

        // PNG-like header: invalid UTF-8 (0x89, 0xFF) that a lossy conversion
        // would silently replace with U+FFFD.
        let binary: &[u8] = &[0x89, b'P', b'N', b'G', 0xFF, 0x00, 0x01];
        let change_id = create_commit_with_files(&repo_path, "add binary", &[("logo.png", binary)]);
        let change_id_c = c_string(&change_id);
        let file_path = c_string("logo.png");

        let file = unsafe {
            take_json(smithers_get_file_content(
                repo_path_c.as_ptr(),
                change_id_c.as_ptr(),
                file_path.as_ptr(),
            ))
        };
        assert_eq!(file["path"], "logo.png");
        assert_eq!(file["encoding"], "base64");
        assert_eq!(file["too_large"], false);
        let decoded = BASE64_STANDARD
            .decode(file["content"].as_str().expect("content"))
            .expect("valid base64");
        assert_eq!(decoded, binary);
    }

    #[test]
    fn ffi_conflicts_land_refs_and_pagination_match_expected_contracts() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);
        let _ = unsafe { take_json(smithers_init_repo(repo_path_c.as_ptr())) };

        let conflicted_change = create_conflicted_change(&repo_path);
        let conflicted_change_c = c_string(&conflicted_change);
        let conflicts = unsafe {
            take_json(smithers_get_conflicts(
                repo_path_c.as_ptr(),
                conflicted_change_c.as_ptr(),
            ))
        };
        assert_eq!(conflicts.as_array().expect("conflicts").len(), 1);
        assert_eq!(conflicts[0]["file_path"], "shared.txt");

        let new_tmp = TempDir::new().expect("tempdir");
        let new_repo_path = self::repo_path(&new_tmp);
        let new_repo_path_c = c_path(&new_repo_path);
        let _ = unsafe { take_json(smithers_init_repo(new_repo_path_c.as_ptr())) };
        let change_id = current_change_id(&new_repo_path);
        let change_id_c = c_string(&change_id);
        let target = c_string("main");

        let landed = unsafe {
            take_json(smithers_land_change(
                new_repo_path_c.as_ptr(),
                change_id_c.as_ptr(),
                target.as_ptr(),
            ))
        };
        assert_eq!(landed["landed_count"], 1);
        assert_eq!(landed["target_bookmark"], "main");

        let _ = unsafe { take_json(smithers_import_git_refs(new_repo_path_c.as_ptr())) };
        let _ = unsafe { take_json(smithers_export_git_refs(new_repo_path_c.as_ptr())) };

        for name in ["alpha", "beta", "gamma"] {
            let name_c = c_string(name);
            let _ = unsafe {
                take_json(smithers_create_bookmark(
                    new_repo_path_c.as_ptr(),
                    name_c.as_ptr(),
                    change_id_c.as_ptr(),
                ))
            };
        }

        let page = unsafe { take_json(smithers_list_bookmarks(new_repo_path_c.as_ptr(), 2, 2)) };
        assert_eq!(page["total_count"], 4);
        assert_eq!(page["items"].as_array().expect("items").len(), 2);
    }

    #[test]
    fn ffi_superproject_compose_read_land_round_trip() {
        // Two member repositories supply real commit ids for the gitlinks.
        let member_a = TempDir::new().expect("tempdir");
        let member_a_path = member_a.path().join("acme").join("api");
        let _ = unsafe { take_json(smithers_init_repo(c_path(&member_a_path).as_ptr())) };
        create_commit_with_files(&member_a_path, "api change", &[("a.txt", "a")]);
        let a_commit = current_commit_id(&member_a_path);
        let member_b = TempDir::new().expect("tempdir");
        let member_b_path = member_b.path().join("acme").join("web");
        let _ = unsafe { take_json(smithers_init_repo(c_path(&member_b_path).as_ptr())) };
        create_commit_with_files(&member_b_path, "web change", &[("b.txt", "b")]);
        let b_commit = current_commit_id(&member_b_path);

        let sp = TempDir::new().expect("tempdir");
        let sp_path = sp.path().join("acme").join("superproject");
        let sp_path_c = c_path(&sp_path);
        let _ = unsafe { take_json(smithers_init_repo(sp_path_c.as_ptr())) };

        // First changeset: both members pinned, parent is the root commit
        // because bookmark `main` does not exist yet.
        let request = serde_json::json!({
            "members": [
                {"path": "web", "commit_id": b_commit},
                {"path": "api", "commit_id": a_commit},
            ],
            "bookmark": "main",
            "description": "changeset one",
        })
        .to_string();
        let request_c = c_string(&request);
        let composed = unsafe {
            take_json(smithers_compose_superproject(
                sp_path_c.as_ptr(),
                request_c.as_ptr(),
            ))
        };
        assert_eq!(composed["description"], "changeset one");
        let members = composed["members"].as_array().expect("members");
        assert_eq!(members.len(), 2);
        assert_eq!(members[0]["path"], "api");
        assert_eq!(members[0]["commit_id"], a_commit);
        assert_eq!(members[1]["path"], "web");
        assert_eq!(members[1]["commit_id"], b_commit);
        let change_id = composed["change_id"]
            .as_str()
            .expect("change id")
            .to_string();
        let commit_id = composed["commit_id"]
            .as_str()
            .expect("commit id")
            .to_string();
        assert_eq!(
            composed["parent_commit_ids"]
                .as_array()
                .expect("parents")
                .len(),
            1
        );

        // Read back by change id and by commit id.
        let change_id_c = c_string(&change_id);
        let read_by_change = unsafe {
            take_json(smithers_read_superproject(
                sp_path_c.as_ptr(),
                change_id_c.as_ptr(),
            ))
        };
        assert_eq!(read_by_change["members"], composed["members"]);
        let commit_id_c = c_string(&commit_id);
        let read_by_commit = unsafe {
            take_json(smithers_read_superproject(
                sp_path_c.as_ptr(),
                commit_id_c.as_ptr(),
            ))
        };
        assert_eq!(read_by_commit["commit_id"], commit_id);

        // .gitmodules lists every member with a relative url.
        let gitmodules_c = c_string(".gitmodules");
        let file = unsafe {
            take_json(smithers_get_file_content(
                sp_path_c.as_ptr(),
                change_id_c.as_ptr(),
                gitmodules_c.as_ptr(),
            ))
        };
        let content = file["content"].as_str().expect("gitmodules content");
        assert!(content.contains("[submodule \"api\"]\n\tpath = api\n\turl = ../api\n"));
        assert!(content.contains("[submodule \"web\"]\n\tpath = web\n\turl = ../web\n"));

        // Landing moves `main` to the changeset commit; gitlinks survive git
        // export/import (the superproject is a real git superproject).
        let main_c = c_string("main");
        let landed = unsafe {
            take_json(smithers_land_change(
                sp_path_c.as_ptr(),
                change_id_c.as_ptr(),
                main_c.as_ptr(),
            ))
        };
        assert_eq!(landed["target_commit_id"], commit_id);
        let _ = unsafe { take_json(smithers_export_git_refs(sp_path_c.as_ptr())) };
        let _ = unsafe { take_json(smithers_import_git_refs(sp_path_c.as_ptr())) };
        let after_git = unsafe {
            take_json(smithers_read_superproject(
                sp_path_c.as_ptr(),
                commit_id_c.as_ptr(),
            ))
        };
        assert_eq!(after_git["members"], composed["members"]);

        // Second changeset on top of `main`: override one member, inherit the
        // other, and record the landed commit as the parent.
        create_commit_with_files(&member_a_path, "api change 2", &[("a2.txt", "a2")]);
        let a_commit_2 = current_commit_id(&member_a_path);
        let request2 = serde_json::json!({
            "members": [{"path": "api", "commit_id": a_commit_2}],
            "bookmark": "main",
        })
        .to_string();
        let request2_c = c_string(&request2);
        let composed2 = unsafe {
            take_json(smithers_compose_superproject(
                sp_path_c.as_ptr(),
                request2_c.as_ptr(),
            ))
        };
        assert_eq!(composed2["parent_commit_ids"][0], commit_id);
        let members2 = composed2["members"].as_array().expect("members");
        assert_eq!(members2.len(), 2);
        assert_eq!(members2[0]["path"], "api");
        assert_eq!(members2[0]["commit_id"], a_commit_2);
        assert_eq!(members2[1]["path"], "web");
        assert_eq!(members2[1]["commit_id"], b_commit);
        assert_eq!(composed2["description"], "changeset: pin 2 member(s)");

        // Validation: nested paths, dotfiles, duplicates, and bad ids are rejected.
        for bad in [
            serde_json::json!({"members": [{"path": "a/b", "commit_id": a_commit}]}),
            serde_json::json!({"members": [{"path": ".gitmodules", "commit_id": a_commit}]}),
            serde_json::json!({"members": [
                {"path": "api", "commit_id": a_commit},
                {"path": "api", "commit_id": a_commit},
            ]}),
            serde_json::json!({"members": [{"path": "api", "commit_id": "zz"}]}),
            serde_json::json!({"members": []}),
        ] {
            let bad_c = c_string(&bad.to_string());
            let err = unsafe {
                take_json(smithers_compose_superproject(
                    sp_path_c.as_ptr(),
                    bad_c.as_ptr(),
                ))
            };
            assert_eq!(
                err["code"], "bad_request",
                "request {bad} should be rejected"
            );
        }
    }

    #[test]
    fn ffi_superproject_member_paths_cannot_inject_gitmodules_sections() {
        let member = TempDir::new().expect("tempdir");
        let member_path = member.path().join("acme").join("api");
        let _ = unsafe { take_json(smithers_init_repo(c_path(&member_path).as_ptr())) };
        create_commit_with_files(&member_path, "api change", &[("a.txt", "a")]);
        let a_commit = current_commit_id(&member_path);

        let sp = TempDir::new().expect("tempdir");
        let sp_path = sp.path().join("acme").join("superproject");
        let sp_path_c = c_path(&sp_path);
        let _ = unsafe { take_json(smithers_init_repo(sp_path_c.as_ptr())) };

        // A member path carrying git-config syntax must never reach
        // .gitmodules: the newline closes the [submodule] header and injects a
        // replacement section whose url redirects the submodule clone to an
        // attacker host (scp-style syntax needs no '/', so the slash check
        // does not save it).
        let evil_path =
            "web\"]\n[submodule \"api\"]\n\tpath = api\n\turl = git@evil.invalid:acme\n[x";
        let request = serde_json::json!({
            "members": [
                {"path": "api", "commit_id": a_commit},
                {"path": evil_path, "commit_id": a_commit},
            ],
        })
        .to_string();
        let request_c = c_string(&request);
        let err = unsafe {
            take_json(smithers_compose_superproject(
                sp_path_c.as_ptr(),
                request_c.as_ptr(),
            ))
        };
        assert_eq!(
            err["code"], "bad_request",
            "control-character member path must be rejected, got {err}"
        );

        // A hostile gitlink inherited from a pushed parent commit is the same
        // poison: compose must refuse rather than re-emit it into .gitmodules.
        let settings = create_settings(&UserConfig::default());
        let (_, repo) = load_repo_at_head(&sp_path, &settings).expect("load repo");
        let wc_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("wc id")
            .clone();
        let parent_commit = repo.store().get_commit(&wc_id).expect("parent");
        let parent_tree_id = parent_commit
            .tree()
            .tree_ids()
            .clone()
            .into_resolved()
            .expect("resolved")
            .clone();
        let mut builder = TreeBuilder::new(repo.store().clone(), parent_tree_id);
        let hostile = RepoPathBuf::from_internal_string(evil_path).expect("repo path");
        builder.set(hostile, TreeValue::GitSubmodule(parent_commit.id().clone()));
        let tree = MergedTree::resolved(
            repo.store().clone(),
            builder.write_tree().block_on().expect("write tree"),
        );
        let mut tx = repo.start_transaction();
        let commit = tx
            .repo_mut()
            .new_commit(vec![wc_id], tree)
            .set_description("pushed hostile gitlink")
            .write()
            .block_on()
            .expect("write commit");
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), commit.id().clone())
            .expect("set wc");
        tx.commit("hostile parent").block_on().expect("commit tx");
        let hostile_change = current_change_id(&sp_path);

        let request = serde_json::json!({
            "members": [{"path": "api", "commit_id": a_commit}],
            "parent_change_id": hostile_change,
        })
        .to_string();
        let request_c = c_string(&request);
        let err = unsafe {
            take_json(smithers_compose_superproject(
                sp_path_c.as_ptr(),
                request_c.as_ptr(),
            ))
        };
        assert_eq!(
            err["code"], "bad_request",
            "inherited hostile gitlink must be rejected, got {err}"
        );
    }

    #[test]
    fn ffi_wiki_round_trip_matches_http_contract() {
        let tmp = TempDir::new().expect("tempdir");
        let wiki_repo_path = tmp.path().join("alice").join("demo.wiki");
        let wiki_repo_path_c = c_path(&wiki_repo_path);
        let page_name = c_string("Home");
        let content = c_string("# hello\n");
        let author_name = c_string("Alice");
        let author_email = c_string("alice@example.com");
        let message = c_string("seed wiki");

        let init = unsafe { take_json(smithers_init_wiki_repo(wiki_repo_path_c.as_ptr())) };
        assert_eq!(init["created"], true);

        let committed = unsafe {
            take_json(smithers_commit_wiki_page(
                wiki_repo_path_c.as_ptr(),
                page_name.as_ptr(),
                content.as_ptr(),
                author_name.as_ptr(),
                author_email.as_ptr(),
                message.as_ptr(),
            ))
        };
        let commit_sha = committed["commit_sha"]
            .as_str()
            .expect("commit sha")
            .to_string();

        let page = unsafe {
            take_json(smithers_get_wiki_page_content(
                wiki_repo_path_c.as_ptr(),
                page_name.as_ptr(),
                std::ptr::null(),
            ))
        };
        assert_eq!(page["content"], "# hello\n");
        assert_eq!(page["commit_sha"], commit_sha);

        let history = unsafe {
            take_json(smithers_list_wiki_page_history(
                wiki_repo_path_c.as_ptr(),
                page_name.as_ptr(),
                10,
            ))
        };
        assert_eq!(history.as_array().expect("history").len(), 1);
        assert_eq!(history[0]["commit_sha"], commit_sha);

        let deleted = unsafe {
            take_json(smithers_delete_wiki_page(
                wiki_repo_path_c.as_ptr(),
                page_name.as_ptr(),
                author_name.as_ptr(),
                author_email.as_ptr(),
            ))
        };
        assert_eq!(deleted["status"], "ok");
    }

    #[test]
    fn ffi_docs_round_trip_matches_http_contract() {
        let tmp = TempDir::new().expect("tempdir");
        let docs_repo_path = tmp.path().join("alice").join("demo.docs");
        let docs_repo_path_c = c_path(&docs_repo_path);
        let file_path = c_string("notion/Engineering/Architecture.md");
        let content = c_string("# architecture\n");
        let author_name = c_string("Alice");
        let author_email = c_string("alice@example.com");
        let message = c_string("seed docs");

        let init = unsafe { take_json(smithers_init_docs_repo(docs_repo_path_c.as_ptr())) };
        assert_eq!(init["created"], true);

        let committed = unsafe {
            take_json(smithers_commit_doc(
                docs_repo_path_c.as_ptr(),
                file_path.as_ptr(),
                content.as_ptr(),
                author_name.as_ptr(),
                author_email.as_ptr(),
                message.as_ptr(),
            ))
        };
        let commit_sha = committed["commit_sha"]
            .as_str()
            .expect("commit sha")
            .to_string();

        let doc = unsafe {
            take_json(smithers_get_doc_content(
                docs_repo_path_c.as_ptr(),
                file_path.as_ptr(),
                std::ptr::null(),
            ))
        };
        assert_eq!(doc["content"], "# architecture\n");
        assert_eq!(doc["commit_sha"], commit_sha);

        let history = unsafe {
            take_json(smithers_list_doc_history(
                docs_repo_path_c.as_ptr(),
                file_path.as_ptr(),
                10,
            ))
        };
        assert_eq!(history.as_array().expect("history").len(), 1);
        assert_eq!(history[0]["commit_sha"], commit_sha);

        let deleted = unsafe {
            take_json(smithers_delete_doc(
                docs_repo_path_c.as_ptr(),
                file_path.as_ptr(),
                author_name.as_ptr(),
                author_email.as_ptr(),
            ))
        };
        assert_eq!(deleted["status"], "ok");
    }

    #[test]
    fn ffi_error_envelopes_cover_invalid_arguments_and_missing_changes() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);
        let _ = unsafe { take_json(smithers_init_repo(repo_path_c.as_ptr())) };

        let invalid_page =
            unsafe { take_json(smithers_list_bookmarks(repo_path_c.as_ptr(), 0, 30)) };
        assert_eq!(invalid_page["code"], "bad_request");

        let missing_change = c_string("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let missing = unsafe {
            take_json(smithers_get_change(
                repo_path_c.as_ptr(),
                missing_change.as_ptr(),
            ))
        };
        assert_eq!(missing["code"], "not_found");

        let invalid_utf8 =
            CString::from_vec_with_nul(vec![0xff, 0xfe, 0]).expect("invalid utf8 cstr");
        let invalid_utf8_response = unsafe {
            take_json(smithers_get_change(
                repo_path_c.as_ptr(),
                invalid_utf8.as_ptr(),
            ))
        };
        assert_eq!(invalid_utf8_response["code"], "invalid_argument");

        let commit_id = current_commit_id(&repo_path);
        let commit_id_c = c_string(&commit_id);
        let commit_as_change = unsafe {
            take_json(smithers_get_change(
                repo_path_c.as_ptr(),
                commit_id_c.as_ptr(),
            ))
        };
        assert_eq!(commit_as_change["commit_id"], commit_id);

        unsafe { smithers_free_string(std::ptr::null_mut()) };
    }

    #[test]
    fn ffi_rejects_divergent_change_id_but_accepts_commit_id() {
        use jj_lib::object_id::{HexPrefix, PrefixResolution};

        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);
        let _ = unsafe { take_json(smithers_init_repo(repo_path_c.as_ptr())) };
        create_commit_with_files(&repo_path, "original", &[("README.md", "original\n")]);

        let settings = create_settings(&UserConfig::default());
        let (_, repo) = load_repo_at_head(&repo_path, &settings).expect("load base operation");
        let original_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("original working-copy commit");
        let original = repo
            .store()
            .get_commit(original_id)
            .expect("original commit");

        // Both transactions start from the same operation and rewrite the same
        // change. Loading at head reconciles the concurrent JJ operations.
        let mut left_tx = repo.start_transaction();
        let left = left_tx
            .repo_mut()
            .rewrite_commit(&original)
            .set_description("left revision")
            .write()
            .block_on()
            .expect("write left revision");
        left_tx
            .repo_mut()
            .rebase_descendants()
            .block_on()
            .expect("finish left rewrite");
        left_tx
            .commit("left rewrite")
            .block_on()
            .expect("commit left");

        let mut right_tx = repo.start_transaction();
        let right = right_tx
            .repo_mut()
            .rewrite_commit(&original)
            .set_description("right revision")
            .write()
            .block_on()
            .expect("write right revision");
        right_tx
            .repo_mut()
            .rebase_descendants()
            .block_on()
            .expect("finish right rewrite");
        right_tx
            .commit("right rewrite")
            .block_on()
            .expect("commit right");

        let (_, reconciled) =
            load_repo_at_head(&repo_path, &settings).expect("reconcile concurrent operations");
        let change_id = original.change_id().reverse_hex();
        assert_eq!(left.change_id().reverse_hex(), change_id);
        assert_eq!(right.change_id().reverse_hex(), change_id);
        assert_ne!(left.id(), right.id());
        let prefix = HexPrefix::try_from_reverse_hex(change_id.as_bytes())
            .expect("full change ID is a valid prefix");
        let PrefixResolution::SingleMatch(targets) = reconciled
            .resolve_change_id_prefix(&prefix)
            .expect("resolve reconciled change")
        else {
            panic!("full change ID must resolve to its target set");
        };
        let visible: HashSet<_> = targets
            .visible_with_offsets()
            .map(|(_, commit_id)| commit_id.clone())
            .collect();
        assert_eq!(
            visible,
            HashSet::from([left.id().clone(), right.id().clone()])
        );

        for (revision, description) in [(&left, "left revision"), (&right, "right revision")] {
            let commit_id = revision.id().hex();
            let response = unsafe {
                take_json(smithers_get_change(
                    repo_path_c.as_ptr(),
                    c_string(&commit_id).as_ptr(),
                ))
            };
            assert_eq!(response["commit_id"], commit_id, "{response}");
            assert_eq!(response["change_id"], change_id, "{response}");
            assert_eq!(response["description"], description, "{response}");
        }

        let response = unsafe {
            take_json(smithers_get_change(
                repo_path_c.as_ptr(),
                c_string(&change_id).as_ptr(),
            ))
        };
        assert_eq!(response["code"], "bad_request", "{response}");
        assert!(
            response["error"]
                .as_str()
                .is_some_and(|error| error.contains("ambiguous")),
            "{response}"
        );
    }

    #[test]
    fn ffi_working_tree_status_reflects_on_disk_edits() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);

        // A colocated jj+git workspace (the shape every plue repo takes) seeded
        // with a committed baseline file.
        let bookmark_name = c_string("main");
        let repo_name = c_string("demo");
        let init = unsafe {
            take_json(smithers_auto_init_repo(
                repo_path_c.as_ptr(),
                bookmark_name.as_ptr(),
                repo_name.as_ptr(),
            ))
        };
        assert_eq!(init["status"], "ok");

        // Land a committed baseline that has a true empty working-copy change on
        // top of it — the production shape after `jj commit`/`jj new`, where `@`
        // is empty and `jj status` (which diffs `@` against its parent) reports
        // nothing. `seed_committed_baseline_with_empty_wc` also materializes the
        // baseline tree on disk so the working copy is internally consistent.
        seed_committed_baseline_with_empty_wc(
            &repo_path,
            &[("README.md", "# demo\n"), ("keep.txt", "one\ntwo\nthree\n")],
        );

        // A working copy whose on-disk contents match the committed parent (the
        // empty `@`) reports no changes.
        let clean = unsafe { take_json(smithers_get_working_tree_status(repo_path_c.as_ptr())) };
        assert_eq!(clean["backend"], "git", "colocated repo is git-backed");
        assert!(
            clean["changes"]
                .as_array()
                .expect("changes array")
                .is_empty(),
            "clean working copy: {clean}"
        );
        assert!(!clean["head"].as_str().expect("head").is_empty());

        // Make real on-disk edits: add a brand-new file and modify the committed
        // baseline, exactly like an agent editing files in the working tree.
        std::fs::write(repo_path.join("added.txt"), b"alpha\nbeta\n").expect("write added");
        std::fs::write(repo_path.join("keep.txt"), b"one\ntwo\nthree\nfour\n")
            .expect("modify keep");

        let status = unsafe { take_json(smithers_get_working_tree_status(repo_path_c.as_ptr())) };
        let changes = status["changes"].as_array().expect("changes array");
        assert_eq!(changes.len(), 2, "two paths changed: {status}");

        let added = changes
            .iter()
            .find(|c| c["path"] == "added.txt")
            .expect("added.txt present");
        assert_eq!(added["status"], "added");
        assert_eq!(added["add"], 2);
        assert_eq!(added["del"], 0);
        assert_eq!(added["staged"], true);

        let modified = changes
            .iter()
            .find(|c| c["path"] == "keep.txt")
            .expect("keep.txt present");
        assert_eq!(modified["status"], "modified");
        assert_eq!(modified["add"], 1, "one line appended");
        assert_eq!(modified["del"], 0);

        // The read-only status call must NOT persist a new working-copy
        // operation: calling it again yields the identical result.
        let status_again =
            unsafe { take_json(smithers_get_working_tree_status(repo_path_c.as_ptr())) };
        assert_eq!(status, status_again, "status is read-only / idempotent");

        // NULL store_path is a structured error, not a crash.
        let null_err = unsafe { take_json(smithers_get_working_tree_status(std::ptr::null())) };
        assert_eq!(null_err["code"], "invalid_argument");
    }
    #[test]
    fn ffi_working_tree_status_honors_gitignore() {
        let tmp = TempDir::new().expect("tempdir");
        let repo_path = repo_path(&tmp);
        let repo_path_c = c_path(&repo_path);
        let init = unsafe {
            take_json(smithers_auto_init_repo(
                repo_path_c.as_ptr(),
                c_string("main").as_ptr(),
                c_string("demo").as_ptr(),
            ))
        };
        assert_eq!(init["status"], "ok", "{init}");

        // tracked.txt predates the ignore rule, so it must remain tracked.
        seed_committed_baseline_with_empty_wc(&repo_path, &[("tracked.txt", "before\n")]);
        // Synchronize the on-disk working-copy state with the committed tree.
        // The test seeding helper writes repo commits directly, not via checkout.
        let settings = create_settings(&UserConfig::default());
        let (mut workspace, repo) =
            load_repo_at_head(&repo_path, &settings).expect("load workspace");
        let wc_id = repo
            .view()
            .get_wc_commit_id(workspace.workspace_name())
            .expect("working-copy commit");
        let wc = repo
            .store()
            .get_commit(wc_id)
            .expect("load working-copy commit");
        let mut locked = workspace
            .start_working_copy_mutation()
            .block_on()
            .expect("lock working copy");
        locked
            .locked_wc()
            .reset(&wc)
            .block_on()
            .expect("reset working-copy state");
        locked
            .finish(repo.operation().id().clone())
            .block_on()
            .expect("save working-copy state");
        std::fs::write(repo_path.join(".gitignore"), b"secret.env\ntracked.txt\n")
            .expect("write ignore rules");
        std::fs::write(repo_path.join("secret.env"), b"secret\n")
            .expect("write ignored untracked file");
        std::fs::write(repo_path.join("ordinary.txt"), b"visible\n")
            .expect("write ordinary untracked file");
        std::fs::write(repo_path.join("tracked.txt"), b"after\n")
            .expect("modify tracked file matching later ignore rule");

        let status = unsafe { take_json(smithers_get_working_tree_status(repo_path_c.as_ptr())) };
        let changes = status["changes"].as_array().expect("changes array");
        assert!(
            !changes.iter().any(|change| change["path"] == "secret.env"),
            "ignored untracked file must be absent: {status}"
        );
        let ordinary = changes
            .iter()
            .find(|change| change["path"] == "ordinary.txt")
            .expect("ordinary untracked file present");
        assert_eq!(ordinary["status"], "added");
        let tracked = changes
            .iter()
            .find(|change| change["path"] == "tracked.txt")
            .expect("tracked file still present despite later ignore rule");
        assert_eq!(tracked["status"], "modified");
    }
    #[test]
    fn atomic_stack_rejects_invalid_member_without_moving_bookmark() {
        let tmp = TempDir::new().unwrap();
        let path = repo_path(&tmp);
        let path_c = c_path(&path);
        let _ = unsafe { take_json(smithers_init_repo(path_c.as_ptr())) };
        let base = current_commit_id(&path);
        RepoHandle::open(&path)
            .unwrap()
            .create_bookmark("main", &base)
            .unwrap();
        let change = create_commit_with_files(&path, "first", &[("a", "a")]);
        let request = LandRequest {
            change_ids: vec![change, "does-not-exist".to_string()],
            target_bookmark: "main".to_string(),
            ..Default::default()
        };
        assert!(RepoHandle::open(&path)
            .unwrap()
            .land_request(&request)
            .is_err());
        assert_eq!(
            RepoHandle::open(&path)
                .unwrap()
                .get_bookmark("main")
                .unwrap()
                .unwrap()
                .target_commit_id,
            base
        );
    }

    #[test]
    fn landing_receipt_survives_reopen_and_does_not_overwrite_later_writer() {
        let tmp = TempDir::new().unwrap();
        let path = repo_path(&tmp);
        let path_c = c_path(&path);
        let _ = unsafe { take_json(smithers_init_repo(path_c.as_ptr())) };
        let base = current_commit_id(&path);
        RepoHandle::open(&path)
            .unwrap()
            .create_bookmark("main", &base)
            .unwrap();
        let change = create_commit_with_files(&path, "first", &[("a", "a")]);
        let request = LandRequest {
            change_ids: vec![change],
            target_bookmark: "main".to_string(),
            expected_commit_id: Some(base),
            operation_key: "review-attempt/member-1".to_string(),
            ..Default::default()
        };
        let result = RepoHandle::open(&path)
            .unwrap()
            .land_request(&request)
            .unwrap();
        let later = create_commit_with_files(&path, "later", &[("b", "b")]);
        let later_bookmark = RepoHandle::open(&path)
            .unwrap()
            .create_bookmark("main", &later)
            .unwrap();
        let mut lookup = request.clone();
        lookup.lookup_only = true;
        assert_eq!(
            RepoHandle::open(&path)
                .unwrap()
                .land_request(&lookup)
                .unwrap(),
            result
        );
        assert_eq!(
            RepoHandle::open(&path)
                .unwrap()
                .land_request(&request)
                .unwrap(),
            result
        );
        assert_eq!(
            RepoHandle::open(&path)
                .unwrap()
                .get_bookmark("main")
                .unwrap()
                .unwrap(),
            later_bookmark
        );
        lookup.operation_key = "missing".to_string();
        assert!(RepoHandle::open(&path)
            .unwrap()
            .land_request(&lookup)
            .is_err());
        lookup.lookup_only = false;
        assert!(RepoHandle::open(&path)
            .unwrap()
            .land_request(&lookup)
            .is_err());
    }
    #[test]
    fn append_landing_publishes_one_parent_and_replays_after_main_moves() {
        let tmp = TempDir::new().unwrap();
        let path = repo_path(&tmp);
        let path_c = c_path(&path);
        let _ = unsafe { take_json(smithers_init_repo(path_c.as_ptr())) };
        let base = current_commit_id(&path);
        RepoHandle::open(&path)
            .unwrap()
            .create_bookmark("main", &base)
            .unwrap();
        create_commit_with_files(&path, "first", &[("a", "a")]);
        let first = current_commit_id(&path);
        let source_change = create_commit_with_files(&path, "second", &[("b", "b")]);
        let source = current_commit_id(&path);
        let request = LandRequest {
            change_ids: vec![first, source.clone()],
            target_bookmark: "main".into(),
            expected_commit_id: Some(base.clone()),
            operation_key: "append/test/1".into(),
            append: Some(LandAppend {
                source_commit_id: source.clone(),
                source_base_commit_id: base.clone(),
                description: "✨ feat: coherent delivery".into(),
            }),
            ..Default::default()
        };
        let result = RepoHandle::open(&path)
            .unwrap()
            .land_request(&request)
            .unwrap();
        let reopened = RepoHandle::open(&path).unwrap();
        let appended = reopened
            .repo
            .store()
            .get_commit(
                &CommitId::try_from_hex(&result.target_commit_id)
                    .expect("validated immutable commit"),
            )
            .unwrap();
        assert_eq!(
            appended.parent_ids(),
            &[CommitId::try_from_hex(&base).expect("validated immutable commit")]
        );
        let original = reopened
            .repo
            .store()
            .get_commit(&CommitId::try_from_hex(&source).expect("validated immutable commit"))
            .unwrap();
        assert_eq!(appended.tree().tree_ids(), original.tree().tree_ids());
        assert_eq!(appended.description(), "✨ feat: coherent delivery");
        assert_eq!(
            resolve_change_or_commit_id(&reopened.repo, &source_change)
                .unwrap()
                .hex(),
            source
        );
        assert_ne!(result.target_commit_id, source);
        create_commit_with_files(&path, "other writer", &[("c", "c")]);
        let later = current_commit_id(&path);
        // Another writer (a sync push) moves main; bookmark API moves of main
        // only go forward.
        let handle = RepoHandle::open(&path).unwrap();
        let mut tx = handle.repo.start_transaction();
        tx.repo_mut().set_local_bookmark_target(
            RefName::new("main"),
            RefTarget::normal(CommitId::try_from_hex(&later).unwrap()),
        );
        tx.commit("other writer moves main").block_on().unwrap();
        let mut lookup = request.clone();
        lookup.lookup_only = true;
        assert_eq!(
            RepoHandle::open(&path)
                .unwrap()
                .land_request(&lookup)
                .unwrap(),
            result
        );
        assert_eq!(
            RepoHandle::open(&path)
                .unwrap()
                .land_request(&request)
                .unwrap(),
            result
        );
        assert_eq!(
            RepoHandle::open(&path)
                .unwrap()
                .get_bookmark("main")
                .unwrap()
                .unwrap()
                .target_commit_id,
            later
        );
        lookup.append.as_mut().unwrap().description = "different".into();
        assert!(matches!(
            RepoHandle::open(&path).unwrap().land_request(&lookup),
            Err(JjError::Conflict(_))
        ));
    }

    #[test]
    fn append_landing_accepts_existing_main_merge_history() {
        let tmp = TempDir::new().unwrap();
        let path = repo_path(&tmp);
        let path_c = c_path(&path);
        let _ = unsafe { take_json(smithers_init_repo(path_c.as_ptr())) };
        let handle = RepoHandle::open(&path).unwrap();
        let base = handle
            .repo
            .store()
            .get_commit(&CommitId::try_from_hex(current_commit_id(&path)).unwrap())
            .unwrap();
        let mut tx = handle.repo.start_transaction();
        let left = tx
            .repo_mut()
            .new_commit(vec![base.id().clone()], base.tree())
            .set_description("left")
            .write()
            .block_on()
            .unwrap();
        let right = tx
            .repo_mut()
            .new_commit(vec![base.id().clone()], base.tree())
            .set_description("right")
            .write()
            .block_on()
            .unwrap();
        let merged = tx
            .repo_mut()
            .new_commit(vec![left.id().clone(), right.id().clone()], base.tree())
            .set_description("existing merge on main")
            .write()
            .block_on()
            .unwrap();
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), merged.id().clone())
            .unwrap();
        tx.commit("existing merged history").block_on().unwrap();
        let main = merged.id().hex();
        RepoHandle::open(&path)
            .unwrap()
            .create_bookmark("main", &main)
            .unwrap();
        create_commit_with_files(&path, "new feature", &[("feature", "new")]);
        let source = current_commit_id(&path);
        let prepared = RepoHandle::open(&path)
            .unwrap()
            .prepare_append(append_prepare::AppendPreparationRequest {
                target_bookmark: "main".into(),
                expected_commit_id: main.clone(),
                source_commit_id: source.clone(),
                source_base_commit_id: main.clone(),
            })
            .unwrap();
        assert_eq!(
            serde_json::to_value(prepared).unwrap()["changes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let result = RepoHandle::open(&path)
            .unwrap()
            .land_request(&LandRequest {
                change_ids: vec![source.clone()],
                target_bookmark: "main".into(),
                expected_commit_id: Some(main.clone()),
                operation_key: "append/merged-main".into(),
                lookup_only: false,
                append: Some(LandAppend {
                    source_commit_id: source,
                    source_base_commit_id: main.clone(),
                    description: "new feature".into(),
                }),
            })
            .unwrap();
        assert_eq!(result.landed_count, 1);
        let handle = RepoHandle::open(&path).unwrap();
        let landed = handle
            .repo
            .store()
            .get_commit(&CommitId::try_from_hex(&result.target_commit_id).unwrap())
            .unwrap();
        assert_eq!(
            landed.parent_ids(),
            &[CommitId::try_from_hex(&main).unwrap()]
        );
    }

    #[test]
    fn append_preparation_reads_exact_required_suffix_without_mutation() {
        let tmp = TempDir::new().unwrap();
        let path = repo_path(&tmp);
        let path_c = c_path(&path);
        let _ = unsafe { take_json(smithers_init_repo(path_c.as_ptr())) };
        let base = current_commit_id(&path);
        RepoHandle::open(&path)
            .unwrap()
            .create_bookmark("main", &base)
            .unwrap();
        create_commit_with_files(&path, "first", &[("a", "a")]);
        let first = current_commit_id(&path);
        create_commit_with_files(&path, "second", &[("b", "b")]);
        let second = current_commit_id(&path);
        let request = append_prepare::AppendPreparationRequest {
            target_bookmark: "main".into(),
            expected_commit_id: base.clone(),
            source_commit_id: second.clone(),
            source_base_commit_id: base.clone(),
        };
        let before = RepoHandle::open(&path)
            .unwrap()
            .repo
            .operation()
            .id()
            .clone();
        let payload = CString::new(serde_json::to_string(&request).unwrap()).unwrap();
        let result = unsafe {
            take_json(append_prepare::smithers_prepare_land_append(
                path_c.as_ptr(),
                payload.as_ptr(),
            ))
        };
        assert_eq!(result["status"], "prepared");
        assert_eq!(
            result["changes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["commit_id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![first.as_str(), second.as_str()]
        );
        assert_eq!(
            RepoHandle::open(&path).unwrap().repo.operation().id(),
            &before
        );
        let mut stale = request.clone();
        stale.expected_commit_id = second;
        assert!(matches!(
            RepoHandle::open(&path).unwrap().prepare_append(stale),
            Err(JjError::Conflict(_))
        ));
        // An immutable retained object need not remain in JJ's visible index.
        let handle = RepoHandle::open(&path).unwrap();
        let parent = handle
            .repo
            .store()
            .get_commit(&CommitId::try_from_hex(&base).unwrap())
            .unwrap();
        let mut tx = handle.repo.start_transaction();
        let hidden = tx
            .repo_mut()
            .new_commit(vec![parent.id().clone()], parent.tree())
            .set_description("retained source")
            .write()
            .block_on()
            .unwrap();
        drop(tx);
        let hidden_request = append_prepare::AppendPreparationRequest {
            source_commit_id: hidden.id().hex(),
            ..request
        };
        assert!(RepoHandle::open(&path)
            .unwrap()
            .prepare_append(hidden_request)
            .is_ok());
        assert_eq!(
            RepoHandle::open(&path).unwrap().repo.operation().id(),
            &before
        );
    }

    #[test]
    fn append_landing_refuses_wrong_base_tip_and_missing_fences_without_mutation() {
        let tmp = TempDir::new().unwrap();
        let path = repo_path(&tmp);
        let path_c = c_path(&path);
        let _ = unsafe { take_json(smithers_init_repo(path_c.as_ptr())) };
        let base = current_commit_id(&path);
        create_commit_with_files(&path, "main changed", &[("a", "a")]);
        let main = current_commit_id(&path);
        RepoHandle::open(&path)
            .unwrap()
            .create_bookmark("main", &main)
            .unwrap();
        create_commit_with_files(&path, "source", &[("b", "b")]);
        let source = current_commit_id(&path);
        let mut request = LandRequest {
            change_ids: vec![source.clone()],
            target_bookmark: "main".into(),
            expected_commit_id: Some(main.clone()),
            operation_key: "append/test/2".into(),
            append: Some(LandAppend {
                source_commit_id: source,
                source_base_commit_id: base.clone(),
                description: "delivery".into(),
            }),
            ..Default::default()
        };
        let before = RepoHandle::open(&path)
            .unwrap()
            .repo
            .operation()
            .id()
            .clone();
        assert!(matches!(
            RepoHandle::open(&path).unwrap().land_request(&request),
            Err(JjError::Conflict(_))
        ));
        request.append.as_mut().unwrap().source_base_commit_id = main.clone();
        request.append.as_mut().unwrap().source_commit_id = base;
        assert!(matches!(
            RepoHandle::open(&path).unwrap().land_request(&request),
            Err(JjError::Conflict(_))
        ));
        request.expected_commit_id = None;
        assert!(matches!(
            RepoHandle::open(&path).unwrap().land_request(&request),
            Err(JjError::BadRequest(_))
        ));
        assert_eq!(
            RepoHandle::open(&path).unwrap().repo.operation().id(),
            &before
        );
        assert_eq!(
            RepoHandle::open(&path)
                .unwrap()
                .get_bookmark("main")
                .unwrap()
                .unwrap()
                .target_commit_id,
            main
        );
    }

    #[test]
    fn append_landing_preserves_legacy_receipt_json_and_requires_capability_payload() {
        let legacy = LandRequest {
            change_ids: vec!["a".into()],
            target_bookmark: "main".into(),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&legacy).unwrap(),
            r#"{"change_ids":["a"],"target_bookmark":"main","expected_commit_id":null,"operation_key":"","lookup_only":false}"#
        );
        let tmp = TempDir::new().unwrap();
        let path = repo_path(&tmp);
        let path_c = c_path(&path);
        let _ = unsafe { take_json(smithers_init_repo(path_c.as_ptr())) };
        let payload = CString::new(serde_json::to_string(&legacy).unwrap()).unwrap();
        let result = unsafe { take_json(smithers_land_append(path_c.as_ptr(), payload.as_ptr())) };
        assert_eq!(result["code"], "bad_request");
    }
    #[test]
    fn append_landing_requires_rewritten_owners_and_all_new_descendants() {
        let tmp = TempDir::new().unwrap();
        let path = repo_path(&tmp);
        let path_c = c_path(&path);
        let _ = unsafe { take_json(smithers_init_repo(path_c.as_ptr())) };
        create_commit_with_files(&path, "stable foundation", &[("foundation", "unchanged")]);
        let foundation = current_commit_id(&path);
        create_commit_with_files(&path, "old owner", &[("owned", "old")]);
        create_commit_with_files(&path, "existing descendant", &[("existing", "retained")]);
        let original = current_commit_id(&path);
        RepoHandle::open(&path)
            .unwrap()
            .create_bookmark("main", &original)
            .unwrap();
        create_commit_with_files(&path, "build revised tree", &[("owned", "new")]);
        let handle = RepoHandle::open(&path).unwrap();
        let source_tree = handle
            .repo
            .store()
            .get_commit(&CommitId::try_from_hex(current_commit_id(&path)).unwrap())
            .unwrap()
            .tree();
        let mut tx = handle.repo.start_transaction();
        let rewritten = tx
            .repo_mut()
            .new_commit(
                vec![CommitId::try_from_hex(&foundation).unwrap()],
                source_tree,
            )
            .set_description("revised owner")
            .write()
            .block_on()
            .unwrap();
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), rewritten.id().clone())
            .unwrap();
        tx.commit("rewrite historical owner").block_on().unwrap();
        create_commit_with_files(&path, "new feature", &[("new-feature", "ready")]);
        let source = current_commit_id(&path);
        let mut request = LandRequest {
            change_ids: vec![source.clone()],
            target_bookmark: "main".into(),
            expected_commit_id: Some(original.clone()),
            operation_key: "append/test/rewrite".into(),
            append: Some(LandAppend {
                source_commit_id: source.clone(),
                source_base_commit_id: original.clone(),
                description: "delivery".into(),
            }),
            ..Default::default()
        };
        let before = RepoHandle::open(&path)
            .unwrap()
            .repo
            .operation()
            .id()
            .clone();
        assert!(matches!(
            RepoHandle::open(&path).unwrap().land_request(&request),
            Err(JjError::Conflict(_))
        ));
        assert_eq!(
            RepoHandle::open(&path).unwrap().repo.operation().id(),
            &before
        );
        // A caller-forged base with main's tree but a rewritten owner as its
        // parent must not authenticate a partial reviewed suffix.
        let handle = RepoHandle::open(&path).unwrap();
        let main_tree = handle
            .repo
            .store()
            .get_commit(&CommitId::try_from_hex(&original).unwrap())
            .unwrap()
            .tree();
        let mut tx = handle.repo.start_transaction();
        let forged = tx
            .repo_mut()
            .new_commit(vec![rewritten.id().clone()], main_tree)
            .write()
            .block_on()
            .unwrap();
        tx.commit("forged caller base").block_on().unwrap();
        request.append.as_mut().unwrap().source_base_commit_id = forged.id().hex();
        assert!(matches!(
            RepoHandle::open(&path).unwrap().land_request(&request),
            Err(JjError::Conflict(_))
        ));
        request.append.as_mut().unwrap().source_base_commit_id = original.clone();
        request.change_ids = vec![rewritten.id().hex(), source];
        let result = RepoHandle::open(&path)
            .unwrap()
            .land_request(&request)
            .unwrap();
        let final_repo = RepoHandle::open(&path).unwrap();
        let final_commit = final_repo
            .repo
            .store()
            .get_commit(&CommitId::try_from_hex(&result.target_commit_id).unwrap())
            .unwrap();
        assert_eq!(
            final_commit.parent_ids(),
            &[CommitId::try_from_hex(&original).unwrap()]
        );
    }
    #[test]
    fn append_landing_bootstraps_full_history_then_anchors_an_abandoned_source() {
        let tmp = TempDir::new().unwrap();
        let path = repo_path(&tmp);
        let path_c = c_path(&path);
        let _ = unsafe { take_json(smithers_init_repo(path_c.as_ptr())) };
        create_commit_with_files(&path, "ordinary main", &[("foundation", "stable")]);
        let main = current_commit_id(&path);
        RepoHandle::open(&path)
            .unwrap()
            .create_bookmark("main", &main)
            .unwrap();
        let handle = RepoHandle::open(&path).unwrap();
        let main_tree = handle
            .repo
            .store()
            .get_commit(&CommitId::try_from_hex(&main).unwrap())
            .unwrap()
            .tree();
        let mut tx = handle.repo.start_transaction();
        let initial = tx
            .repo_mut()
            .new_commit(
                vec![handle.repo.store().root_commit_id().clone()],
                main_tree,
            )
            .set_description("independent mythical foundation")
            .write()
            .block_on()
            .unwrap();
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), initial.id().clone())
            .unwrap();
        tx.commit("import independent mythical foundation")
            .block_on()
            .unwrap();
        let change = create_commit_with_files(&path, "feature", &[("feature", "first")]);
        let source = current_commit_id(&path);
        let mut request = LandRequest {
            change_ids: vec![source.clone()],
            target_bookmark: "main".into(),
            expected_commit_id: Some(main),
            operation_key: "append/import".into(),
            append: Some(LandAppend {
                source_commit_id: source.clone(),
                source_base_commit_id: initial.id().hex(),
                description: "first delivery".into(),
            }),
            ..Default::default()
        };
        assert!(matches!(
            RepoHandle::open(&path).unwrap().land_request(&request),
            Err(JjError::Conflict(_))
        ));
        request.change_ids = vec![initial.id().hex(), source.clone()];
        let first = RepoHandle::open(&path)
            .unwrap()
            .land_request(&request)
            .unwrap();
        // A no-op workspace commit is allowed between the authenticated source
        // anchor and the next run's captured source base.
        let handle = RepoHandle::open(&path).unwrap();
        let source_commit = handle
            .repo
            .store()
            .get_commit(&CommitId::try_from_hex(&source).unwrap())
            .unwrap();
        let mut tx = handle.repo.start_transaction();
        let captured = tx
            .repo_mut()
            .new_commit(vec![source_commit.id().clone()], source_commit.tree())
            .write()
            .block_on()
            .unwrap();
        tx.commit("capture unchanged workspace base")
            .block_on()
            .unwrap();
        create_commit_with_files(&path, "revised tree", &[("feature", "revised")]);
        let handle = RepoHandle::open(&path).unwrap();
        let revised_tree = handle
            .repo
            .store()
            .get_commit(&CommitId::try_from_hex(current_commit_id(&path)).unwrap())
            .unwrap()
            .tree();
        let mut tx = handle.repo.start_transaction();
        let revised = tx
            .repo_mut()
            .rewrite_commit(&source_commit)
            .set_tree(revised_tree)
            .write()
            .block_on()
            .unwrap();
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), revised.id().clone())
            .unwrap();
        tx.repo_mut().rebase_descendants().block_on().unwrap();
        tx.commit("rewrite previously delivered source owner")
            .block_on()
            .unwrap();
        assert_eq!(
            resolve_change_or_commit_id(&RepoHandle::open(&path).unwrap().repo, &change).unwrap(),
            *revised.id()
        );
        request.change_ids = vec![revised.id().hex()];
        request.expected_commit_id = Some(first.target_commit_id.clone());
        request.operation_key = "append/second".into();
        request.append = Some(LandAppend {
            source_commit_id: revised.id().hex(),
            source_base_commit_id: captured.id().hex(),
            description: "second delivery".into(),
        });
        // Public main is also a valid immutable base: preparation must map it
        // through the recorded append receipt to the native source history.
        request.append.as_mut().unwrap().source_base_commit_id = first.target_commit_id.clone();
        let prepared = RepoHandle::open(&path)
            .unwrap()
            .prepare_append(append_prepare::AppendPreparationRequest {
                target_bookmark: "main".into(),
                expected_commit_id: first.target_commit_id.clone(),
                source_commit_id: revised.id().hex(),
                source_base_commit_id: first.target_commit_id.clone(),
            })
            .unwrap();
        let prepared = serde_json::to_value(prepared).unwrap();
        assert_eq!(prepared["changes"].as_array().unwrap().len(), 1);
        assert_eq!(prepared["changes"][0]["commit_id"], revised.id().hex());
        let second = RepoHandle::open(&path)
            .unwrap()
            .land_request(&request)
            .unwrap();
        let handle = RepoHandle::open(&path).unwrap();
        let final_commit = handle
            .repo
            .store()
            .get_commit(&CommitId::try_from_hex(&second.target_commit_id).unwrap())
            .unwrap();
        assert_eq!(
            final_commit.parent_ids(),
            &[CommitId::try_from_hex(&first.target_commit_id).unwrap()]
        );
        assert_eq!(final_commit.tree().tree_ids(), revised.tree().tree_ids());
    }

    #[test]
    fn append_landing_accepts_1024_commits_and_refuses_larger_input() {
        let tmp = TempDir::new().unwrap();
        let path = repo_path(&tmp);
        let path_c = c_path(&path);
        let _ = unsafe { take_json(smithers_init_repo(path_c.as_ptr())) };
        let base = current_commit_id(&path);
        RepoHandle::open(&path)
            .unwrap()
            .create_bookmark("main", &base)
            .unwrap();
        let handle = RepoHandle::open(&path).unwrap();
        let initial = handle
            .repo
            .store()
            .get_commit(&CommitId::try_from_hex(&base).unwrap())
            .unwrap();
        let mut tx = handle.repo.start_transaction();
        let mut parent = initial.id().clone();
        let mut ids = Vec::new();
        for i in 0..1024 {
            let commit = tx
                .repo_mut()
                .new_commit(vec![parent], initial.tree())
                .set_description(format!("native atom {i}"))
                .write()
                .block_on()
                .unwrap();
            parent = commit.id().clone();
            ids.push(parent.hex());
        }
        tx.commit("complete bounded mythical stack")
            .block_on()
            .unwrap();
        let request = LandRequest {
            change_ids: ids.clone(),
            target_bookmark: "main".into(),
            expected_commit_id: Some(base.clone()),
            operation_key: "append/max-bound".into(),
            append: Some(LandAppend {
                source_commit_id: ids.last().unwrap().clone(),
                source_base_commit_id: base.clone(),
                description: "bounded complete history".into(),
            }),
            ..Default::default()
        };
        let mut too_large = request.clone();
        too_large.change_ids.insert(0, base.clone());
        let before = RepoHandle::open(&path)
            .unwrap()
            .repo
            .operation()
            .id()
            .clone();
        assert!(matches!(
            RepoHandle::open(&path).unwrap().land_request(&too_large),
            Err(JjError::BadRequest(_))
        ));
        assert_eq!(
            RepoHandle::open(&path).unwrap().repo.operation().id(),
            &before
        );
        let result = RepoHandle::open(&path)
            .unwrap()
            .land_request(&request)
            .unwrap();
        assert_eq!(result.landed_count, 1024);
        let handle = RepoHandle::open(&path).unwrap();
        let published = handle
            .repo
            .store()
            .get_commit(&CommitId::try_from_hex(&result.target_commit_id).unwrap())
            .unwrap();
        assert_eq!(
            published.parent_ids(),
            &[CommitId::try_from_hex(&base).unwrap()]
        );
        assert_eq!(published.tree().tree_ids(), initial.tree().tree_ids());
    }
}
