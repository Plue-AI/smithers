//! The jj/git ignore seam. Toolchain paths are supplied by the host detector;
//! metadata is watched separately and never becomes file activity.
use std::io;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

pub trait Ignore {
    fn ignored(&mut self, path: &Path, directory: bool) -> io::Result<bool>;
    fn batch(&mut self, paths: &[(PathBuf, bool)]) -> io::Result<Vec<bool>> {
        paths.iter().map(|(p, d)| self.ignored(p, *d)).collect()
    }
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
// The save adapter retains these inodes for late outside writers. They are
// daemon scratch, not branch changes. Match the complete generated shape so
// similarly named ordinary files remain visible.
fn document_temp(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    let Some((key, nonce)) = name
        .strip_prefix(".smithers-doc-")
        .and_then(|s| s.split_once('-'))
    else {
        return false;
    };
    key.len() == 64
        && nonce.len() == 32
        && key
            .bytes()
            .chain(nonce.bytes())
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl Ignore for GitIgnore {
    fn ignored(&mut self, path: &Path, directory: bool) -> io::Result<bool> {
        Ok(self.batch(&[(path.into(), directory)])?[0])
    }
    fn batch(&mut self, paths: &[(PathBuf, bool)]) -> io::Result<Vec<bool>> {
        use std::io::Read;
        use std::os::unix::ffi::{OsStrExt, OsStringExt};
        let mut result = vec![false; paths.len()];
        let mut pending = vec![];
        let mut input = vec![];
        for (i, (path, directory)) in paths.iter().enumerate() {
            if !relative(path)
                || path.as_os_str().as_bytes().len() > 4096
                || path.as_os_str().as_bytes().contains(&0)
            {
                return Err(io::ErrorKind::InvalidInput.into());
            }
            if path
                .components()
                .any(|p| p.as_os_str() == ".git" || p.as_os_str() == ".jj")
                || self.toolchain.iter().any(|p| path.starts_with(p))
                || document_temp(path)
            {
                result[i] = true;
                continue;
            }
            input.extend(path.as_os_str().as_bytes());
            if *directory {
                input.push(b'/');
            }
            input.push(0);
            pending.push(i);
        }
        if pending.is_empty() {
            return Ok(result);
        }
        // Avoid stdin/stdout pipe deadlock for large scans by chunking. Each
        // chunk is bounded, and one trusted git process checks many paths.
        if input.len() > 8192 {
            let mut out = vec![];
            for chunk in paths.chunks((paths.len() / 2).max(1)) {
                out.extend(self.batch(chunk)?);
            }
            return Ok(out);
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
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        child.stdin.take().unwrap().write_all(&input)?;
        let mut output = vec![];
        child
            .stdout
            .take()
            .unwrap()
            .take(8193)
            .read_to_end(&mut output)?;
        let status = child.wait()?;
        if output.len() > 8192 || !matches!(status.code(), Some(0) | Some(1)) {
            return Err(io::Error::other("ignore provider failed"));
        }
        let ignored: std::collections::BTreeSet<PathBuf> = output
            .split(|b| *b == 0)
            .filter(|b| !b.is_empty())
            .map(|b| PathBuf::from(std::ffi::OsString::from_vec(b.to_vec())))
            .collect();
        for i in pending {
            result[i] = ignored.contains(&paths[i].0);
        }
        Ok(result)
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
