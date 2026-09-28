//! Git-format unified diff rendering over jj-lib's tree diff streams.
//!
//! jj-lib owns the hard parts — content materialization
//! (`conflicts::materialized_diff_stream`), per-side headers
//! (`diff_presentation::unified::git_diff_part`), and hunk construction
//! (`unified_diff_hunks`). This module is only the text renderer the jj CLI
//! keeps to itself: `diff --git` file headers, `---`/`+++` lines, `@@` hunk
//! headers, and the standard binary form. The output matches
//! `jj diff --git` for the cases the `Jj` contract exercises.

use std::fmt::Write as _;
use std::ops::Range;
use std::sync::Arc;

use bstr::BStr;
use futures::StreamExt as _;
use jj_lib::conflict_labels::ConflictLabels;
use jj_lib::conflicts::ConflictMarkerStyle;
use jj_lib::conflicts::ConflictMaterializeOptions;
use jj_lib::conflicts::MaterializedTreeDiffEntry;
use jj_lib::conflicts::materialized_diff_stream;
use jj_lib::copies::CopyOperation;
use jj_lib::copies::CopyRecords;
use jj_lib::diff_presentation::LineCompareMode;
use jj_lib::diff_presentation::unified::DiffLineType;
use jj_lib::diff_presentation::unified::git_diff_part;
use jj_lib::diff_presentation::unified::unified_diff_hunks;
use jj_lib::matchers::EverythingMatcher;
use jj_lib::merge::Diff;
use jj_lib::merged_tree::MergedTree;
use jj_lib::store::Store;
use pollster::FutureExt as _;

use crate::error::OpError;

/// `diff.git.context` default: three lines of context around every hunk.
const CONTEXT_LINES: usize = 3;

/// Renders the differences between two trees as a git-format unified diff.
/// Identical trees render as the empty string, mirroring `jj diff --git`.
pub fn git_diff(
    store: &Arc<Store>,
    from_tree: &MergedTree,
    to_tree: &MergedTree,
) -> Result<String, OpError> {
    let materialize_options = ConflictMaterializeOptions {
        marker_style: ConflictMarkerStyle::Diff,
        marker_len: None,
        merge: store.merge_options().clone(),
    };
    // SimpleBackend records no copies, so rename/copy detection is inert and
    // renames render as delete + add; the header path is kept for parity with
    // backends that do record copies.
    let copy_records = CopyRecords::default();
    let tree_diff = from_tree.diff_stream_with_copies(to_tree, &EverythingMatcher, &copy_records);
    let unlabeled = ConflictLabels::unlabeled();
    let conflict_labels = Diff::new(&unlabeled, &unlabeled);
    let mut diff_stream = materialized_diff_stream(store, tree_diff, conflict_labels);

    let mut output = String::new();
    async {
        while let Some(MaterializedTreeDiffEntry { path, values }) = diff_stream.next().await {
            let values = values?;
            let left_path = path.source().as_internal_file_string().to_owned();
            let right_path = path.target().as_internal_file_string().to_owned();
            let left_part =
                git_diff_part(path.source(), values.before, &materialize_options).await?;
            let right_part =
                git_diff_part(path.target(), values.after, &materialize_options).await?;

            writeln!(output, "diff --git a/{left_path} b/{right_path}").unwrap();
            let left_hash = &left_part.hash;
            let right_hash = &right_part.hash;
            match (left_part.mode, right_part.mode) {
                (None, Some(right_mode)) => {
                    writeln!(output, "new file mode {right_mode}").unwrap();
                    writeln!(output, "index {left_hash}..{right_hash}").unwrap();
                }
                (Some(left_mode), None) => {
                    writeln!(output, "deleted file mode {left_mode}").unwrap();
                    writeln!(output, "index {left_hash}..{right_hash}").unwrap();
                }
                (Some(left_mode), Some(right_mode)) => {
                    if let Some(op) = path.copy_operation() {
                        let operation = match op {
                            CopyOperation::Copy => "copy",
                            CopyOperation::Rename => "rename",
                        };
                        writeln!(output, "{operation} from {left_path}").unwrap();
                        writeln!(output, "{operation} to {right_path}").unwrap();
                    }
                    if left_mode != right_mode {
                        writeln!(output, "old mode {left_mode}").unwrap();
                        writeln!(output, "new mode {right_mode}").unwrap();
                        if left_hash != right_hash {
                            writeln!(output, "index {left_hash}..{right_hash}").unwrap();
                        }
                    } else if left_hash != right_hash {
                        writeln!(output, "index {left_hash}..{right_hash} {left_mode}").unwrap();
                    }
                }
                (None, None) => {
                    return Err(OpError::unknown(format!(
                        "diff entry for {right_path} has neither side"
                    )));
                }
            }

            if left_part.content.contents == right_part.content.contents {
                continue; // mode-only change: no content hunks
            }

            let left_label = match left_part.mode {
                Some(_) => format!("a/{left_path}"),
                None => "/dev/null".to_owned(),
            };
            let right_label = match right_part.mode {
                Some(_) => format!("b/{right_path}"),
                None => "/dev/null".to_owned(),
            };
            if left_part.content.is_binary || right_part.content.is_binary {
                writeln!(output, "Binary files {left_label} and {right_label} differ").unwrap();
            } else {
                writeln!(output, "--- {left_label}").unwrap();
                writeln!(output, "+++ {right_label}").unwrap();
                render_unified_hunks(
                    &mut output,
                    Diff::new(&left_part.content.contents, &right_part.content.contents)
                        .map(BStr::new),
                );
            }
        }
        Ok(())
    }
    .block_on()?;
    Ok(output)
}

/// The `@@` line number for a range: one-based for non-empty ranges; for an
/// empty range, POSIX says "the number of the preceding line, or 0 if the
/// range is at the start of the file".
fn to_line_number(range: &Range<usize>) -> usize {
    if range.is_empty() {
        range.start
    } else {
        range.start + 1
    }
}

/// Renders `@@` hunks with sigil-prefixed lines, including the
/// `\ No newline at end of file` marker.
fn render_unified_hunks(output: &mut String, contents: Diff<&BStr>) {
    for hunk in unified_diff_hunks(contents, CONTEXT_LINES, LineCompareMode::Exact) {
        writeln!(
            output,
            "@@ -{},{} +{},{} @@",
            to_line_number(&hunk.left_line_range),
            hunk.left_line_range.len(),
            to_line_number(&hunk.right_line_range),
            hunk.right_line_range.len()
        )
        .unwrap();
        for (line_type, tokens) in &hunk.lines {
            let sigil = match line_type {
                DiffLineType::Context => " ",
                DiffLineType::Removed => "-",
                DiffLineType::Added => "+",
            };
            output.push_str(sigil);
            let mut line_ends_with_newline = false;
            for (_token_type, content) in tokens {
                output.push_str(&String::from_utf8_lossy(content));
                line_ends_with_newline = content.ends_with(b"\n");
            }
            if !line_ends_with_newline {
                output.push_str("\n\\ No newline at end of file\n");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jj_lib::backend::{CommitId, TreeId};
    use jj_lib::config::{ConfigLayer, ConfigSource, StackedConfig};
    use jj_lib::default_backend_factories::{
        default_backend_factories, default_working_copy_factories,
    };
    use jj_lib::repo::Repo as _;
    use jj_lib::settings::UserSettings;
    use jj_lib::workspace::Workspace;
    use std::path::Path;

    const USER_CONFIG: &str = r#"
user.name = "Flows"
user.email = "flows@localhost"
operation.hostname = "flows"
operation.username = "flows"
"#;

    fn committed_trees(root: &Path, ids: &[&str]) -> (Arc<Store>, Vec<MergedTree>) {
        let mut config = StackedConfig::with_defaults();
        config.add_layer(ConfigLayer::parse(ConfigSource::User, USER_CONFIG).unwrap());
        let settings = UserSettings::from_config(config).unwrap();
        let workspace = Workspace::load(
            &settings,
            root,
            &default_backend_factories(),
            &default_working_copy_factories(),
        )
        .unwrap();
        let repo = workspace
            .repo_loader()
            .clone()
            .load_at_head()
            .block_on()
            .unwrap();
        let store = repo.store().clone();
        let trees = ids
            .iter()
            .map(|id| {
                store
                    .get_commit(&CommitId::try_from_hex(id).unwrap())
                    .unwrap()
                    .tree()
            })
            .collect();
        (store, trees)
    }

    fn hunks(before: &[u8], after: &[u8]) -> String {
        let mut output = String::new();
        render_unified_hunks(&mut output, Diff::new(BStr::new(before), BStr::new(after)));
        output
    }

    #[test]
    fn empty_ranges_number_the_preceding_line() {
        assert_eq!(to_line_number(&(0..0)), 0);
        assert_eq!(to_line_number(&(4..4)), 4);
        assert_eq!(to_line_number(&(0..1)), 1);
        assert_eq!(to_line_number(&(4..7)), 5);
    }

    #[test]
    fn hunks_render_insert_delete_and_unchanged_context() {
        assert_eq!(hunks(b"", b""), "");
        assert_eq!(hunks(b"", b"new\n"), "@@ -0,0 +1,1 @@\n+new\n");
        assert_eq!(hunks(b"old\n", b""), "@@ -1,1 +0,0 @@\n-old\n");
        assert_eq!(
            hunks(b"before\nold\nafter\n", b"before\nnew\nafter\n"),
            "@@ -1,3 +1,3 @@\n before\n-old\n+new\n after\n"
        );
        assert_eq!(hunks(b"same\n", b"same\n"), "");
    }

    #[test]
    fn missing_final_newline_is_marked_on_each_affected_side() {
        assert_eq!(
            hunks(b"old", b"new"),
            "@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n"
        );
        assert_eq!(
            hunks(b"old\n", b"new"),
            "@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file\n"
        );
        assert_eq!(
            hunks(b"old", b"new\n"),
            "@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n"
        );
    }

    #[test]
    fn unicode_lines_remain_utf8_in_the_rendered_diff() {
        assert_eq!(
            hunks("café\n".as_bytes(), "雪\n".as_bytes()),
            "@@ -1,1 +1,1 @@\n-café\n+雪\n"
        );
    }

    #[test]
    fn eof_changes_keep_context_and_line_numbers() {
        assert_eq!(
            hunks(b"one\ntwo\n", b"one\ntwo\nthree\n"),
            "@@ -1,2 +1,3 @@\n one\n two\n+three\n"
        );
        assert_eq!(
            hunks(b"one\ntwo\nthree\n", b"one\ntwo\n"),
            "@@ -1,3 +1,2 @@\n one\n two\n-three\n"
        );
    }

    #[test]
    fn separated_changes_form_two_hunks_with_bounded_context() {
        let before = b"1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n";
        let after =
            b"1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\nNINETEEN\n20\n";
        assert_eq!(
            hunks(before, after),
            "@@ -1,5 +1,5 @@\n 1\n-2\n+TWO\n 3\n 4\n 5\n@@ -16,5 +16,5 @@\n 16\n 17\n 18\n-19\n+NINETEEN\n 20\n"
        );
    }

    #[test]
    fn blank_and_crlf_lines_keep_their_exact_bytes() {
        assert_eq!(
            hunks(b"same\r\n\r\nold\r\n", b"same\r\n\r\nnew\r\n"),
            "@@ -1,3 +1,3 @@\n same\r\n \r\n-old\r\n+new\r\n"
        );
    }

    #[test]
    fn invalid_utf8_is_replaced_without_losing_hunk_structure() {
        assert_eq!(hunks(b"old\n", b"\xff\n"), "@@ -1,1 +1,1 @@\n-old\n+�\n");
    }

    #[test]
    fn git_diff_renders_sorted_add_delete_and_modify_from_real_trees() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        crate::ops::init(&root).unwrap();
        std::fs::write(root.join("old.txt"), "bye\n").unwrap();
        std::fs::write(root.join("same.txt"), "before\n").unwrap();
        let first = crate::ops::snapshot(&root, Some("first")).unwrap();
        std::fs::remove_file(root.join("old.txt")).unwrap();
        std::fs::write(root.join("same.txt"), "after\n").unwrap();
        std::fs::write(root.join("added 雪.txt"), "fresh\n").unwrap();
        let second = crate::ops::snapshot(&root, Some("second")).unwrap();
        let (store, trees) = committed_trees(&root, &[&first.commit_id, &second.commit_id]);
        let [before, after] = &trees[..] else {
            unreachable!()
        };

        assert_eq!(git_diff(&store, before, before).unwrap(), "");
        assert_eq!(
            git_diff(&store, before, after).unwrap(),
            "diff --git a/added 雪.txt b/added 雪.txt\nnew file mode 100644\nindex 0000000000..87085db9d1\n--- /dev/null\n+++ b/added 雪.txt\n@@ -0,0 +1,1 @@\n+fresh\ndiff --git a/old.txt b/old.txt\ndeleted file mode 100644\nindex cfb6327021..0000000000\n--- a/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\ndiff --git a/same.txt b/same.txt\nindex 826666ae63..e349b46ad1 100644\n--- a/same.txt\n+++ b/same.txt\n@@ -1,1 +1,1 @@\n-before\n+after\n"
        );
    }

    #[test]
    fn git_diff_uses_binary_summary_for_add_and_content_change() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        crate::ops::init(&root).unwrap();
        let empty = crate::ops::snapshot(&root, Some("empty")).unwrap();
        std::fs::write(root.join("blob.bin"), b"\0old").unwrap();
        let first = crate::ops::snapshot(&root, Some("first")).unwrap();
        std::fs::write(root.join("blob.bin"), b"\0new").unwrap();
        let second = crate::ops::snapshot(&root, Some("second")).unwrap();
        let (store, trees) = committed_trees(
            &root,
            &[&empty.commit_id, &first.commit_id, &second.commit_id],
        );
        let [no_blob, old_blob, new_blob] = &trees[..] else {
            unreachable!()
        };

        assert_eq!(
            git_diff(&store, no_blob, old_blob).unwrap(),
            "diff --git a/blob.bin b/blob.bin\nnew file mode 100644\nindex 0000000000..b6fa74ce2b\nBinary files /dev/null and b/blob.bin differ\n"
        );
        assert_eq!(
            git_diff(&store, old_blob, new_blob).unwrap(),
            "diff --git a/blob.bin b/blob.bin\nindex b6fa74ce2b..c78cc65337 100644\nBinary files a/blob.bin and b/blob.bin differ\n"
        );
        assert_eq!(
            git_diff(&store, new_blob, no_blob).unwrap(),
            "diff --git a/blob.bin b/blob.bin\ndeleted file mode 100644\nindex c78cc65337..0000000000\nBinary files a/blob.bin and /dev/null differ\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn git_diff_reports_mode_only_and_mode_plus_content_changes() {
        use std::os::unix::fs::PermissionsExt as _;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        crate::ops::init(&root).unwrap();
        let script = root.join("script.sh");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o644)).unwrap();
        let first = crate::ops::snapshot(&root, Some("first")).unwrap();

        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let executable = crate::ops::snapshot(&root, Some("executable")).unwrap();

        std::fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o644)).unwrap();
        let changed = crate::ops::snapshot(&root, Some("changed")).unwrap();

        let (store, trees) = committed_trees(
            &root,
            &[&first.commit_id, &executable.commit_id, &changed.commit_id],
        );
        let [plain, executable, changed] = &trees[..] else {
            unreachable!()
        };
        assert_eq!(
            git_diff(&store, plain, executable).unwrap(),
            "diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755\n"
        );
        assert_eq!(
            git_diff(&store, executable, changed).unwrap(),
            "diff --git a/script.sh b/script.sh\nold mode 100755\nnew mode 100644\nindex e6fbc01834..4a5509e881\n--- a/script.sh\n+++ b/script.sh\n@@ -1,1 +1,2 @@\n #!/bin/sh\n+echo hi\n"
        );
    }

    #[test]
    fn git_diff_renders_simple_backend_rename_as_add_and_delete() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        crate::ops::init(&root).unwrap();
        std::fs::write(root.join("z-old.txt"), "payload\n").unwrap();
        let first = crate::ops::snapshot(&root, Some("first")).unwrap();
        std::fs::rename(root.join("z-old.txt"), root.join("a-new.txt")).unwrap();
        let second = crate::ops::snapshot(&root, Some("second")).unwrap();
        let (store, trees) = committed_trees(&root, &[&first.commit_id, &second.commit_id]);
        let [before, after] = &trees[..] else {
            unreachable!()
        };
        assert_eq!(
            git_diff(&store, before, after).unwrap(),
            "diff --git a/a-new.txt b/a-new.txt\nnew file mode 100644\nindex 0000000000..e502eec8fc\n--- /dev/null\n+++ b/a-new.txt\n@@ -0,0 +1,1 @@\n+payload\ndiff --git a/z-old.txt b/z-old.txt\ndeleted file mode 100644\nindex e502eec8fc..0000000000\n--- a/z-old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-payload\n"
        );
    }

    #[test]
    fn git_diff_surfaces_missing_tree_as_unknown_error() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        crate::ops::init(&root).unwrap();
        let first = crate::ops::snapshot(&root, Some("first")).unwrap();
        let (store, trees) = committed_trees(&root, &[&first.commit_id]);
        let [valid] = &trees[..] else { unreachable!() };
        let missing = MergedTree::resolved(store.clone(), TreeId::from_bytes(&[0xff; 64]));
        let error = git_diff(&store, valid, &missing).unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::Unknown);
        assert!(
            error.message.contains("of type tree not found"),
            "{}",
            error.message
        );
        let missing_id = "ff".repeat(64);
        assert!(
            error.message.contains(missing_id.as_str()),
            "{}",
            error.message
        );
    }
}
