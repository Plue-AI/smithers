//! Flow filesystem requests evaluated through pinned Windows directory handles.
use super::atomic_glob::{relative_pattern, GlobRule};
use super::atomic_protocol::{self, syscall, HARD_LIMIT};
use super::atomic_windows_handle::{info, BoundaryError, Directory, Info};
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
};

const MAX_ENTRIES: usize = 100_000;
#[derive(Debug)]
struct Failure {
    code: &'static str,
    message: String,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Failure {}
fn error(code: &'static str, message: &str) -> io::Error {
    io::Error::other(Failure {
        code,
        message: message.to_owned(),
    })
}
fn invalid(message: &str) -> io::Error {
    error("EINVAL", message)
}
fn code(error: &io::Error) -> &'static str {
    if let Some(failure) = error
        .get_ref()
        .and_then(|value| value.downcast_ref::<Failure>())
    {
        return failure.code;
    }
    if let Some(boundary) = error
        .get_ref()
        .and_then(|value| value.downcast_ref::<BoundaryError>())
    {
        return match boundary {
            BoundaryError::ReparsePoint => "ELOOP",
            _ => "EPERM",
        };
    }
    match error.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::AlreadyExists => "EEXIST",
        io::ErrorKind::PermissionDenied => "EACCES",
        io::ErrorKind::NotADirectory => "ENOTDIR",
        io::ErrorKind::IsADirectory => "EISDIR",
        io::ErrorKind::DirectoryNotEmpty => "ENOTEMPTY",
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => "EINVAL",
        io::ErrorKind::FileTooLarge => "EFBIG",
        io::ErrorKind::WouldBlock | io::ErrorKind::ResourceBusy => "EBUSY",
        io::ErrorKind::Unsupported => "ENOTSUP",
        _ => "EIO",
    }
}
fn field<'a>(value: &'a Value, key: &str) -> io::Result<&'a str> {
    value[key].as_str().ok_or_else(|| invalid(key))
}
fn confined<'a>(root: &Directory, request: &Value, path: &'a str) -> io::Result<Vec<&'a OsStr>> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(invalid("path must be absolute"));
    }
    // Native realPath expands DOS short names even when the host's public
    // adapter preserves them. Accept the spelling observed from this pinned
    // handle as well as the two request roots; never reopen a caller alias.
    let canonical = root.canonical_path(None)?;
    for base in ["logicalRoot", "boundaryRoot"]
        .into_iter()
        .filter_map(|key| request[key].as_str())
        .chain(std::iter::once(canonical.as_str()))
    {
        if let Ok(relative) = path.strip_prefix(base) {
            return relative
                .components()
                .filter_map(|part| match part {
                    Component::Normal(name) => Some(Ok(name)),
                    Component::CurDir => None,
                    _ => Some(Err(error("EPERM", "parent traversal denied"))),
                })
                .collect();
        }
    }
    Err(error("EPERM", "path outside pinned root"))
}

fn directory(root: &Directory, parts: &[&OsStr], create: bool) -> io::Result<Directory> {
    let mut current = root.try_clone()?;
    for name in parts {
        current = match current.child(name) {
            Ok(child) => child,
            Err(failure) if create && failure.kind() == io::ErrorKind::NotFound => {
                match current.create_private_directory(name) {
                    Ok(child) => child,
                    Err(failure) if failure.kind() == io::ErrorKind::AlreadyExists => {
                        current.child(name)?
                    }
                    Err(failure) => return Err(failure),
                }
            }
            Err(failure) => return Err(failure),
        };
    }
    Ok(current)
}
fn parent<'a>(
    root: &Directory,
    request: &'a Value,
    path: &'a str,
    create: bool,
) -> io::Result<(Directory, &'a OsStr)> {
    let parts = confined(root, request, path)?;
    let (name, parents) = parts
        .split_last()
        .ok_or_else(|| error("EPERM", "refusing root mutation"))?;
    Ok((directory(root, parents, create)?, name))
}
fn joined(base: &str, relative: &str) -> String {
    relative
        .split('/')
        .fold(PathBuf::from(base), |mut path, component| {
            path.push(component);
            path
        })
        .to_string_lossy()
        .into_owned()
}
/// Resolves `parts` below the pinned root the way kernel authorization needs
/// it (#2882). Every entry is opened relative to its parent handle with
/// `FILE_OPEN_REPARSE_POINT`, so no link, junction or mount point is ever
/// followed: the walk stops at the first reparse point and answers its own
/// path with its translated text as `target`, and at the first missing
/// component or non-directory parent, whose requested spelling is kept for
/// itself and every descendant. Existing entries answer the canonical path of
/// their own handle.
fn resolve(root: &Directory, parts: &[&OsStr]) -> io::Result<Value> {
    let answer = |base: String, rest: &[&OsStr], target: Option<String>| {
        let path = rest.iter().fold(PathBuf::from(base), |mut path, part| {
            path.push(part);
            path
        });
        json!({"path":path.to_string_lossy(),"target":target})
    };
    let mut current = root.try_clone()?;
    for (index, part) in parts.iter().enumerate() {
        let metadata = match current.metadata(part) {
            Ok(metadata) => metadata,
            Err(failure) if matches!(code(&failure), "ENOENT" | "ENOTDIR") => {
                return Ok(answer(current.canonical_path(None)?, &parts[index..], None));
            }
            Err(failure) => return Err(failure),
        };
        if metadata.basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            let target = current.read_link(part)?.to_string_lossy().into_owned();
            return Ok(answer(
                current.canonical_path(None)?,
                std::slice::from_ref(part),
                Some(target),
            ));
        }
        if index + 1 == parts.len() || !is_directory(&metadata) {
            return Ok(answer(
                current.canonical_path(Some(part))?,
                &parts[index + 1..],
                None,
            ));
        }
        current = current.child(part)?;
    }
    Ok(answer(current.canonical_path(None)?, &[], None))
}
fn is_directory(info: &Info) -> bool {
    info.basic.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
        == FILE_ATTRIBUTE_DIRECTORY
}
fn reject_link(info: &Info) -> io::Result<()> {
    if info.basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        Err(error("ELOOP", "reparse point traversal denied"))
    } else {
        Ok(())
    }
}
fn names(dir: &Directory) -> io::Result<Vec<String>> {
    dir.entries(MAX_ENTRIES)?
        .into_iter()
        .map(|name| {
            name.into_string()
                .map_err(|_| invalid("entry name is not Unicode"))
        })
        .collect()
}
fn listing(
    dir: &Directory,
    recursive: bool,
    prefix: &str,
    depth: usize,
    result: &mut Vec<String>,
) -> io::Result<()> {
    if depth > 512 {
        return Err(error("EFBIG", "directory is too deep"));
    }
    for name in names(dir)? {
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        result.push(relative.clone());
        if result.len() > MAX_ENTRIES {
            return Err(error("EFBIG", "directory listing too large"));
        }
        if recursive && is_directory(&dir.metadata(OsStr::new(&name))?) {
            listing(
                &dir.child(OsStr::new(&name))?,
                true,
                &relative,
                depth + 1,
                result,
            )?;
        }
    }
    Ok(())
}
fn remove(dir: &Directory, name: &OsStr, recursive: bool, depth: usize) -> io::Result<()> {
    let metadata = dir.metadata(name)?;
    reject_link(&metadata)?;
    if recursive && is_directory(&metadata) {
        if depth > 512 {
            return Err(error("EFBIG", "remove depth exceeded"));
        }
        let child = dir.child(name)?;
        for entry in names(&child)? {
            remove(&child, OsStr::new(&entry), true, depth + 1)?;
        }
        // Drop the traversal handle before opening the entry with DELETE.
        drop(child);
    }
    dir.remove(name)
}
fn digest_with_hook(
    root: &Directory,
    request: &Value,
    content_limit: usize,
    after_read: impl FnOnce(),
) -> io::Result<Value> {
    let path = field(request, "path")?;
    let (dir, name) = parent(root, request, path, false)?;
    let mut file = dir.read_file(name)?;
    let before = info(&file)?.fingerprint();
    let mut bytes = Vec::new();
    (&mut file)
        .take(content_limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > content_limit {
        return Err(error("EFBIG", "file exceeds content limit"));
    }
    after_read();
    let after = info(&file)?.fingerprint();
    let entry = dir
        .metadata(name)
        .map_err(|_| error("EBUSY", "entry changed during measurement"))?;
    if before != after || before != entry.fingerprint() {
        return Err(error("EBUSY", "entry changed during measurement"));
    }
    let mut value =
        json!({"digest":format!("{:x}", Sha256::digest(&bytes)), "sizeBytes":bytes.len()});
    if request["content"] == true {
        value["base64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
    }
    Ok(value)
}
struct GlobWalk<'a> {
    selected: &'a GlobRule,
    excluded: &'a [GlobRule],
    base: &'a str,
    limit: usize,
}
fn glob_walk(
    dir: &Directory,
    prefix: &str,
    rules: &GlobWalk<'_>,
    depth: usize,
    budget: &mut usize,
    result: &mut Vec<String>,
) -> io::Result<()> {
    if depth > 512 {
        return Err(error("EFBIG", "glob depth exceeded"));
    }
    for name in names(dir)? {
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let directory = is_directory(&dir.metadata(OsStr::new(&name))?);
        *budget += relative.len() + 4;
        if *budget > rules.limit {
            return Err(error("EFBIG", "glob listing exceeds response limit"));
        }
        if rules
            .excluded
            .iter()
            .any(|rule| rule.matches(&relative, directory))
        {
            continue;
        }
        if rules.selected.matches(&relative, directory) {
            result.push(joined(rules.base, &relative));
            if result.len() > MAX_ENTRIES {
                return Err(error("EFBIG", "glob result too large"));
            }
        }
        if directory && rules.selected.below(&relative) {
            glob_walk(
                &dir.child(OsStr::new(&name))?,
                &relative,
                rules,
                depth + 1,
                budget,
                result,
            )?;
        }
    }
    Ok(())
}
fn glob_pattern(pattern: &str, base: &str, exclusion: bool) -> String {
    let path = Path::new(pattern);
    let pattern = if path.is_absolute() {
        pattern.replace('\\', "/")
    } else if exclusion && path.has_root() {
        // A leading backslash is rooted on the glob root's drive, not an
        // escape that can be dropped to turn it into a workspace basename.
        let prefix = match Path::new(base).components().next() {
            Some(Component::Prefix(prefix)) => prefix.as_os_str().to_string_lossy(),
            _ => return "\0".to_owned(),
        };
        format!("{prefix}{}", pattern.replace('\\', "/"))
    } else {
        pattern.to_owned()
    };
    relative_pattern(&pattern, &base.replace('\\', "/"), exclusion)
}

pub(super) fn run(
    request: &Value,
    content_limit: usize,
    response_limit: usize,
) -> io::Result<Value> {
    let operation = field(request, "operation")?;
    let boundary = field(request, "boundaryRoot")?;
    let root = Directory::root(Path::new(boundary))
        .map_err(|_| error("EPERM", "atomic root unavailable"))?;
    if root.identity()? != field(request, "rootIdentity")? {
        return Err(error("EPERM", "root identity changed"));
    }
    let options = &request["options"];
    match operation {
        "exists" | "stat" | "realPath" => {
            let path = field(request, "path")?;
            let parts = confined(&root, request, path)?;
            let metadata = if parts.is_empty() {
                root.self_info()
            } else {
                parent(&root, request, path, false).and_then(|(dir, name)| dir.metadata(name))
            };
            let metadata = match metadata {
                Err(failure) if operation == "exists" && code(&failure) == "ENOENT" => {
                    return Ok(json!(false))
                }
                result => result?,
            };
            reject_link(&metadata)?;
            if operation == "exists" {
                return Ok(json!(true));
            }
            if operation == "stat" {
                return metadata.stat_json();
            }
            let canonical = if parts.is_empty() {
                root.canonical_path(None)?
            } else {
                let (directory, name) = parent(&root, request, path, false)?;
                directory.canonical_path(Some(name))?
            };
            Ok(json!(canonical))
        }
        "readFile" | "readFileString" => {
            let path = field(request, "path")?;
            if confined(&root, request, path)?.is_empty() {
                return Err(error("EISDIR", "root is a directory"));
            }
            let (dir, name) = parent(&root, request, path, false)?;
            let mut bytes = Vec::new();
            dir.read_file(name)?
                .take(content_limit as u64 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > content_limit {
                return Err(error("EFBIG", "file exceeds content limit"));
            }
            Ok(json!({"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}))
        }
        "writeFile" | "writeFileString" => {
            let path = field(request, "path")?;
            if confined(&root, request, path)?.is_empty() {
                return Err(error("EISDIR", "root is a directory"));
            }
            let flag = options["flag"].as_str().unwrap_or("w");
            let (create, exclusive, truncate, append) = match flag {
                "r" => return Err(error("EBADF", "file not opened for writing")),
                "r+" => (false, false, false, false),
                "w" | "w+" => (true, false, true, false),
                "wx" | "wx+" => (true, true, false, false),
                "a" | "a+" => (true, false, false, true),
                "ax" | "ax+" => (true, true, false, true),
                _ => return Err(invalid("unknown file open flag")),
            };
            let data = field(request, "data")?;
            let bytes = if operation == "writeFile" {
                base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|_| invalid("invalid base64"))?
            } else {
                data.as_bytes().to_vec()
            };
            if bytes.len() > content_limit {
                return Err(error("EFBIG", "payload exceeds content limit"));
            }
            let (dir, name) = parent(&root, request, path, false)?;
            let (mut file, created) = if exclusive {
                (dir.create_private_file(name)?, true)
            } else {
                match dir.write_existing_file(name) {
                    Ok(file) => (file, false),
                    Err(failure) if create && code(&failure) == "ENOENT" => {
                        match dir.create_private_file(name) {
                            Ok(file) => (file, true),
                            Err(failure) if code(&failure) == "EEXIST" => {
                                (dir.write_existing_file(name)?, false)
                            }
                            Err(failure) => return Err(failure),
                        }
                    }
                    Err(failure) => return Err(failure),
                }
            };
            if truncate {
                file.set_len(0)?;
            }
            if append {
                file.seek(SeekFrom::End(0))?;
            }
            file.write_all(&bytes)?;
            if created && options["mode"].as_u64().unwrap_or(0o666) & 0o200 == 0 {
                let mut permissions = file.metadata()?.permissions();
                permissions.set_readonly(true);
                file.set_permissions(permissions)?;
            }
            file.sync_all()?;
            Ok(Value::Null)
        }
        "makeDirectory" => {
            let path = field(request, "path")?;
            let recursive = options["recursive"].as_bool().unwrap_or(false);
            if confined(&root, request, path)?.is_empty() {
                return if recursive {
                    Ok(Value::Null)
                } else {
                    Err(error("EEXIST", "root exists"))
                };
            }
            let (dir, name) = parent(&root, request, path, recursive)?;
            match dir.create_private_directory(name) {
                Ok(_) => {}
                Err(failure) if matches!(code(&failure), "EEXIST" | "ENOTDIR") => {
                    let existing = dir.metadata(name)?;
                    reject_link(&existing)?;
                    if existing.basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 || !recursive {
                        return Err(error("EEXIST", "entry already exists"));
                    }
                    dir.child(name)?;
                }
                Err(failure) => return Err(failure),
            }
            Ok(Value::Null)
        }
        "readDirectory" => {
            let dir = directory(
                &root,
                &confined(&root, request, field(request, "path")?)?,
                false,
            )?;
            let mut entries = Vec::new();
            listing(
                &dir,
                options["recursive"].as_bool().unwrap_or(false),
                "",
                0,
                &mut entries,
            )?;
            Ok(json!(entries))
        }
        "remove" => {
            let force = options["force"].as_bool().unwrap_or(false);
            let result =
                parent(&root, request, field(request, "path")?, false).and_then(|(dir, name)| {
                    remove(
                        &dir,
                        name,
                        options["recursive"].as_bool().unwrap_or(false),
                        0,
                    )
                });
            match result {
                Err(failure) if force && code(&failure) == "ENOENT" => Ok(Value::Null),
                result => result.map(|_| Value::Null),
            }
        }
        "rename" => {
            let (from_dir, from) = parent(&root, request, field(request, "from")?, false)?;
            let (to_dir, to) = parent(&root, request, field(request, "to")?, false)?;
            from_dir.rename(from, &to_dir, to)?;
            Ok(Value::Null)
        }
        "chmod" => {
            let mode = options["mode"]
                .as_u64()
                .filter(|mode| *mode <= 0o7777)
                .ok_or_else(|| invalid("invalid mode"))?;
            let (dir, name) = parent(&root, request, field(request, "path")?, false)?;
            dir.set_readonly(name, mode & 0o200 == 0)?;
            Ok(Value::Null)
        }
        "chown" => {
            let uid = options["uid"]
                .as_i64()
                .filter(|value| *value >= -1)
                .ok_or_else(|| invalid("invalid owner"))?;
            let gid = options["gid"]
                .as_i64()
                .filter(|value| *value >= -1)
                .ok_or_else(|| invalid("invalid group"))?;
            let (dir, name) = parent(&root, request, field(request, "path")?, false)?;
            // -1 retains the owner/group. Numeric POSIX identities cannot name
            // a Windows SID, so an actual ownership change is refused.
            let _file = dir.read_file(name)?;
            if uid != -1 || gid != -1 {
                return Err(error("ENOTSUP", "Windows ownership requires a SID"));
            }
            Ok(Value::Null)
        }
        "readLink" => {
            let path = field(request, "path")?;
            if confined(&root, request, path)?.is_empty() {
                return Err(invalid("root is not a link"));
            }
            let (dir, name) = parent(&root, request, path, false)?;
            Ok(json!(dir.read_link(name)?.to_string_lossy()))
        }
        "resolve" => resolve(&root, &confined(&root, request, field(request, "path")?)?),
        "digest" => digest_with_hook(&root, request, content_limit, || {}),
        "glob" => {
            let base = field(request, "root")?;
            let dir = directory(&root, &confined(&root, request, base)?, false)?;
            let selected =
                GlobRule::new(&glob_pattern(field(request, "pattern")?, base, false), true)?;
            let excluded = options["exclude"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|value| GlobRule::new(&glob_pattern(value, base, true), false))
                        .collect::<io::Result<Vec<_>>>()
                })
                .transpose()?
                .unwrap_or_default();
            if excluded.iter().any(GlobRule::includes_root) {
                return Ok(json!([]));
            }
            let mut result = Vec::new();
            if selected.matches("", true) {
                result.push(base.to_owned());
            }
            let mut budget = 32;
            if selected.below("") {
                glob_walk(
                    &dir,
                    "",
                    &GlobWalk {
                        selected: &selected,
                        excluded: &excluded,
                        base,
                        limit: response_limit,
                    },
                    0,
                    &mut budget,
                    &mut result,
                )?;
            }
            Ok(json!(result))
        }
        "batch" => {
            let members = request["requests"]
                .as_array()
                .ok_or_else(|| invalid("requests"))?;
            let batch_limit = request["batchSize"]
                .as_u64()
                .ok_or_else(|| invalid("batch size"))? as usize;
            let entry_limit = request["batchEntry"]
                .as_u64()
                .ok_or_else(|| invalid("batch entry"))? as usize;
            if members.is_empty()
                || batch_limit == 0
                || batch_limit > 128
                || members.len() > batch_limit
                || entry_limit == 0
                || entry_limit > HARD_LIMIT
            {
                return Err(invalid("batch limits"));
            }
            let mut entries = Vec::new();
            for (index, member) in members.iter().enumerate() {
                let mut sub = member.clone();
                if !sub.is_object() || sub["operation"] == "batch" {
                    return Err(invalid("invalid batch member"));
                }
                for key in ["logicalRoot", "boundaryRoot", "rootIdentity"] {
                    sub[key] = request[key].clone();
                }
                if sub["operation"] == "glob" {
                    sub["pattern"] = sub["path"].clone();
                }
                let result = if sub["operation"] == "digest" {
                    digest_with_hook(&root, &sub, content_limit, || {})
                } else {
                    run(&sub, content_limit, response_limit)
                };
                let result = match result {
                    Ok(value) => {
                        let success = json!({"ok":true,"value":value});
                        if serde_json::to_vec(&success)?.len() > entry_limit {
                            rejection(&sub, &error("EFBIG", "batch entry exceeds limit"))
                        } else {
                            success
                        }
                    }
                    Err(failure) => rejection(&sub, &failure),
                };
                if serde_json::to_vec(&result)?.len() > entry_limit {
                    return Err(error("EFBIG", "batch failure exceeds entry limit"));
                }
                entries.push(json!({"index":index,"path":member["path"],"result":result}));
            }
            entries.sort_by(|a, b| {
                a["path"]
                    .as_str()
                    .unwrap_or("")
                    .encode_utf16()
                    .cmp(b["path"].as_str().unwrap_or("").encode_utf16())
                    .then_with(|| a["index"].as_u64().cmp(&b["index"].as_u64()))
            });
            Ok(json!({"rootIdentity":request["rootIdentity"],"entries":entries}))
        }
        _ => Err(error("ENOTSUP", "unsupported atomic operation")),
    }
}
pub(super) fn rejection(request: &Value, failure: &io::Error) -> Value {
    let operation = request["operation"].as_str().unwrap_or("");
    let code = code(failure);
    let flag = request["options"]["flag"].as_str().unwrap_or("w");
    let bad_argument = code == "EINVAL"
        && (operation == "glob"
            || (["writeFile", "writeFileString"].contains(&operation)
                && !["r", "r+", "w", "w+", "wx", "wx+", "a", "a+", "ax", "ax+"].contains(&flag)));
    json!({"ok":false,"code":code,"syscall":syscall(operation),"badArgument":bad_argument,"message":failure.to_string()})
}
pub(super) fn serve() -> io::Result<()> {
    atomic_protocol::serve(run, rejection, invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::windows::fs::{symlink_dir, symlink_file};

    #[test]
    fn drive_rooted_exclusions_do_not_become_workspace_basenames() {
        assert_eq!(
            glob_pattern(r"\a-b.txt", r"C:\workspace", true),
            "C:/a-b.txt"
        );
        assert_eq!(glob_pattern(r"\a-b.txt", r"C:\", true), "a-b.txt");
        assert_eq!(
            glob_pattern(r"\workspace\a-b.txt", r"C:\workspace", true),
            "a-b.txt"
        );
        assert_eq!(glob_pattern(r"\*.txt", r"C:\workspace", false), "\0");
    }

    struct Fixture {
        _temporary: tempfile::TempDir,
        root: PathBuf,
        identity: String,
    }
    impl Fixture {
        fn new() -> Self {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().join("workspace");
            fs::create_dir(&root).unwrap();
            let identity = Directory::root(&root).unwrap().identity().unwrap();
            Self {
                _temporary: temporary,
                root,
                identity,
            }
        }
        fn request(&self, operation: &str, path: &str) -> Value {
            json!({"operation":operation,"path":self.root.join(path),"logicalRoot":self.root,
                "boundaryRoot":self.root,"rootIdentity":self.identity,"options":{}})
        }
        fn execute(&self, request: Value) -> Value {
            run(&request, 16_384, 1_048_576).unwrap()
        }
        fn refusal(&self, request: Value) -> Value {
            rejection(&request, &run(&request, 16_384, 1_048_576).unwrap_err())
        }
    }

    #[test]
    fn executes_the_request_protocol_against_real_windows_files() {
        let _entrypoint: fn() -> io::Result<()> = serve;
        let fixture = Fixture::new();
        let mut mkdir = fixture.request("makeDirectory", "nested/deeper");
        mkdir["options"] = json!({"recursive":true});
        assert_eq!(fixture.execute(mkdir), Value::Null);
        let mut write = fixture.request("writeFileString", "nested/deeper/note.txt");
        write["data"] = json!("hello");
        write["options"] = json!({"flag":"wx","mode":0o600});
        fixture.execute(write.clone());
        assert_eq!(fixture.refusal(write.clone())["code"], "EEXIST");
        write["options"] = json!({"flag":"a+"});
        write["data"] = json!("!");
        fixture.execute(write.clone());
        write["options"] = json!({"flag":"r+"});
        write["data"] = json!("H");
        fixture.execute(write);
        let read = fixture.execute(fixture.request("readFileString", "nested/deeper/note.txt"));
        assert_eq!(read["base64"], "SGVsbG8h");
        assert_eq!(fixture.execute(fixture.request("exists", "absent")), false);
        assert_eq!(
            fixture.execute(fixture.request("stat", "nested/deeper/note.txt"))["size"],
            "6"
        );
        let native = std::process::Command::new("node")
            .args([
                "-e",
                "console.log(JSON.stringify(require('node:fs').realpathSync.native(process.argv[1])))",
            ])
            .arg(fixture.root.join("nested/deeper/note.txt"))
            .output()
            .unwrap();
        assert!(native.status.success());
        assert_eq!(
            fixture.execute(fixture.request("realPath", "nested/deeper/note.txt")),
            serde_json::from_slice::<Value>(&native.stdout).unwrap()
        );
        let canonical: Value = serde_json::from_slice(&native.stdout).unwrap();
        for operation in ["realPath", "readFileString", "stat"] {
            let mut request = fixture.request(operation, "nested/deeper/note.txt");
            request["path"] = canonical.clone();
            request["logicalRoot"] = json!(fixture.root.parent().unwrap().join("workspace-alias"));
            let result = fixture.execute(request);
            match operation {
                "realPath" => assert_eq!(result, canonical),
                "readFileString" => assert_eq!(result["base64"], "SGVsbG8h"),
                _ => assert_eq!(result["size"], "6"),
            }
        }
        let mut bytes = fixture.request("writeFile", "bytes");
        bytes["data"] = json!("AQID");
        fixture.execute(bytes);
        assert_eq!(
            fixture.execute(fixture.request("readFile", "bytes"))["base64"],
            "AQID"
        );
        let mut listing = fixture.request("readDirectory", "");
        listing["options"] = json!({"recursive":true});
        assert_eq!(
            fixture.execute(listing),
            json!(["bytes", "nested", "nested/deeper", "nested/deeper/note.txt"])
        );
        let mut glob = fixture.request("glob", "");
        glob["root"] = json!(fixture.root);
        glob["pattern"] = json!("**/*.txt");
        assert_eq!(
            fixture.execute(glob.clone()),
            json!([fixture.root.join("nested").join("deeper").join("note.txt")])
        );
        glob["pattern"] = json!(fixture.root.join("**/*.txt"));
        assert_eq!(fixture.execute(glob.clone()).as_array().unwrap().len(), 1);
        glob["options"] = json!({"exclude":["nested/**"]});
        assert_eq!(fixture.execute(glob), json!([]));
        let mut rename = fixture.request("rename", "");
        rename["from"] = json!(fixture.root.join("nested/deeper/note.txt"));
        rename["to"] = json!(fixture.root.join("nested/deeper/renamed.txt"));
        fixture.execute(rename);
        let mut chmod = fixture.request("chmod", "nested/deeper/renamed.txt");
        chmod["options"] = json!({"mode":0o444});
        fixture.execute(chmod.clone());
        assert_eq!(
            fixture.execute(fixture.request("stat", "nested/deeper/renamed.txt"))["mode"]
                .as_u64()
                .unwrap()
                & 0o222,
            0
        );
        chmod["options"] = json!({"mode":0o600});
        fixture.execute(chmod);
        let mut chown = fixture.request("chown", "nested/deeper/renamed.txt");
        chown["options"] = json!({"uid":-1,"gid":-1});
        fixture.execute(chown);
        let link_target = PathBuf::from("nested").join("deeper").join("renamed.txt");
        symlink_file(&link_target, fixture.root.join("link")).unwrap();
        assert_eq!(
            fixture.execute(fixture.request("readLink", "link")),
            json!(link_target)
        );
        assert_eq!(
            fixture.refusal(fixture.request("remove", "link"))["code"],
            "ELOOP"
        );
        fs::remove_file(fixture.root.join("link")).unwrap();
        let mut remove = fixture.request("remove", "nested");
        remove["options"] = json!({"recursive":true});
        fixture.execute(remove);
        assert!(!fixture.root.join("nested").exists());
    }

    #[test]
    fn recursive_directory_creation_reports_an_existing_regular_file() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("file"), b"retained").unwrap();
        for recursive in [false, true] {
            let mut request = fixture.request("makeDirectory", "file");
            request["options"] = json!({"recursive":recursive});
            assert_eq!(fixture.refusal(request)["code"], "EEXIST");
        }
        assert_eq!(fs::read(fixture.root.join("file")).unwrap(), b"retained");
    }

    #[test]
    fn resolve_answers_canonical_paths_and_stops_at_reparse_points() {
        let fixture = Fixture::new();
        let report = fixture.root.join("ReportDir");
        fs::create_dir(&report).unwrap();
        fs::write(report.join("Note.txt"), "").unwrap();
        fs::hard_link(report.join("Note.txt"), fixture.root.join("hard")).unwrap();
        let outside = fixture.root.parent().unwrap().join("outside");
        fs::create_dir(&outside).unwrap();
        symlink_dir(&outside, fixture.root.join("share")).unwrap();
        let native = |path: &Path| -> PathBuf {
            let output = std::process::Command::new("node")
                .args([
                    "-e",
                    "console.log(JSON.stringify(require('node:fs').realpathSync.native(process.argv[1])))",
                ])
                .arg(path)
                .output()
                .unwrap();
            assert!(output.status.success());
            PathBuf::from(serde_json::from_slice::<String>(&output.stdout).unwrap())
        };
        let resolve = |path: &str| fixture.execute(fixture.request("resolve", path));
        let at = |path: PathBuf| json!({"path":path,"target":null});
        let note = native(&report.join("Note.txt"));
        assert_eq!(resolve("REPORTDIR/note.TXT"), at(note.clone()));
        assert_eq!(resolve(""), at(native(&fixture.root)));
        assert_eq!(
            resolve("reportdir/New/child"),
            at(native(&report).join("New").join("child"))
        );
        assert_eq!(resolve("ReportDir/Note.txt/child"), at(note.join("child")));
        // A hard link's name is an answer; its content stays refused.
        let hard = resolve("hard");
        assert!(
            [native(&fixture.root).join("hard"), note]
                .iter()
                .any(|path| hard == at(path.clone())),
            "{hard}"
        );
        // A directory link is answered by its own path and text; the share
        // behind it is never opened.
        let link = resolve("share/file");
        assert_eq!(link["path"], json!(native(&fixture.root).join("share")));
        assert!(link["target"]
            .as_str()
            .unwrap()
            .to_ascii_lowercase()
            .ends_with("outside"));
    }

    #[test]
    fn refuses_aliases_and_limits_before_mutating_content() {
        let fixture = Fixture::new();
        let outside = fixture.root.parent().unwrap().join("outside");
        fs::write(&outside, "outside").unwrap();
        symlink_file(&outside, fixture.root.join("symbolic")).unwrap();
        fs::hard_link(&outside, fixture.root.join("hard")).unwrap();
        for name in ["symbolic", "hard"] {
            for operation in ["readFile", "stat", "writeFileString", "chmod", "chown"] {
                let mut request = fixture.request(operation, name);
                request["data"] = json!("overwritten");
                request["options"] = json!({"mode":0o777,"uid":-1,"gid":-1});
                let refusal = fixture.refusal(request);
                assert!(
                    ["ELOOP", "EPERM"].contains(&refusal["code"].as_str().unwrap()),
                    "{operation}: {refusal}"
                );
            }
        }
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
        fs::write(fixture.root.join("safe"), "retained").unwrap();
        let mut request = fixture.request("writeFileString", "safe");
        request["data"] = json!("too long");
        assert_eq!(code(&run(&request, 2, 1024).unwrap_err()), "EFBIG");
        assert_eq!(
            fs::read_to_string(fixture.root.join("safe")).unwrap(),
            "retained"
        );
        assert_eq!(
            code(&run(&fixture.request("readFile", "safe"), 2, 1024).unwrap_err()),
            "EFBIG"
        );
        assert_eq!(
            fixture.refusal(fixture.request("readFile", "../outside"))["code"],
            "EPERM"
        );
        assert_eq!(
            fixture.refusal(fixture.request("remove", ""))["code"],
            "EPERM"
        );
        let mut force = fixture.request("remove", "absent/child");
        force["options"] = json!({"force":true,"recursive":true});
        assert_eq!(fixture.execute(force), Value::Null);
        let moved = fixture.root.with_file_name("moved");
        fs::rename(&fixture.root, &moved).unwrap();
        fs::create_dir(&fixture.root).unwrap();
        assert_eq!(
            fixture.refusal(fixture.request("exists", ""))["code"],
            "EPERM"
        );
    }

    #[test]
    fn measures_stable_content_and_preserves_batch_failures() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("content"), b"hello").unwrap();
        let mut digest = fixture.request("digest", "content");
        digest["content"] = json!(true);
        let measured = fixture.execute(digest.clone());
        assert_eq!(
            measured["digest"],
            format!("{:x}", Sha256::digest(b"hello"))
        );
        assert_eq!(measured["base64"], "aGVsbG8=");
        let root = Directory::root(&fixture.root).unwrap();
        assert_eq!(
            code(
                &digest_with_hook(&root, &digest, 1024, || fs::write(
                    fixture.root.join("content"),
                    b"changed"
                )
                .unwrap())
                .unwrap_err()
            ),
            "EBUSY"
        );
        let mut batch = fixture.request("batch", "");
        batch["batchSize"] = json!(128);
        batch["batchEntry"] = json!(4096);
        batch["requests"] = json!([
            {"operation":"stat","path":fixture.root.join("missing")},
            {"operation":"digest","path":fixture.root.join("content"),"content":true}
        ]);
        let result = fixture.execute(batch.clone());
        assert_eq!(result["rootIdentity"], fixture.identity);
        assert_eq!(result["entries"][0]["index"], 1);
        assert_eq!(result["entries"][0]["result"]["ok"], true);
        assert_eq!(result["entries"][1]["result"]["code"], "ENOENT");
        batch["batchSize"] = json!(1);
        assert_eq!(fixture.refusal(batch)["code"], "EINVAL");
    }

    #[test]
    fn reports_invalid_arguments_and_unsupported_ownership_honestly() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("file"), "unchanged").unwrap();
        let mut request = fixture.request("writeFileString", "file");
        request["options"] = json!({"flag":"unrecognized"});
        request["data"] = json!("new");
        let refusal = fixture.refusal(request);
        assert_eq!(refusal["code"], "EINVAL");
        assert_eq!(refusal["badArgument"], true);
        let mut request = fixture.request("chown", "file");
        request["options"] = json!({"uid":1000,"gid":-1});
        assert_eq!(fixture.refusal(request.clone())["code"], "ENOTSUP");
        request["options"] = json!({"uid":-2,"gid":-1});
        assert_eq!(fixture.refusal(request)["code"], "EINVAL");
        assert_eq!(
            fs::read_to_string(fixture.root.join("file")).unwrap(),
            "unchanged"
        );
    }
}
