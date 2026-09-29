//! Retain file preimages outside the working tree before a native JJ snapshot.
use std::fs;
#[cfg(unix)]
use std::fs::OpenOptions;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use super::workspace_engine::Failure;

type Result<T> = std::result::Result<T, Failure>;

fn mode(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        metadata.permissions().mode() & 0o777
    }
    #[cfg(windows)]
    {
        if metadata.permissions().readonly() {
            0o444
        } else {
            0o666
        }
    }
}

fn set_mode(file: &fs::File, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        file.set_permissions(fs::Permissions::from_mode(mode))
    }
    #[cfg(windows)]
    {
        let mut permissions = file.metadata()?.permissions();
        permissions.set_readonly(mode & 0o200 == 0);
        file.set_permissions(permissions)
    }
}

fn private_recovery_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        fs::create_dir_all(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
    }
    #[cfg(windows)]
    {
        use super::atomic_windows_handle::Directory;
        // FilePatch::new derives exactly three levels below the repository parent.
        let parent = path
            .ancestors()
            .nth(3)
            .ok_or(std::io::ErrorKind::InvalidInput)?;
        let mut directory = Directory::root(parent)?;
        for part in path
            .strip_prefix(parent)
            .map_err(|_| std::io::ErrorKind::InvalidInput)?
            .components()
        {
            let std::path::Component::Normal(name) = part else {
                return Err(std::io::ErrorKind::InvalidInput.into());
            };
            directory = directory.private_child(name)?;
        }
        Ok(())
    }
}

fn create_staged_file(path: &Path) -> std::io::Result<fs::File> {
    #[cfg(unix)]
    {
        OpenOptions::new().write(true).create_new(true).open(path)
    }
    #[cfg(windows)]
    {
        use super::atomic_windows_handle::Directory;
        let parent = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
        Directory::root(parent)?
            .create_private_file(path.file_name().ok_or(std::io::ErrorKind::InvalidInput)?)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edit {
    path: String,
    before_digest: Option<String>,
    content: Option<String>,
}

pub struct FilePatch {
    root: PathBuf,
    directory: PathBuf,
    request_id: String,
    digest: String,
    files: Vec<Edit>,
}

pub(super) fn hash(bytes: &[u8]) -> String {
    let mut state = gix::hash::hasher(gix::hash::Kind::Sha256);
    state.update(bytes);
    state
        .try_finalize()
        .expect("SHA256 is infallible")
        .to_string()
}

fn io_error() -> Failure {
    Failure::new(
        "file_recovery_required",
        "file installation did not finish; inspect retained files",
    )
}

fn regular(root: &Path, path: &str) -> Result<Option<(Vec<u8>, u32)>> {
    let mut current = root.to_path_buf();
    let parts: Vec<_> = path.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        current.push(part);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(info) => info,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => {
                return Err(Failure::new(
                    "file_conflict",
                    "cannot inspect file preimage",
                ))
            }
        };
        if metadata.file_type().is_symlink() || (index + 1 < parts.len() && !metadata.is_dir()) {
            return Err(Failure::new(
                "file_conflict",
                "file path crosses a symlink or non-directory",
            ));
        }
        if index + 1 == parts.len() {
            if !metadata.is_file() || metadata.len() > 8 << 20 {
                return Err(Failure::new(
                    "file_conflict",
                    "file preimage must be a bounded regular file",
                ));
            }
            let bytes = fs::read(&current)
                .map_err(|_| Failure::new("file_conflict", "cannot read file preimage"))?;
            if bytes.len() > 8 << 20 {
                return Err(Failure::new("file_conflict", "file preimage exceeds 8 MiB"));
            }
            let after = fs::symlink_metadata(&current)
                .map_err(|_| Failure::new("file_conflict", "file changed while reading"))?;
            if after.len() != metadata.len() || after.modified().ok() != metadata.modified().ok() {
                return Err(Failure::new("file_conflict", "file changed while reading"));
            }
            return Ok(Some((bytes, mode(&metadata))));
        }
    }
    Ok(None)
}

fn validate(files: &[Edit]) -> Result<()> {
    if files.is_empty() || files.len() > 30 {
        return Err(Failure::new(
            "invalid_request",
            "apply_files requires 1 to 30 edits",
        ));
    }
    let mut paths = std::collections::HashSet::new();
    let mut bytes = 0;
    for edit in files {
        if edit.path.is_empty()
            || edit.path.len() > 4096
            || edit.path.contains('\\')
            || edit.path.bytes().any(|byte| byte < 32 || byte == 127)
            || edit.path.split('/').any(|part| {
                matches!(part, "" | "." | "..")
                    || part.eq_ignore_ascii_case(".git")
                    || part.eq_ignore_ascii_case(".jj")
            })
            || !paths.insert(edit.path.as_str())
        {
            return Err(Failure::new(
                "invalid_request",
                "file edits require distinct canonical relative paths",
            ));
        }
        if let Some(before) = &edit.before_digest {
            if before.len() != 64
                || !before
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            {
                return Err(Failure::new(
                    "invalid_request",
                    "file preimage digest must be SHA256",
                ));
            }
        }
        if let Some(content) = &edit.content {
            bytes += content.len();
            if edit.before_digest.as_deref() == Some(hash(content.as_bytes()).as_str()) {
                return Err(Failure::new(
                    "invalid_request",
                    "file edit must change its preimage",
                ));
            }
        } else if edit.before_digest.is_none() {
            return Err(Failure::new(
                "invalid_request",
                "deletion requires an existing preimage",
            ));
        }
    }
    if bytes > 256 << 10
        || paths.iter().any(|path| {
            let mut parent = *path;
            while let Some((prefix, _)) = parent.rsplit_once('/') {
                if paths.contains(prefix) {
                    return true;
                }
                parent = prefix;
            }
            false
        })
    {
        return Err(Failure::new(
            "invalid_request",
            "file edits exceed 256 KiB or overlap ancestor paths",
        ));
    }
    Ok(())
}

impl FilePatch {
    pub fn new(root: &Path, request_id: &str, digest: &str, input: &Value) -> Result<Self> {
        let files: Vec<Edit> = serde_json::from_value(
            input
                .get("files")
                .cloned()
                .ok_or_else(|| Failure::new("invalid_request", "apply_files requires files"))?,
        )
        .map_err(|_| Failure::new("invalid_request", "file edits have invalid fields"))?;
        validate(&files)?;
        let root = root
            .canonicalize()
            .map_err(|_| Failure::new("file_conflict", "repository root is unavailable"))?;
        let parent = root
            .parent()
            .ok_or_else(|| Failure::new("file_conflict", "repository has no parent"))?;
        let directory = parent
            .join(".smithers-coding-recovery")
            .join(hash(root.to_string_lossy().as_bytes()))
            .join(request_id);
        Ok(Self {
            root,
            directory,
            request_id: request_id.into(),
            digest: digest.into(),
            files,
        })
    }

    pub fn recovery(&self) -> Value {
        json!({"requestId":self.request_id, "path":self.directory,
            "files":self.files.iter().enumerate().map(|(index, edit)| {
                let before = self.directory.join(format!("{index}.before"));
                let after = self.directory.join(format!("{index}.after"));
                json!({"path":edit.path, "preimage":before.exists().then_some(before),
                    "proposed":after.exists().then_some(after)})
            }).collect::<Vec<_>>()})
    }

    pub fn paths(&self) -> std::collections::HashSet<&str> {
        self.files.iter().map(|edit| edit.path.as_str()).collect()
    }

    fn failure(&self, code: &'static str, message: &str) -> Failure {
        Failure::new(code, message).with_recovery(self.recovery())
    }

    fn save(&self, phase: &str) -> Result<()> {
        let staged = self.directory.join("manifest.next");
        let mut file = create_staged_file(&staged).map_err(|_| io_error())?;
        let data = json!({"version":1, "digest":self.digest, "phase":phase});
        file.write_all(data.to_string().as_bytes())
            .map_err(|_| io_error())?;
        file.sync_all().map_err(|_| io_error())?;
        drop(file);
        fs::rename(&staged, self.directory.join("manifest.json")).map_err(|_| io_error())
    }

    pub fn prepare(&self) -> Result<bool> {
        if self.directory.exists() {
            let manifest: Value = serde_json::from_slice(
                &fs::read(self.directory.join("manifest.json")).map_err(|_| {
                    self.failure("file_recovery_required", "recovery manifest is missing")
                })?,
            )
            .map_err(|_| self.failure("file_recovery_required", "recovery manifest is invalid"))?;
            if manifest["digest"] != self.digest {
                return Err(self.failure(
                    "request_conflict",
                    "recovery belongs to different request content",
                ));
            }
            if manifest["phase"] != "installed" {
                return Err(self.failure(
                    "file_recovery_required",
                    "file installation was interrupted",
                ));
            }
            self.verify()?;
            return Ok(false);
        }
        for (index, edit) in self.files.iter().enumerate() {
            let current = regular(&self.root, &edit.path)?;
            if current.as_ref().map(|(data, _)| hash(data)) != edit.before_digest {
                return Err(Failure::new(
                    "file_conflict",
                    "file preimage changed; read and replan",
                ));
            }
            if index == 0 {
                private_recovery_directory(&self.directory).map_err(|_| io_error())?;
                self.save("preparing")?;
            }
            if let Some(content) = &edit.content {
                let staged = self.directory.join(format!("{index}.after"));
                let mut file = create_staged_file(&staged).map_err(|_| io_error())?;
                file.write_all(content.as_bytes()).map_err(|_| io_error())?;
                set_mode(&file, current.map(|(_, mode)| mode).unwrap_or(0o644))
                    .map_err(|_| io_error())?;
                file.sync_all().map_err(|_| io_error())?;
            }
        }
        self.save("prepared")?;
        Ok(true)
    }

    pub fn install(&self) -> Result<()> {
        self.save("applying")?;
        for (index, edit) in self.files.iter().enumerate() {
            let target = self.root.join(&edit.path);
            let parent = target
                .parent()
                .ok_or_else(|| self.failure("file_conflict", "file has no parent"))?;
            fs::create_dir_all(parent)
                .map_err(|_| self.failure("file_recovery_required", "cannot create file parent"))?;
            let current = regular(&self.root, &edit.path)?;
            if current.as_ref().map(|(data, _)| hash(data)) != edit.before_digest {
                return Err(self.failure("file_conflict", "file changed before installation"));
            }
            if current.is_some() {
                let saved = self.directory.join(format!("{index}.before"));
                if saved.exists() {
                    return Err(self.failure("file_conflict", "preimage recovery slot is occupied"));
                }
                fs::rename(&target, &saved).map_err(|_| {
                    self.failure("file_recovery_required", "cannot retain file preimage")
                })?;
                let retained = fs::read(&saved).map_err(|_| {
                    self.failure("file_recovery_required", "cannot inspect retained preimage")
                })?;
                if Some(hash(&retained)) != edit.before_digest {
                    return Err(self.failure(
                        "file_conflict",
                        "concurrent file edit was retained for recovery",
                    ));
                }
            }
            if edit.content.is_some() {
                // Keep the recovery proposal independent of the working file: the Flow
                // filesystem refuses content operations on files with multiple links.
                let proposal = self.directory.join(format!("{index}.after"));
                let install = self.directory.join(format!("{index}.install"));
                fs::copy(&proposal, &install).map_err(|_| io_error())?;
                fs::File::open(&install)
                    .and_then(|file| file.sync_all())
                    .map_err(|_| io_error())?;
                fs::hard_link(&install, &target).map_err(|_| {
                    self.failure("file_recovery_required", "cannot install proposed file")
                })?;
                fs::remove_file(&install).map_err(|_| io_error())?;
            }
        }
        self.verify()?;
        self.save("installed")
    }

    pub fn verify(&self) -> Result<()> {
        for (index, edit) in self.files.iter().enumerate() {
            if let Some(before) = &edit.before_digest {
                let saved = fs::read(self.directory.join(format!("{index}.before")))
                    .map_err(|_| self.failure("file_conflict", "retained preimage is missing"))?;
                if hash(&saved) != *before {
                    return Err(self.failure("file_conflict", "retained preimage changed"));
                }
            }
            let actual = regular(&self.root, &edit.path)?;
            if actual.as_ref().map(|(data, _)| data.as_slice())
                != edit.content.as_deref().map(str::as_bytes)
            {
                return Err(self.failure("file_conflict", "installed file changed"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;

    #[test]
    fn retains_preimages_and_readonly_mode_across_install_and_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repository");
        fs::create_dir(&root).unwrap();
        let original = root.join("original.txt");
        fs::write(&original, "before").unwrap();
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&original)
            .unwrap();
        set_mode(&file, 0o444).unwrap();
        drop(file);
        let request = json!({"files":[
            {"path":"original.txt", "beforeDigest":hash(b"before"), "content":"after"},
            {"path":"nested/new.txt", "content":"new"}
        ]});
        let patch = FilePatch::new(&root, "request-1", "digest-1", &request).unwrap();
        assert!(patch.prepare().unwrap());
        assert_eq!(fs::read(&original).unwrap(), b"before");
        patch.install().unwrap();
        assert_eq!(fs::read(&original).unwrap(), b"after");
        assert_eq!(mode(&fs::metadata(&original).unwrap()) & 0o200, 0);
        assert_eq!(fs::read(root.join("nested/new.txt")).unwrap(), b"new");
        assert_eq!(
            fs::read(patch.directory.join("0.before")).unwrap(),
            b"before"
        );
        let reopened = FilePatch::new(&root, "request-1", "digest-1", &request).unwrap();
        assert!(!reopened.prepare().unwrap());
        reopened.verify().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn installed_files_are_distinct_from_retained_proposals() {
        use std::os::unix::fs::MetadataExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repository");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("original.txt"), "before").unwrap();
        let request = json!({"files":[
            {"path":"original.txt", "beforeDigest":hash(b"before"), "content":"after"},
            {"path":"new.txt", "content":"new"}
        ]});
        let patch = FilePatch::new(&root, "request-4", "digest-4", &request).unwrap();
        assert!(patch.prepare().unwrap());
        patch.install().unwrap();
        for (index, name) in ["original.txt", "new.txt"].iter().enumerate() {
            let target = root.join(name);
            let proposed = patch.directory.join(format!("{index}.after"));
            assert_eq!(fs::metadata(&target).unwrap().nlink(), 1, "{name}");
            let retained = fs::read(&proposed).unwrap();
            fs::write(&target, "edited later").unwrap();
            assert_eq!(fs::read(&proposed).unwrap(), retained);
        }
    }

    #[test]
    fn refuses_changed_preimage_before_creating_recovery_and_preserves_unrelated_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repository");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("original.txt"), "concurrent edit").unwrap();
        let request = json!({"files":[
            {"path":"original.txt", "beforeDigest":hash(b"before"), "content":"after"}
        ]});
        let patch = FilePatch::new(&root, "request-2", "digest-2", &request).unwrap();
        assert!(patch.prepare().is_err());
        assert!(!patch.directory.exists());
        assert_eq!(
            fs::read(root.join("original.txt")).unwrap(),
            b"concurrent edit"
        );
    }

    #[cfg(windows)]
    #[test]
    fn refuses_a_recovery_parent_without_the_private_acl() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repository");
        fs::create_dir(&root).unwrap();
        let request = json!({"files":[{"path":"new.txt", "content":"private"}]});
        let patch = FilePatch::new(&root, "request-3", "digest-3", &request).unwrap();
        fs::create_dir(temp.path().join(".smithers-coding-recovery")).unwrap();
        assert!(patch.prepare().is_err());
        assert!(!root.join("new.txt").exists());
        assert!(!patch.directory.exists());
    }
}
