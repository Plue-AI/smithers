use smithers_machined::moved_off::{self, Query};
use std::{fs, io, path::PathBuf, process::Command};

struct Repo(PathBuf);
impl Repo {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "fr-t-col-05-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        let mut repo = Self(path);
        repo.run(&["git", "init", "--colocate", "."]);
        repo.run(&["config", "set", "--repo", "user.name", "Fixture"]);
        repo.run(&[
            "config",
            "set",
            "--repo",
            "user.email",
            "fixture@example.invalid",
        ]);
        fs::write(repo.0.join("retry.ts"), "export const retry = 1;\n").unwrap();
        repo.run(&["commit", "-m", "main"]);
        repo.run(&["bookmark", "create", "main", "-r", "@-"]);
        repo
    }
    fn run(&mut self, args: &[&str]) -> String {
        self.jj(&args.iter().map(|s| (*s).into()).collect::<Vec<_>>())
            .unwrap()
            .trim()
            .to_owned()
    }
    fn item(&mut self) -> (String, String) {
        fs::write(self.0.join("retry.ts"), "export const retry = 2;\n").unwrap();
        self.run(&["describe", "-m", "T2"]);
        let change = self.run(&["log", "--no-graph", "-r", "@", "-T", "change_id"]);
        let commit = self.run(&["log", "--no-graph", "-r", "@", "-T", "commit_id"]);
        (change, commit)
    }
}
impl Query for Repo {
    fn jj(&mut self, args: &[String]) -> io::Result<String> {
        let output = Command::new("jj")
            .args(args)
            .current_dir(&self.0)
            .env("JJ_CONFIG", "")
            .env("NO_COLOR", "1")
            .output()?;
        if !output.status.success() {
            return Err(io::Error::other(
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ));
        }
        String::from_utf8(output.stdout).map_err(io::Error::other)
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn metadata_moves_use_operation_history() {
    for action in [
        vec!["edit", "main"],
        vec!["new", "main"],
        vec!["abandon", "@"],
    ] {
        let mut repo = Repo::new();
        let (change, before) = repo.item();
        assert!(moved_off::detect(&mut repo, &change, "T2", "Maya", None)
            .unwrap()
            .is_none());
        repo.run(&action);
        let fact = moved_off::detect(&mut repo, &change, "T2", "Maya", None)
            .unwrap()
            .unwrap();
        assert_eq!(fact.pre_move_commit, before, "{action:?}");
        assert_eq!(fact.by, "Maya");
        assert_eq!(fact.item, "T2");
        assert_eq!(
            moved_off::detect(&mut repo, &change, "T2", "Ben", Some(&fact)).unwrap(),
            Some(fact.clone())
        );
        if action[0] != "abandon" {
            repo.run(&["edit", &before]);
            assert!(
                moved_off::detect(&mut repo, &change, "T2", "Maya", Some(&fact))
                    .unwrap()
                    .is_none()
            );
        }
    }
}

#[test]
fn colocated_git_moves_and_same_commit_bookmarks() {
    for args in [vec!["checkout", "main"], vec!["switch", "-c", "x", "main"]] {
        let mut repo = Repo::new();
        let (change, _) = repo.item();
        // jj leaves git HEAD on @-; commit the item before using git's checkout.
        repo.run(&["new"]);
        let before = repo.run(&["log", "--no-graph", "-r", "@", "-T", "commit_id"]);
        let result = Command::new("git")
            .args(&args)
            .current_dir(&repo.0)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let fact = moved_off::detect(&mut repo, &change, "T2", "Maya", None)
            .unwrap()
            .unwrap();
        assert_eq!(fact.pre_move_commit, before);
    }
    let mut repo = Repo::new();
    let (change, _) = repo.item();
    repo.run(&["new"]);
    assert!(Command::new("git")
        .args(["checkout", "-b", "x"])
        .current_dir(&repo.0)
        .status()
        .unwrap()
        .success());
    assert!(moved_off::detect(&mut repo, &change, "T2", "Maya", None)
        .unwrap()
        .is_none());
}

#[test]
fn descendants_rebases_and_identical_trees() {
    let mut repo = Repo::new();
    let (change, _) = repo.item();
    repo.run(&["new"]);
    assert!(moved_off::detect(&mut repo, &change, "T2", "Maya", None)
        .unwrap()
        .is_none());
    repo.run(&["rebase", "-s", &change, "-d", "root()"]);
    assert!(moved_off::detect(&mut repo, &change, "T2", "Maya", None)
        .unwrap()
        .is_none());
    // An unrelated change with the exact same tree still counts as moved off.
    repo.run(&["new", "root()"]);
    fs::write(repo.0.join("retry.ts"), "export const retry = 2;\n").unwrap();
    repo.run(&["describe", "-m", "unrelated identical tree"]);
    assert!(moved_off::detect(&mut repo, &change, "T2", "Maya", None)
        .unwrap()
        .is_some());
}

#[test]
fn unavailable_and_malformed_queries_refuse() {
    struct Failed;
    impl Query for Failed {
        fn jj(&mut self, _: &[String]) -> io::Result<String> {
            Err(io::Error::other("unavailable"))
        }
    }
    assert!(moved_off::detect(&mut Failed, &"k".repeat(32), "T2", "Maya", None).is_err());
    assert!(moved_off::detect(&mut Failed, "@ | all()", "T2", "Maya", None).is_err());
    assert!(moved_off::detect(&mut Failed, "", "", "Maya", None)
        .unwrap()
        .is_none());
    struct Malformed;
    impl Query for Malformed {
        fn jj(&mut self, _: &[String]) -> io::Result<String> {
            Ok("unexpected".into())
        }
    }
    assert!(moved_off::detect(&mut Malformed, &"k".repeat(32), "T2", "Maya", None).is_err());
}
