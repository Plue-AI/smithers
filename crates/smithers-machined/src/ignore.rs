//! The jj/git ignore seam. Toolchain paths are supplied by the host detector;
//! metadata is watched separately and never becomes file activity.
use std::io;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

pub trait Ignore {
    fn ignored(&mut self, path: &Path, directory: bool) -> io::Result<bool>;
}

/// Uses the installed trusted git binary, not PATH or a repository executable.
/// `check-ignore` does not execute hooks. --no-index matches jj's treatment of
/// tracked paths, and -z preserves whitespace and arbitrary filename bytes.
pub struct GitIgnore {
    workspace: PathBuf,
    git: PathBuf,
    toolchain: Vec<PathBuf>,
}
impl GitIgnore {
    pub fn new(workspace: PathBuf, git: PathBuf, toolchain: Vec<PathBuf>) -> io::Result<Self> {
        if !workspace.is_absolute() || !git.is_absolute() || toolchain.iter().any(|p| !relative(p))
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        Ok(Self {
            workspace,
            git,
            toolchain,
        })
    }
}
pub fn relative(path: &Path) -> bool {
    !path.as_os_str().is_empty() && path.components().all(|p| matches!(p, Component::Normal(_)))
}
impl Ignore for GitIgnore {
    fn ignored(&mut self, path: &Path, directory: bool) -> io::Result<bool> {
        use std::os::unix::ffi::OsStrExt;
        if !relative(path) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        if path
            .components()
            .any(|p| p.as_os_str() == ".git" || p.as_os_str() == ".jj")
            || self.toolchain.iter().any(|p| path.starts_with(p))
        {
            return Ok(true);
        }
        let mut child = Command::new(&self.git)
            .current_dir(&self.workspace)
            .args([
                "--no-optional-locks",
                "check-ignore",
                "--no-index",
                "-z",
                "--stdin",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        let mut input = path.as_os_str().as_bytes().to_vec();
        if directory {
            input.push(b'/');
        }
        input.push(0);
        child.stdin.take().unwrap().write_all(&input)?;
        match child.wait()?.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(io::Error::other("ignore provider failed")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_rules_negation_and_two_hundred_literal_paths() {
        let root = std::env::temp_dir().join(format!("machined-ignore-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        assert!(Command::new("/usr/bin/git")
            .args(["init", "-q"])
            .arg(&root)
            .status()
            .unwrap()
            .success());
        std::fs::create_dir(root.join("nested")).unwrap();
        std::fs::write(root.join(".gitignore"), "*.log\n/cache/\n").unwrap();
        std::fs::write(root.join("nested/.gitignore"), "!keep.log\nprivate*\n").unwrap();
        let mut ignore = GitIgnore::new(
            root.clone(),
            "/usr/bin/git".into(),
            vec!["node_modules".into(), "target".into()],
        )
        .unwrap();
        for i in 0..200 {
            let (path, expected) = match i % 5 {
                0 => (format!("nested/{i}.log"), true),
                1 => ("nested/keep.log".to_owned(), false),
                2 => (format!("nested/private{i}"), true),
                3 => (format!("cache/{i}"), true),
                _ => (format!("src/file {i}.rs"), false),
            };
            let status = Command::new("/usr/bin/git")
                .current_dir(&root)
                .args(["check-ignore", "--no-index", "-q", "--"])
                .arg(&path)
                .status()
                .unwrap();
            assert_eq!(status.success(), expected, "literal git fixture {path}");
            assert_eq!(
                ignore.ignored(Path::new(&path), false).unwrap(),
                expected,
                "{path}"
            );
        }
        for p in [
            ".git/config",
            ".jj/repo/store",
            "target/x",
            "node_modules/x",
        ] {
            assert!(ignore.ignored(Path::new(p), false).unwrap());
        }
        assert!(!ignore.ignored(Path::new("dist/x"), false).unwrap());
        assert!(ignore.ignored(Path::new("../outside"), false).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
