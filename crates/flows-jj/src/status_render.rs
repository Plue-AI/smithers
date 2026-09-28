//! Rendering for the `status` op.
//!
//! The format is owned by this crate (contract callers treat it as opaque
//! text) and kept deliberately small and stable: optional `A`/`M`/`D` lines
//! for the working-copy changes, then the current change id. The vocabulary
//! mirrors `jj status` so humans reading logs feel at home. Paths with a
//! control character, `"`, or `\` are C-quoted the way the diff renderer
//! quotes them.

use std::fmt::Write as _;

use futures::StreamExt as _;
use jj_lib::matchers::EverythingMatcher;
use jj_lib::merged_tree::MergedTree;
use jj_lib::merged_tree::TreeDiffEntry;
use pollster::FutureExt as _;

use crate::diff_render::quote_path;
use crate::error::OpError;

/// Renders the working-copy status: the diff of the current change against
/// its parent(s) as `A`/`M`/`D` lines, then `Working copy  (@) : <changeId>`.
pub fn status(
    parent_tree: &MergedTree,
    wc_tree: &MergedTree,
    change_id: &str,
) -> Result<String, OpError> {
    let mut lines: Vec<String> = Vec::new();
    let mut diff_stream = parent_tree.diff_stream(wc_tree, &EverythingMatcher);
    async {
        while let Some(TreeDiffEntry { path, values }) = diff_stream.next().await {
            let values = values?;
            let sigil = match (values.before.is_present(), values.after.is_present()) {
                (false, true) => 'A',
                (true, false) => 'D',
                _ => 'M',
            };
            // Quoted like diff headers, so a newline in a file name cannot
            // forge another status entry.
            lines.push(format!(
                "{sigil} {path}",
                path = quote_path("", path.as_internal_file_string())
            ));
        }
        Ok::<_, OpError>(())
    }
    .block_on()?;
    // The stream yields entries in path order already; sort defensively so
    // the format stays stable even if that changes.
    lines.sort();

    let mut output = String::new();
    if lines.is_empty() {
        writeln!(output, "The working copy has no changes.").unwrap();
    } else {
        writeln!(output, "Working copy changes:").unwrap();
        for line in &lines {
            writeln!(output, "{line}").unwrap();
        }
    }
    writeln!(output, "Working copy  (@) : {change_id}").unwrap();
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jj_lib::config::{ConfigLayer, ConfigSource, StackedConfig};
    use jj_lib::default_backend_factories::{
        default_backend_factories, default_working_copy_factories,
    };
    use jj_lib::repo::Repo as _;
    use jj_lib::settings::UserSettings;
    use jj_lib::workspace::Workspace;

    const USER_CONFIG: &str = r#"
user.name = "Flows"
user.email = "flows@localhost"
operation.hostname = "flows"
operation.username = "flows"
"#;

    #[test]
    fn renders_empty_and_sorted_added_modified_deleted_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        crate::ops::init(&root).unwrap();

        let mut config = StackedConfig::with_defaults();
        config.add_layer(ConfigLayer::parse(ConfigSource::User, USER_CONFIG).unwrap());
        let settings = UserSettings::from_config(config).unwrap();

        let workspace = Workspace::load(
            &settings,
            &root,
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
        let empty = repo.store().empty_merged_tree();
        assert_eq!(
            status(&empty, &empty, "kxy").unwrap(),
            "The working copy has no changes.\nWorking copy  (@) : kxy\n"
        );

        // Path order deliberately differs from the rendered A/D/M order.
        std::fs::write(root.join("a-delete.txt"), "before\n").unwrap();
        std::fs::write(root.join("m-modify.txt"), "before\n").unwrap();
        let first = crate::ops::snapshot(&root, Some("first")).unwrap();
        std::fs::remove_file(root.join("a-delete.txt")).unwrap();
        std::fs::write(root.join("m-modify.txt"), "after\n").unwrap();
        std::fs::write(root.join("z-add 雪.txt"), "new\n").unwrap();
        let second = crate::ops::snapshot(&root, Some("second")).unwrap();

        let workspace = Workspace::load(
            &settings,
            &root,
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
        let before = repo
            .store()
            .get_commit(&jj_lib::backend::CommitId::try_from_hex(first.commit_id).unwrap())
            .unwrap();
        let after = repo
            .store()
            .get_commit(&jj_lib::backend::CommitId::try_from_hex(second.commit_id).unwrap())
            .unwrap();
        assert_eq!(
            status(&before.tree(), &after.tree(), "kxy").unwrap(),
            "Working copy changes:\nA z-add 雪.txt\nD a-delete.txt\nM m-modify.txt\nWorking copy  (@) : kxy\n"
        );
    }
}
