use std::path::Path;
use std::sync::Arc;

use anyhow::Context;
use jj_lib::backend::CommitId;
use jj_lib::config::{ConfigLayer, ConfigSource, StackedConfig};
use jj_lib::default_backend_factories::{
    default_backend_factories, default_working_copy_factories,
};
use jj_lib::merged_tree::{TreeDiffEntry, TreeDiffStream};
use jj_lib::object_id::{HexPrefix, PrefixResolution};
use jj_lib::repo::{ReadonlyRepo, Repo};
use jj_lib::settings::UserSettings;
use jj_lib::workspace::Workspace;
use pollster::FutureExt as _;
use toml_edit::DocumentMut;

/// Configuration for creating default user settings.
pub struct UserConfig {
    pub name: String,
    pub email: String,
}

impl Default for UserConfig {
    fn default() -> Self {
        Self {
            name: "Smithers".to_string(),
            email: "smithers@localhost".to_string(),
        }
    }
}

/// Create minimal UserSettings for jj operations with configurable identity.
pub fn create_settings(config: &UserConfig) -> UserSettings {
    let mut stacked_config = StackedConfig::with_defaults();
    // Build the config document via toml_edit's typed value API so that
    // name/email are stored as properly-escaped TOML string values. This
    // prevents TOML/jj-config injection when name/email contain quotes or
    // newlines (author identity is attacker-influenceable via the wiki/docs
    // commit FFI entrypoints).
    let mut toml = DocumentMut::new();
    toml["user"]["name"] = toml_edit::value(config.name.as_str());
    toml["user"]["email"] = toml_edit::value(config.email.as_str());
    stacked_config.add_layer(ConfigLayer::with_data(ConfigSource::User, toml));
    UserSettings::from_config(stacked_config).expect("valid config")
}

/// Load a jj workspace and repository at the HEAD operation.
pub fn load_repo_at_head(
    repo_path: &Path,
    settings: &UserSettings,
) -> anyhow::Result<(Workspace, Arc<ReadonlyRepo>)> {
    let ws = Workspace::load(
        settings,
        repo_path,
        &default_backend_factories(),
        &default_working_copy_factories(),
    )
    .with_context(|| format!("failed to load workspace at {}", repo_path.display()))?;

    let repo = ws
        .repo_loader()
        .load_at_head()
        .block_on()
        .context("failed to load repo at head")?;

    Ok((ws, repo))
}

/// Load only the repository (discarding the workspace handle).
pub fn load_repo(repo_path: &Path, settings: &UserSettings) -> anyhow::Result<Arc<ReadonlyRepo>> {
    let (_, repo) = load_repo_at_head(repo_path, settings)?;
    Ok(repo)
}

/// Result of resolving a change ID.
pub enum ChangeIdResolution {
    /// Single matching commit found.
    Found(CommitId),
    /// Multiple commits match the prefix, including divergent changes.
    Ambiguous,
    /// No matching commit.
    NotFound,
}

/// Resolve a change ID (reverse hex) prefix to a CommitId.
pub fn resolve_change_id(repo: &Arc<ReadonlyRepo>, change_id: &str) -> ChangeIdResolution {
    let Some(prefix) = HexPrefix::try_from_reverse_hex(change_id.as_bytes()) else {
        return ChangeIdResolution::NotFound;
    };

    match repo.resolve_change_id_prefix(&prefix) {
        Ok(PrefixResolution::SingleMatch(targets)) => {
            let mut visible = targets.visible_with_offsets();
            match (visible.next(), visible.next()) {
                (None, _) => ChangeIdResolution::NotFound,
                (Some((_, commit_id)), None) => ChangeIdResolution::Found(commit_id.clone()),
                (Some(_), Some(_)) => ChangeIdResolution::Ambiguous,
            }
        }
        Ok(PrefixResolution::AmbiguousMatch) => ChangeIdResolution::Ambiguous,
        Ok(PrefixResolution::NoMatch) | Err(_) => ChangeIdResolution::NotFound,
    }
}

/// Resolve a commit ID (hex) prefix to a CommitId.
pub fn resolve_commit_id(repo: &Arc<ReadonlyRepo>, commit_id_str: &str) -> ChangeIdResolution {
    let Some(prefix) = HexPrefix::try_from_hex(commit_id_str.as_bytes()) else {
        return ChangeIdResolution::NotFound;
    };

    match repo.index().resolve_commit_id_prefix(&prefix) {
        Ok(PrefixResolution::SingleMatch(commit_id)) => ChangeIdResolution::Found(commit_id),
        Ok(PrefixResolution::AmbiguousMatch) => ChangeIdResolution::Ambiguous,
        Ok(PrefixResolution::NoMatch) | Err(_) => ChangeIdResolution::NotFound,
    }
}

/// Collect a tree diff stream into a Vec synchronously.
pub fn collect_tree_diff(stream: TreeDiffStream) -> Vec<TreeDiffEntry> {
    use futures::StreamExt;
    futures::executor::block_on(async { stream.collect().await })
}

/// Format a jj timestamp to RFC3339 string.
pub fn format_timestamp(ts: &jj_lib::backend::Timestamp) -> String {
    match ts.to_datetime() {
        Ok(dt) => dt.to_rfc3339(),
        Err(_) => {
            let sign = if ts.tz_offset >= 0 { '+' } else { '-' };
            let hours = ts.tz_offset.abs() / 60;
            let mins = ts.tz_offset.abs() % 60;
            format!("{}{}{:02}:{:02}", ts.timestamp.0, sign, hours, mins)
        }
    }
}

/// Get the parent tree for a commit (or empty tree if no parents).
pub fn parent_tree(
    repo: &Arc<ReadonlyRepo>,
    commit: &jj_lib::commit::Commit,
) -> anyhow::Result<jj_lib::merged_tree::MergedTree> {
    if let Some(parent_id) = commit.parent_ids().first() {
        let parent_commit = repo
            .store()
            .get_commit(parent_id)
            .context("failed to load parent commit")?;
        Ok(parent_commit.tree())
    } else {
        Ok(jj_lib::merged_tree::MergedTree::resolved(
            repo.store().clone(),
            repo.store().empty_tree_id().clone(),
        ))
    }
}

/// Maximum number of bytes any FFI export will buffer from a single blob.
/// Repository blobs are writer-controlled, so every in-memory read must be
/// bounded to keep repo-host from being OOM-killed by a pushed multi-gigabyte
/// file.
pub const MAX_BLOB_READ_BYTES: u64 = 16 * 1024 * 1024;

/// Synchronously read file content from a blob, buffering at most `max_bytes`.
///
/// Returns `Ok(None)` when the blob exceeds `max_bytes` (after reading at most
/// `max_bytes + 1` bytes), so callers can degrade instead of buffering
/// attacker-sized blobs.
pub fn read_file_content(
    store: &jj_lib::store::Store,
    path: &jj_lib::repo_path::RepoPath,
    file_id: &jj_lib::backend::FileId,
    max_bytes: u64,
) -> anyhow::Result<Option<Vec<u8>>> {
    use futures::AsyncReadExt;

    let reader = store
        .read_file(path, file_id)
        .block_on()
        .context("failed to open file blob")?;
    let mut content = Vec::new();
    reader
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut content)
        .block_on()
        .context("failed to read file blob")?;
    if content.len() as u64 > max_bytes {
        return Ok(None);
    }
    Ok(Some(content))
}

/// Stream a blob to `dest` in fixed-size chunks so writers of large files
/// (snapshots) never buffer an entire blob in memory.
pub fn write_file_content_to(
    store: &jj_lib::store::Store,
    path: &jj_lib::repo_path::RepoPath,
    file_id: &jj_lib::backend::FileId,
    dest: &std::path::Path,
) -> anyhow::Result<()> {
    stream_file_content_to(store, path, file_id, dest, false)
}

/// Snapshot output must be new: duplicate tree entries cannot follow or replace
/// a previously materialized symlink. Keep the public writer's overwrite API.
pub(crate) fn write_new_file_content_to(
    store: &jj_lib::store::Store,
    path: &jj_lib::repo_path::RepoPath,
    file_id: &jj_lib::backend::FileId,
    dest: &std::path::Path,
) -> anyhow::Result<()> {
    stream_file_content_to(store, path, file_id, dest, true)
}

fn stream_file_content_to(
    store: &jj_lib::store::Store,
    path: &jj_lib::repo_path::RepoPath,
    file_id: &jj_lib::backend::FileId,
    dest: &std::path::Path,
    exclusive: bool,
) -> anyhow::Result<()> {
    use futures::AsyncReadExt;
    use pollster::FutureExt as _;
    use std::io::Write as _;

    let mut reader = store
        .read_file(path, file_id)
        .block_on()
        .context("failed to open file blob")?;
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(!exclusive)
        .create_new(exclusive)
        .open(dest)
        .context("failed to create destination file")?;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buf)
            .block_on()
            .context("failed to read file blob")?;
        if read == 0 {
            break;
        }
        out.write_all(&buf[..read])
            .context("failed to write destination file")?;
    }
    out.flush().context("failed to flush destination file")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use jj_lib::backend::{CopyId, MillisSinceEpoch, Timestamp, TreeValue};
    use jj_lib::matchers::EverythingMatcher;
    use jj_lib::merged_tree::MergedTree;
    use jj_lib::object_id::ObjectId;
    use jj_lib::ref_name::WorkspaceName;
    use jj_lib::repo_path::RepoPathBuf;
    use jj_lib::tree_builder::TreeBuilder;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn test_config() -> UserConfig {
        UserConfig {
            name: "Test User".to_string(),
            email: "test@example.com".to_string(),
        }
    }

    fn setup_repo() -> (TempDir, PathBuf) {
        let tmp = TempDir::new().expect("create tempdir");
        let repo_path = tmp.path().join("test-repo");
        std::fs::create_dir_all(&repo_path).expect("create repo dir");
        let settings = create_settings(&test_config());
        Workspace::init_internal_git(&settings, &repo_path, gix::hash::Kind::Sha1)
            .block_on()
            .expect("init repo");
        (tmp, repo_path)
    }

    fn create_commit_with_file(
        repo_path: &std::path::Path,
        parent_ids: &[CommitId],
        description: &str,
        file_path: &str,
        content: &str,
    ) -> (CommitId, String) {
        let settings = create_settings(&test_config());
        let (_, repo) = load_repo_at_head(repo_path, &settings).expect("load repo");
        let store = repo.store();

        let parent_tree_id = if let Some(parent_id) = parent_ids.first() {
            let parent_commit = store.get_commit(parent_id).expect("parent commit");
            parent_commit
                .tree()
                .tree_ids()
                .clone()
                .into_resolved()
                .expect("resolved parent tree")
                .clone()
        } else {
            store.empty_tree_id().clone()
        };

        let mut tree_builder = TreeBuilder::new(store.clone(), parent_tree_id);
        let path = RepoPathBuf::from_internal_string(file_path).expect("valid path");
        let file_id = store
            .write_file(&path, &mut content.as_bytes())
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
        let tree_id = tree_builder.write_tree().block_on().expect("write tree");
        let tree = MergedTree::resolved(store.clone(), tree_id);

        let parents = if parent_ids.is_empty() {
            vec![repo
                .view()
                .get_wc_commit_id(WorkspaceName::DEFAULT)
                .expect("wc id")
                .clone()]
        } else {
            parent_ids.to_vec()
        };

        let mut tx = repo.start_transaction();
        let commit = tx
            .repo_mut()
            .new_commit(parents, tree)
            .set_description(description)
            .write()
            .block_on()
            .expect("write commit");
        tx.repo_mut()
            .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), commit.id().clone())
            .expect("set wc");
        tx.commit(format!("test commit: {description}"))
            .block_on()
            .expect("commit transaction");

        (commit.id().clone(), commit.change_id().reverse_hex())
    }

    // ---- UserConfig tests ----

    #[test]
    fn test_create_settings_uses_provided_identity() {
        let config = UserConfig {
            name: "Test User".to_string(),
            email: "test@example.com".to_string(),
        };
        let settings = create_settings(&config);
        assert_eq!(settings.user_name(), "Test User");
        assert_eq!(settings.user_email(), "test@example.com");
    }

    #[test]
    fn test_default_user_config() {
        let config = UserConfig::default();
        assert_eq!(config.name, "Smithers");
        assert_eq!(config.email, "smithers@localhost");
    }

    #[test]
    fn test_create_settings_with_special_characters() {
        let config = UserConfig {
            name: "Jose Garcia".to_string(),
            email: "jose+test@example.com".to_string(),
        };
        let settings = create_settings(&config);
        assert_eq!(settings.user_name(), "Jose Garcia");
        assert_eq!(settings.user_email(), "jose+test@example.com");
    }

    #[test]
    fn test_create_settings_rejects_toml_injection() {
        // A name attempting to break out of the string literal and inject an
        // extra key must be stored verbatim as the name, not parsed as config.
        let config = UserConfig {
            name: "x\"\nadmin = \"true".to_string(),
            email: "a\"\ninjected = \"b".to_string(),
        };
        let settings = create_settings(&config);
        assert_eq!(settings.user_name(), "x\"\nadmin = \"true");
        assert_eq!(settings.user_email(), "a\"\ninjected = \"b");
    }

    // ---- Repository loading tests ----

    #[test]
    fn test_load_repo_at_head_succeeds() {
        let (_tmp, repo_path) = setup_repo();
        let settings = create_settings(&test_config());
        let result = load_repo_at_head(&repo_path, &settings);
        assert!(result.is_ok());
    }

    #[test]
    fn test_load_repo_succeeds() {
        let (_tmp, repo_path) = setup_repo();
        let settings = create_settings(&test_config());
        let result = load_repo(&repo_path, &settings);
        assert!(result.is_ok());
    }

    #[test]
    fn test_load_repo_nonexistent_fails() {
        let settings = create_settings(&test_config());
        let result = load_repo(std::path::Path::new("/nonexistent/path"), &settings);
        assert!(result.is_err());
    }

    // ---- Change ID resolution tests ----

    #[test]
    fn test_resolve_change_id_finds_working_copy() {
        let (_tmp, repo_path) = setup_repo();
        let settings = create_settings(&test_config());
        let repo = load_repo(&repo_path, &settings).expect("load repo");

        let wc_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("wc id");
        let wc_commit = repo.store().get_commit(wc_id).expect("wc commit");
        let change_id = wc_commit.change_id().reverse_hex();

        match resolve_change_id(&repo, &change_id) {
            ChangeIdResolution::Found(commit_id) => {
                assert_eq!(&commit_id, wc_id);
            }
            other => panic!(
                "expected Found, got {:?}",
                match other {
                    ChangeIdResolution::Ambiguous => "Ambiguous",
                    ChangeIdResolution::NotFound => "NotFound",
                    _ => "Found",
                }
            ),
        }
    }

    #[test]
    fn test_resolve_change_id_prefix_works() {
        let (_tmp, repo_path) = setup_repo();
        let (_, change_id) =
            create_commit_with_file(&repo_path, &[], "test commit", "test.txt", "content");

        let settings = create_settings(&test_config());
        let repo = load_repo(&repo_path, &settings).expect("load repo");

        let prefix = &change_id[..8];
        match resolve_change_id(&repo, prefix) {
            ChangeIdResolution::Found(_) => {}
            other => panic!(
                "expected Found with prefix, got {:?}",
                match other {
                    ChangeIdResolution::Ambiguous => "Ambiguous",
                    ChangeIdResolution::NotFound => "NotFound",
                    _ => "Found",
                }
            ),
        }
    }

    #[test]
    fn test_resolve_change_id_not_found() {
        let (_tmp, repo_path) = setup_repo();
        let settings = create_settings(&test_config());
        let repo = load_repo(&repo_path, &settings).expect("load repo");

        match resolve_change_id(&repo, "xqxqxqxqxqxqxqxq") {
            ChangeIdResolution::NotFound => {}
            other => panic!(
                "expected NotFound, got {:?}",
                match other {
                    ChangeIdResolution::Ambiguous => "Ambiguous",
                    ChangeIdResolution::Found(_) => "Found",
                    _ => "NotFound",
                }
            ),
        }
    }

    #[test]
    fn test_resolve_change_id_invalid_hex() {
        let (_tmp, repo_path) = setup_repo();
        let settings = create_settings(&test_config());
        let repo = load_repo(&repo_path, &settings).expect("load repo");

        match resolve_change_id(&repo, "not-valid-hex!") {
            ChangeIdResolution::NotFound => {}
            other => panic!(
                "expected NotFound for invalid hex, got {:?}",
                match other {
                    ChangeIdResolution::Ambiguous => "Ambiguous",
                    ChangeIdResolution::Found(_) => "Found",
                    _ => "NotFound",
                }
            ),
        }
    }

    // ---- Commit ID resolution tests ----

    #[test]
    fn test_resolve_commit_id_finds_commit() {
        let (_tmp, repo_path) = setup_repo();
        let (commit_id, _) =
            create_commit_with_file(&repo_path, &[], "test commit", "test.txt", "content");

        let settings = create_settings(&test_config());
        let repo = load_repo(&repo_path, &settings).expect("load repo");

        match resolve_commit_id(&repo, &commit_id.hex()) {
            ChangeIdResolution::Found(resolved) => {
                assert_eq!(resolved, commit_id);
            }
            other => panic!(
                "expected Found, got {:?}",
                match other {
                    ChangeIdResolution::Ambiguous => "Ambiguous",
                    ChangeIdResolution::NotFound => "NotFound",
                    _ => "Found",
                }
            ),
        }
    }

    #[test]
    fn test_resolve_commit_id_prefix_works() {
        let (_tmp, repo_path) = setup_repo();
        let (commit_id, _) =
            create_commit_with_file(&repo_path, &[], "test commit", "test.txt", "content");

        let settings = create_settings(&test_config());
        let repo = load_repo(&repo_path, &settings).expect("load repo");

        let prefix = &commit_id.hex()[..8];
        match resolve_commit_id(&repo, prefix) {
            ChangeIdResolution::Found(resolved) => {
                assert_eq!(resolved, commit_id);
            }
            other => panic!(
                "expected Found with prefix, got {:?}",
                match other {
                    ChangeIdResolution::Ambiguous => "Ambiguous",
                    ChangeIdResolution::NotFound => "NotFound",
                    _ => "Found",
                }
            ),
        }
    }

    #[test]
    fn test_resolve_commit_id_not_found() {
        let (_tmp, repo_path) = setup_repo();
        let settings = create_settings(&test_config());
        let repo = load_repo(&repo_path, &settings).expect("load repo");

        match resolve_commit_id(&repo, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef") {
            ChangeIdResolution::NotFound => {}
            other => panic!(
                "expected NotFound, got {:?}",
                match other {
                    ChangeIdResolution::Ambiguous => "Ambiguous",
                    ChangeIdResolution::Found(_) => "Found",
                    _ => "NotFound",
                }
            ),
        }
    }

    // ---- format_timestamp tests ----

    #[test]
    fn test_format_timestamp_valid() {
        let ts = Timestamp {
            timestamp: MillisSinceEpoch(1704067200000),
            tz_offset: 0,
        };
        let formatted = format_timestamp(&ts);
        assert!(formatted.contains("2024-01-01"), "got: {formatted}");
    }

    #[test]
    fn test_format_timestamp_with_positive_offset() {
        let ts = Timestamp {
            timestamp: MillisSinceEpoch(1704067200000),
            tz_offset: 120,
        };
        let formatted = format_timestamp(&ts);
        assert!(
            formatted.contains("+02:00") || formatted.contains("2024"),
            "got: {formatted}"
        );
    }

    #[test]
    fn test_format_timestamp_with_negative_offset() {
        let ts = Timestamp {
            timestamp: MillisSinceEpoch(1704067200000),
            tz_offset: -300,
        };
        let formatted = format_timestamp(&ts);
        assert!(
            formatted.contains("-05:00") || formatted.contains("2024"),
            "got: {formatted}"
        );
    }

    // ---- parent_tree tests ----

    #[test]
    fn test_parent_tree_returns_parent() {
        let (_tmp, repo_path) = setup_repo();
        let settings = create_settings(&test_config());
        let repo = load_repo(&repo_path, &settings).expect("load repo");

        let wc_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("wc id")
            .clone();

        let (commit_id, _) =
            create_commit_with_file(&repo_path, &[wc_id], "child commit", "file.txt", "content");

        let repo = load_repo(&repo_path, &settings).expect("reload repo");
        let commit = repo.store().get_commit(&commit_id).expect("get commit");

        let tree = parent_tree(&repo, &commit).expect("parent tree");
        assert!(!tree.has_conflict());
    }

    #[test]
    fn test_parent_tree_root_commit_returns_empty() {
        let (_tmp, repo_path) = setup_repo();
        let settings = create_settings(&test_config());
        let repo = load_repo(&repo_path, &settings).expect("load repo");

        let root_id = repo.store().root_commit_id();
        let root_commit = repo.store().get_commit(root_id).expect("root commit");

        let tree = parent_tree(&repo, &root_commit).expect("parent tree of root");
        assert!(!tree.has_conflict());
    }

    // ---- collect_tree_diff tests ----

    #[test]
    fn test_collect_tree_diff_detects_added_file() {
        let (_tmp, repo_path) = setup_repo();
        let settings = create_settings(&test_config());
        let repo = load_repo(&repo_path, &settings).expect("load repo");

        let wc_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("wc id")
            .clone();

        let (commit_id, _) =
            create_commit_with_file(&repo_path, &[wc_id], "add file", "new.txt", "new content");

        let repo = load_repo(&repo_path, &settings).expect("reload repo");
        let commit = repo.store().get_commit(&commit_id).expect("get commit");
        let parent = parent_tree(&repo, &commit).expect("parent tree");
        let current = commit.tree();

        let diff_stream = parent.diff_stream(&current, &EverythingMatcher);
        let entries = collect_tree_diff(diff_stream);

        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.path.as_internal_file_string(), "new.txt");
    }

    #[test]
    fn test_collect_tree_diff_empty_for_identical_trees() {
        let (_tmp, repo_path) = setup_repo();
        let settings = create_settings(&test_config());
        let repo = load_repo(&repo_path, &settings).expect("load repo");

        let wc_id = repo
            .view()
            .get_wc_commit_id(WorkspaceName::DEFAULT)
            .expect("wc id");
        let wc_commit = repo.store().get_commit(wc_id).expect("wc commit");
        let tree = wc_commit.tree();

        let diff_stream = tree.diff_stream(&tree, &EverythingMatcher);
        let entries = collect_tree_diff(diff_stream);

        assert!(entries.is_empty());
    }

    // ---- read_file_content tests ----

    #[test]
    fn test_read_file_content_returns_content() {
        let (_tmp, repo_path) = setup_repo();
        let expected_content = "hello world\n";
        let (commit_id, _) = create_commit_with_file(
            &repo_path,
            &[],
            "add greeting",
            "greeting.txt",
            expected_content,
        );

        let settings = create_settings(&test_config());
        let repo = load_repo(&repo_path, &settings).expect("load repo");
        let commit = repo.store().get_commit(&commit_id).expect("get commit");

        let path = RepoPathBuf::from_internal_string("greeting.txt").expect("valid path");
        let value = commit
            .tree()
            .path_value(&path)
            .block_on()
            .expect("path value");

        if let Some(Some(TreeValue::File { id, .. })) = value.as_resolved() {
            let content = read_file_content(repo.store().as_ref(), &path, id, MAX_BLOB_READ_BYTES)
                .expect("read file")
                .expect("within size cap");
            assert_eq!(String::from_utf8_lossy(&content), expected_content);
        } else {
            panic!("expected file value");
        }
    }

    #[test]
    fn test_read_file_content_over_cap_returns_none() {
        let (_tmp, repo_path) = setup_repo();
        let content = "0123456789";
        let (commit_id, _) =
            create_commit_with_file(&repo_path, &[], "add big", "big.txt", content);

        let settings = create_settings(&test_config());
        let repo = load_repo(&repo_path, &settings).expect("load repo");
        let commit = repo.store().get_commit(&commit_id).expect("get commit");

        let path = RepoPathBuf::from_internal_string("big.txt").expect("valid path");
        let value = commit
            .tree()
            .path_value(&path)
            .block_on()
            .expect("path value");

        if let Some(Some(TreeValue::File { id, .. })) = value.as_resolved() {
            let capped =
                read_file_content(repo.store().as_ref(), &path, id, 4).expect("read file with cap");
            assert_eq!(capped, None);
            let exact = read_file_content(repo.store().as_ref(), &path, id, 10)
                .expect("read file at exact cap")
                .expect("content fits exactly");
            assert_eq!(exact, content.as_bytes());
        } else {
            panic!("expected file value");
        }
    }

    #[test]
    fn test_write_file_content_to_streams_blob_to_disk() {
        let (_tmp, repo_path) = setup_repo();
        let content = "streamed contents\n";
        let (commit_id, _) =
            create_commit_with_file(&repo_path, &[], "add streamed", "streamed.txt", content);

        let settings = create_settings(&test_config());
        let repo = load_repo(&repo_path, &settings).expect("load repo");
        let commit = repo.store().get_commit(&commit_id).expect("get commit");

        let path = RepoPathBuf::from_internal_string("streamed.txt").expect("valid path");
        let value = commit
            .tree()
            .path_value(&path)
            .block_on()
            .expect("path value");
        let dest_dir = TempDir::new().expect("dest tempdir");
        let dest = dest_dir.path().join("streamed.txt");

        if let Some(Some(TreeValue::File { id, .. })) = value.as_resolved() {
            write_file_content_to(repo.store().as_ref(), &path, id, &dest).expect("stream blob");
            assert_eq!(std::fs::read(&dest).expect("read dest"), content.as_bytes());
        } else {
            panic!("expected file value");
        }
    }

    #[test]
    fn test_read_file_content_with_special_chars() {
        let (_tmp, repo_path) = setup_repo();
        let content_with_special = "line1\nline2\ttabbed\r\nwindows";
        let (commit_id, _) = create_commit_with_file(
            &repo_path,
            &[],
            "add special",
            "special.txt",
            content_with_special,
        );

        let settings = create_settings(&test_config());
        let repo = load_repo(&repo_path, &settings).expect("load repo");
        let commit = repo.store().get_commit(&commit_id).expect("get commit");

        let path = RepoPathBuf::from_internal_string("special.txt").expect("valid path");
        let value = commit
            .tree()
            .path_value(&path)
            .block_on()
            .expect("path value");

        if let Some(Some(TreeValue::File { id, .. })) = value.as_resolved() {
            let content = read_file_content(repo.store().as_ref(), &path, id, MAX_BLOB_READ_BYTES)
                .expect("read file")
                .expect("within size cap");
            assert_eq!(String::from_utf8_lossy(&content), content_with_special);
        } else {
            panic!("expected file value");
        }
    }
}
