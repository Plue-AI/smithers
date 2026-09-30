//! Private guest preflight for files written by compensable standard tools.
//! Matching stays in jj-lib; this module only supplies its native configuration
//! and ignore-file chain. It never snapshots, writes a tree, or loads op heads.
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context};
use jj_lib::backend::{CommitId, TreeValue};
use jj_lib::default_backend_factories::{
    default_backend_factories, default_working_copy_factories,
};
use jj_lib::fileset::{self, FilesetAliasesMap, FilesetDiagnostics, FilesetParseContext};
use jj_lib::gitignore::GitIgnoreFile;
use jj_lib::matchers::{Matcher, PrefixMatcher};
use jj_lib::repo_path::{RepoPath, RepoPathUiConverter};
use jj_lib::settings::HumanByteSize;
use jj_lib::workspace::Workspace;
use pollster::FutureExt as _;
use serde::{Deserialize, Serialize};
use smithers_ffi::jj_core::{create_settings, UserConfig};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Input {
    commit_id: String,
    path: String,
    byte_length: u64,
    auto_track: String,
    max_new_file_size: String,
    fileset_aliases: String,
}

#[derive(Serialize)]
pub(super) struct Eligibility {
    eligible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

impl Eligibility {
    fn refuse(reason: &'static str) -> Self {
        Self {
            eligible: false,
            reason: Some(reason),
        }
    }

    fn allow() -> Self {
        Self {
            eligible: true,
            reason: None,
        }
    }
}

pub(super) fn check(repository: &Path, input: Input) -> anyhow::Result<Eligibility> {
    let repository = repository
        .canonicalize()
        .context("repository root is unavailable")?;
    let path =
        RepoPath::from_internal_string(&input.path).context("invalid repository-relative path")?;
    if path.is_root() || input.path.len() > 4096 || input.path.contains('\0') {
        bail!("expected a bounded repository-relative file path");
    }
    let parts: Vec<_> = input.path.split('/').collect();
    if parts.iter().any(|part| matches!(*part, "" | "." | "..")) || input.path.contains('\\') {
        bail!("expected a normalized repository-relative file path");
    }
    if parts
        .iter()
        .any(|part| part.eq_ignore_ascii_case(".jj") || part.eq_ignore_ascii_case(".git"))
    {
        return Ok(Eligibility::refuse("repository_metadata"));
    }

    // A tree snapshots symlink text, not the referent modified by a normal file
    // write. Refuse symlink traversal and nonregular file targets explicitly.
    let mut disk = repository.clone();
    for (index, part) in parts.iter().enumerate() {
        disk.push(part);
        match std::fs::symlink_metadata(&disk) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Ok(Eligibility::refuse("symlink_path"));
                }
                let leaf = index + 1 == parts.len();
                if (leaf && !metadata.is_file()) || (!leaf && !metadata.is_dir()) {
                    return Ok(Eligibility::refuse("nonregular_path"));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("cannot inspect candidate file path"),
        }
    }

    let settings = create_settings(&UserConfig::default());
    let workspace = Workspace::load(
        &settings,
        &repository,
        &default_backend_factories(),
        &default_working_copy_factories(),
    )?;
    if !PrefixMatcher::new(workspace.working_copy().sparse_patterns()?).matches(path) {
        return Ok(Eligibility::refuse("outside_sparse_snapshot"));
    }
    let store = workspace.repo_loader().store();
    if input.commit_id.len() != store.commit_id_length() * 2
        || !input
            .commit_id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        bail!("expected a full lowercase immutable commit ID");
    }
    let commit = store
        .get_commit(&CommitId::try_from_hex(&input.commit_id).context("invalid commit ID")?)?;
    let value = commit.tree().path_value(path).block_on()?;
    match value.as_resolved() {
        // JJ continues tracking existing files regardless of ignore, auto-track
        // and new-file size rules. No local pattern implementation overrides it.
        Some(Some(TreeValue::File { .. })) => return Ok(Eligibility::allow()),
        Some(None) => {}
        _ => return Ok(Eligibility::refuse("unsupported_tree_entry")),
    }
    // New ignore rules can exclude the very file being created; byte length
    // alone cannot prove its post-write eligibility. Native preparation can
    // track this file first. Existing tracked ignore files remain editable.
    if parts
        .last()
        .is_some_and(|name| name.eq_ignore_ascii_case(".gitignore"))
    {
        return Ok(Eligibility::refuse("untracked_ignore_file"));
    }

    let mut ignores = base_ignores(&repository, store)?;
    let mut parent = String::new();
    for (index, part) in parts.iter().enumerate() {
        let prefix = RepoPath::from_internal_string(&parent)?;
        ignores = ignores.chain_with_file(prefix, repository.join(&parent).join(".gitignore"))?;
        if !parent.is_empty() {
            parent.push('/');
        }
        parent.push_str(part);
        let candidate = RepoPath::from_internal_string(&parent)?;
        if index + 1 == parts.len() {
            if ignores.matches_file(candidate) {
                return Ok(Eligibility::refuse("ignored_path"));
            }
        } else if ignores.matches_dir(candidate) {
            // Native JJ does not descend into an ignored directory to find
            // child .gitignore files, so negation there cannot reinclude it.
            return Ok(Eligibility::refuse("ignored_directory"));
        }
    }

    let mut aliases = FilesetAliasesMap::new();
    let config: toml_edit::DocumentMut = input
        .fileset_aliases
        .parse()
        .context("unsupported native fileset aliases")?;
    if let Some(table) = config
        .get("fileset-aliases")
        .and_then(|item| item.as_table_like())
    {
        for (name, value) in table.iter() {
            let expression = value.as_str().context("fileset alias must be a string")?;
            aliases
                .insert(name, expression, None)
                .context("unsupported native fileset alias")?;
        }
    }
    let converter = RepoPathUiConverter::Fs {
        cwd: PathBuf::new(),
        base: PathBuf::new(),
    };
    let context = FilesetParseContext {
        aliases_map: &aliases,
        path_converter: &converter,
    };
    let matcher = fileset::parse(&mut FilesetDiagnostics::new(), &input.auto_track, &context)
        .context("unsupported native auto-track expression")?
        .to_matcher();
    if !matcher.matches(path) {
        return Ok(Eligibility::refuse("not_auto_tracked"));
    }
    let HumanByteSize(maximum) = input
        .max_new_file_size
        .parse()
        .map_err(anyhow::Error::msg)
        .context("unsupported native snapshot size limit")?;
    if maximum != 0 && input.byte_length > maximum {
        return Ok(Eligibility::refuse("new_file_too_large"));
    }
    Ok(Eligibility::allow())
}

fn base_ignores(
    repository: &Path,
    store: &Arc<jj_lib::store::Store>,
) -> anyhow::Result<Arc<GitIgnoreFile>> {
    // Same precedence as JJ's native WorkspaceCommandHelper::base_ignores:
    // core.excludesFile (or XDG default), then this backend's info/exclude.
    // gix loads the effective Git configuration without a Git subprocess.
    let backend = jj_lib::git::get_git_backend(store).context("unsupported non-Git JJ backend")?;
    let git = backend.git_repo();
    let config = git.config_snapshot();
    let exclude = match config.string("core.excludesFile") {
        Some(value) => {
            let value =
                std::str::from_utf8(&value).context("non-UTF-8 excludesFile is unsupported")?;
            Some(repository.join(jj_lib::file_util::expand_home_path(value)))
        }
        None => std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
            .map(|home| home.join("git/ignore")),
    };
    let mut ignores = GitIgnoreFile::empty();
    if let Some(exclude) = exclude {
        ignores = ignores.chain_with_file(RepoPath::root(), exclude)?;
    }
    Ok(ignores.chain_with_file(
        RepoPath::root(),
        backend.git_repo_path().join("info/exclude"),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jj_lib::backend::CopyId;
    use jj_lib::merged_tree::MergedTree;
    use jj_lib::object_id::ObjectId;
    use jj_lib::repo::Repo;
    use jj_lib::repo_path::RepoPathBuf;
    use jj_lib::tree_builder::TreeBuilder;

    fn fixture(tracked: &[&str]) -> (tempfile::TempDir, String) {
        let temp = tempfile::TempDir::new().unwrap();
        let settings = create_settings(&UserConfig::default());
        let (_, repo) = Workspace::init_internal_git(&settings, temp.path(), gix::hash::Kind::Sha1)
            .block_on()
            .unwrap();
        // Override global excludes without mutating process-wide Git or home settings.
        std::fs::write(temp.path().join(".jj/test-excludes"), "").unwrap();
        let config_path = temp.path().join(".jj/repo/store/git/config");
        let mut config = std::fs::read_to_string(&config_path).unwrap();
        config.push_str("\n[core]\n\texcludesFile = .jj/test-excludes\n");
        std::fs::write(config_path, config).unwrap();
        let store = repo.store();
        let mut builder = TreeBuilder::new(store.clone(), store.empty_tree_id().clone());
        for name in tracked {
            let path = RepoPathBuf::from_internal_string(*name).unwrap();
            let id = store
                .write_file(&path, &mut "tracked".as_bytes())
                .block_on()
                .unwrap();
            builder.set(
                path,
                TreeValue::File {
                    id,
                    executable: false,
                    copy_id: CopyId::placeholder(),
                },
            );
        }
        let tree = MergedTree::resolved(store.clone(), builder.write_tree().block_on().unwrap());
        let mut tx = repo.start_transaction();
        let commit = tx
            .repo_mut()
            .new_commit(vec![store.root_commit_id().clone()], tree)
            .write()
            .block_on()
            .unwrap();
        // No transaction commit is needed: check reads the store by immutable commit ID.
        (temp, commit.id().hex())
    }

    fn input(commit: &str, path: &str) -> Input {
        Input {
            commit_id: commit.into(),
            path: path.into(),
            byte_length: 1,
            auto_track: "all()".into(),
            max_new_file_size: "1MiB".into(),
            fileset_aliases: String::new(),
        }
    }

    fn refusal(root: &Path, input: Input, expected: &str) {
        let result = check(root, input).unwrap();
        assert!(!result.eligible);
        assert_eq!(result.reason, Some(expected));
    }

    fn error(root: &Path, input: Input, expected: &str) {
        let result = check(root, input).err().expect("expected failure");
        assert_eq!(result.to_string(), expected);
    }

    #[test]
    fn input_decode_requires_every_field_and_rejects_unknown_fields() {
        let valid = serde_json::json!({"commitId":"abc", "path":"file", "byteLength":0,
            "autoTrack":"all()", "maxNewFileSize":"0", "filesetAliases":""});
        assert!(serde_json::from_value::<Input>(valid.clone()).is_ok());
        for field in [
            "commitId",
            "path",
            "byteLength",
            "autoTrack",
            "maxNewFileSize",
            "filesetAliases",
        ] {
            let mut value = valid.clone();
            value.as_object_mut().unwrap().remove(field);
            assert_eq!(
                serde_json::from_value::<Input>(value)
                    .err()
                    .unwrap()
                    .to_string(),
                format!("missing field `{field}`")
            );
        }
        let mut value = valid;
        value["extra"] = serde_json::json!(true);
        assert_eq!(serde_json::from_value::<Input>(value).err().unwrap().to_string(),
            "unknown field `extra`, expected one of `commitId`, `path`, `byteLength`, `autoTrack`, `maxNewFileSize`, `filesetAliases`");
    }

    #[test]
    fn paths_are_bounded_normalized_and_protect_metadata() {
        let (temp, commit) = fixture(&[]);
        for path in ["", "a\0b"] {
            error(
                temp.path(),
                input(&commit, path),
                "expected a bounded repository-relative file path",
            );
        }
        error(
            temp.path(),
            input(&commit, &"a".repeat(4097)),
            "expected a bounded repository-relative file path",
        );
        for path in ["a/./b", "a/../b", "a\\b"] {
            error(
                temp.path(),
                input(&commit, path),
                "expected a normalized repository-relative file path",
            );
        }
        for path in ["/file", "file/", "a//b"] {
            error(
                temp.path(),
                input(&commit, path),
                "invalid repository-relative path",
            );
        }
        for path in [".jj/config", "nested/.GiT/config", "nested/.JJ/file"] {
            refusal(temp.path(), input(&commit, path), "repository_metadata");
        }
    }

    #[test]
    fn real_new_files_size_boundaries_and_tracked_overrides() {
        let (temp, commit) = fixture(&["tracked", ".gitignore"]);
        std::fs::write(temp.path().join("new"), "new").unwrap();
        std::fs::write(temp.path().join(".gitignore"), "tracked\n").unwrap();
        for (size, limit, allowed) in [
            (0, "1", true),
            (1, "1", true),
            (2, "1", false),
            (u64::MAX, "0", true),
        ] {
            let mut candidate = input(&commit, "new");
            candidate.byte_length = size;
            candidate.max_new_file_size = limit.into();
            let result = check(temp.path(), candidate).unwrap();
            assert_eq!(result.eligible, allowed);
            assert_eq!(
                result.reason,
                if allowed {
                    None
                } else {
                    Some("new_file_too_large")
                }
            );
        }
        for path in ["tracked", ".gitignore"] {
            let mut candidate = input(&commit, path);
            candidate.auto_track = "invalid(".into();
            candidate.max_new_file_size = "invalid".into();
            candidate.fileset_aliases = "invalid [".into();
            assert!(check(temp.path(), candidate).unwrap().eligible);
        }
        refusal(
            temp.path(),
            input(&commit, "sub/.GitIgnore"),
            "untracked_ignore_file",
        );
    }

    #[test]
    fn ignores_respect_directory_pruning_and_nested_negation() {
        let (temp, commit) = fixture(&[]);
        std::fs::create_dir(temp.path().join("nested")).unwrap();
        std::fs::create_dir(temp.path().join("blocked")).unwrap();
        std::fs::write(temp.path().join(".gitignore"), "*.log\nblocked/\n").unwrap();
        std::fs::write(temp.path().join("nested/.gitignore"), "!keep.log\n").unwrap();
        std::fs::write(temp.path().join("blocked/.gitignore"), "!keep.log\n").unwrap();
        refusal(temp.path(), input(&commit, "other.log"), "ignored_path");
        refusal(
            temp.path(),
            input(&commit, "nested/other.log"),
            "ignored_path",
        );
        assert!(
            check(temp.path(), input(&commit, "nested/keep.log"))
                .unwrap()
                .eligible
        );
        refusal(
            temp.path(),
            input(&commit, "blocked/keep.log"),
            "ignored_directory",
        );
    }

    #[test]
    fn base_ignores_load_core_excludes_file() {
        let (temp, commit) = fixture(&[]);
        std::fs::write(
            temp.path().join(".jj/test-excludes"),
            "*.log\n!keep.log\nblocked/\n",
        )
        .unwrap();
        refusal(temp.path(), input(&commit, "other.log"), "ignored_path");
        refusal(
            temp.path(),
            input(&commit, "blocked/file"),
            "ignored_directory",
        );
        for path in ["keep.log", "new"] {
            let result = check(temp.path(), input(&commit, path)).unwrap();
            assert!(result.eligible, "{path}");
            assert_eq!(result.reason, None);
        }
    }

    #[test]
    fn base_ignores_info_exclude_overrides_core_excludes_with_negation() {
        let (temp, commit) = fixture(&[]);
        std::fs::write(temp.path().join(".jj/test-excludes"), "*.log\n!deny.log\n").unwrap();
        let exclude = temp.path().join(".jj/repo/store/git/info/exclude");
        std::fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        std::fs::write(exclude, "!keep.log\ndeny.log\ninfo-only.txt\n").unwrap();
        for path in ["other.log", "deny.log", "info-only.txt"] {
            refusal(temp.path(), input(&commit, path), "ignored_path");
        }
        let result = check(temp.path(), input(&commit, "keep.log")).unwrap();
        assert!(result.eligible);
        assert_eq!(result.reason, None);
    }

    #[test]
    fn native_filesets_aliases_and_invalid_configuration() {
        let (temp, commit) = fixture(&[]);
        let mut candidate = input(&commit, "src/main.rs");
        candidate.fileset_aliases = "[fileset-aliases]\n'code()' = 'glob:\"**/*.rs\"'\n".into();
        candidate.auto_track = "code()".into();
        assert!(check(temp.path(), candidate).unwrap().eligible);
        let mut candidate = input(&commit, "src/main.txt");
        candidate.fileset_aliases = "[fileset-aliases]\n'code()' = 'glob:\"**/*.rs\"'\n".into();
        candidate.auto_track = "code()".into();
        refusal(temp.path(), candidate, "not_auto_tracked");
        let mut candidate = input(&commit, "other");
        candidate.auto_track = "none()".into();
        refusal(temp.path(), candidate, "not_auto_tracked");
        for (field, value, expected) in [
            (0, "invalid(", "unsupported native auto-track expression"),
            (1, "invalid [", "unsupported native fileset aliases"),
            (
                1,
                "[fileset-aliases]\n'code()' = 1",
                "fileset alias must be a string",
            ),
            (2, "invalid", "unsupported native snapshot size limit"),
        ] {
            let mut candidate = input(&commit, "new");
            match field {
                0 => candidate.auto_track = value.into(),
                1 => candidate.fileset_aliases = value.into(),
                _ => candidate.max_new_file_size = value.into(),
            }
            error(temp.path(), candidate, expected);
        }
    }

    #[test]
    fn commit_ids_require_full_lowercase_hex() {
        let (temp, commit) = fixture(&[]);
        for id in [
            "abc".to_owned(),
            "z".repeat(commit.len()),
            "A".repeat(commit.len()),
        ] {
            error(
                temp.path(),
                input(&id, "new"),
                "expected a full lowercase immutable commit ID",
            );
        }
        let unknown = "1".repeat(commit.len());
        let failure = check(temp.path(), input(&unknown, "new"))
            .err()
            .expect("unknown commit must fail");
        let backend_error = failure
            .chain()
            .find_map(|cause| cause.downcast_ref::<jj_lib::backend::BackendError>())
            .expect("error chain must retain the backend failure");
        match backend_error {
            jj_lib::backend::BackendError::ObjectNotFound {
                object_type, hash, ..
            } => {
                assert_eq!(object_type, "commit");
                assert_eq!(hash, &unknown);
                assert_eq!(
                    backend_error.to_string(),
                    format!("Object {unknown} of type commit not found")
                );
            }
            other => panic!("expected missing commit, got {other:?}"),
        }
    }

    #[test]
    fn sparse_prefixes_include_descendants_but_not_sibling_names() {
        let (temp, commit) = fixture(&["outside"]);
        let settings = create_settings(&UserConfig::default());
        let mut workspace = Workspace::load(
            &settings,
            temp.path(),
            &default_backend_factories(),
            &default_working_copy_factories(),
        )
        .unwrap();
        let repo = workspace.repo_loader().load_at_head().block_on().unwrap();
        let mut locked = workspace.start_working_copy_mutation().block_on().unwrap();
        locked
            .locked_wc()
            .set_sparse_patterns(vec![RepoPathBuf::from_internal_string("src").unwrap()])
            .block_on()
            .unwrap();
        locked.finish(repo.op_id().clone()).block_on().unwrap();
        assert!(
            check(temp.path(), input(&commit, "src/new"))
                .unwrap()
                .eligible
        );
        assert!(
            check(temp.path(), input(&commit, "src/nested/new"))
                .unwrap()
                .eligible
        );
        for path in ["src-other/new", "outside"] {
            refusal(temp.path(), input(&commit, path), "outside_sparse_snapshot");
        }
    }

    #[test]
    fn tracked_directory_without_disk_entry_is_unsupported() {
        let (temp, commit) = fixture(&["directory/child"]);
        assert!(!temp.path().join("directory").exists());
        refusal(
            temp.path(),
            input(&commit, "directory"),
            "unsupported_tree_entry",
        );
        let result = check(temp.path(), input(&commit, "directory/child")).unwrap();
        assert!(result.eligible);
        assert_eq!(result.reason, None);
    }

    #[test]
    fn directories_and_file_ancestors_are_nonregular() {
        let (temp, commit) = fixture(&[]);
        std::fs::create_dir(temp.path().join("directory")).unwrap();
        std::fs::write(temp.path().join("file"), "content").unwrap();
        for path in ["directory", "file/child"] {
            refusal(temp.path(), input(&commit, path), "nonregular_path");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_leaf_and_ancestor_are_refused() {
        let (temp, commit) = fixture(&[]);
        std::os::unix::fs::symlink("missing", temp.path().join("link")).unwrap();
        for path in ["link", "link/child"] {
            refusal(temp.path(), input(&commit, path), "symlink_path");
        }
    }
}
