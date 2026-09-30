//! Descriptor-relative filesystem requests for the Flow host. The root and every
//! traversed directory are opened with O_NOFOLLOW; content uses a checked fd.
use super::atomic_glob::{relative_pattern, GlobRule};
use super::atomic_protocol::{self, syscall, HARD_LIMIT};
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::ffi::{CStr, CString, OsStr};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path};

const MAX_ENTRIES: usize = 100_000;

fn error(code: i32, _message: &str) -> io::Error {
    io::Error::from_raw_os_error(code)
}
fn invalid(message: &str) -> io::Error {
    error(libc::EINVAL, message)
}
fn field<'a>(value: &'a Value, key: &str) -> io::Result<&'a str> {
    value[key].as_str().ok_or_else(|| invalid(key))
}
fn cstring(value: &OsStr) -> io::Result<CString> {
    CString::new(value.as_bytes()).map_err(|_| invalid("NUL in path"))
}
fn open_at(dir: RawFd, name: &OsStr, flags: i32, mode: u32) -> io::Result<File> {
    let name = cstring(name)?;
    let fd = unsafe {
        libc::openat(
            dir,
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
fn duplicate(file: &File) -> io::Result<File> {
    let fd = unsafe { libc::dup(file.as_raw_fd()) };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
fn components(path: &str) -> io::Result<Vec<&OsStr>> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(invalid("path must be absolute"));
    }
    let mut result = Vec::new();
    for part in path.components() {
        match part {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(name) => result.push(name),
            _ => return Err(error(libc::EPERM, "parent traversal denied")),
        }
    }
    Ok(result)
}
fn directory(root: &File, parts: &[&OsStr], create: bool, mode: u32) -> io::Result<File> {
    let mut current = duplicate(root)?;
    for part in parts {
        let next = match open_at(
            current.as_raw_fd(),
            part,
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        ) {
            Ok(next) => next,
            Err(e) if create && e.raw_os_error() == Some(libc::ENOENT) => {
                let name = cstring(part)?;
                let rc = unsafe {
                    libc::mkdirat(current.as_raw_fd(), name.as_ptr(), mode as libc::mode_t)
                };
                if rc < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
                    return Err(io::Error::last_os_error());
                }
                open_at(
                    current.as_raw_fd(),
                    part,
                    libc::O_RDONLY | libc::O_DIRECTORY,
                    0,
                )?
            }
            Err(e) => return Err(e),
        };
        current = next;
    }
    Ok(current)
}
fn root(path: &str) -> io::Result<File> {
    let start = open_at(
        libc::AT_FDCWD,
        OsStr::new("/"),
        libc::O_RDONLY | libc::O_DIRECTORY,
        0,
    )?;
    directory(&start, &components(path)?, false, 0)
}
fn identity(file: &File) -> io::Result<String> {
    let stat = fstat(file)?;
    Ok(format!("{}:{}", stat.st_dev, stat.st_ino))
}
fn fstat(file: &File) -> io::Result<libc::stat> {
    let mut stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(file.as_raw_fd(), &mut stat) } < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(stat)
    }
}
fn lstat_at(dir: &File, name: &OsStr) -> io::Result<libc::stat> {
    let name = cstring(name)?;
    let mut stat = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            &mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } < 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(stat)
    }
}
fn confined<'a>(request: &'a Value, path: &'a str) -> io::Result<Vec<&'a OsStr>> {
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return Err(invalid("path must be absolute"));
    }
    for key in ["logicalRoot", "boundaryRoot"] {
        if let Some(base) = request[key].as_str() {
            if let Ok(relative) = candidate.strip_prefix(base) {
                let mut values = Vec::new();
                for part in relative.components() {
                    match part {
                        Component::Normal(name) => values.push(name),
                        Component::CurDir => {}
                        _ => return Err(error(libc::EPERM, "parent traversal denied")),
                    }
                }
                return Ok(values);
            }
        }
    }
    Err(error(libc::EPERM, "path outside pinned root"))
}
fn parent<'a>(
    root: &File,
    request: &'a Value,
    path: &'a str,
    create: bool,
    mode: u32,
) -> io::Result<(File, &'a OsStr)> {
    let parts = confined(request, path)?;
    let (name, parents) = parts
        .split_last()
        .ok_or_else(|| error(libc::EPERM, "refusing root mutation"))?;
    Ok((directory(root, parents, create, mode)?, name))
}
fn checked_file(
    root: &File,
    request: &Value,
    path: &str,
    flags: i32,
    mode: u32,
) -> io::Result<File> {
    let (dir, name) = parent(root, request, path, false, 0)?;
    let file = open_at(dir.as_raw_fd(), name, flags | libc::O_NONBLOCK, mode)?;
    let stat = fstat(&file)?;
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(error(libc::EPERM, "only regular files carry content"));
    }
    if stat.st_nlink > 1 {
        return Err(error(libc::EPERM, "hard-linked file denied"));
    }
    Ok(file)
}
fn fingerprint(stat: &libc::stat) -> [i128; 9] {
    [
        stat.st_dev as i128,
        stat.st_ino as i128,
        stat.st_mode as i128,
        stat.st_nlink as i128,
        stat.st_size as i128,
        stat.st_mtime as i128,
        stat.st_mtime_nsec as i128,
        stat.st_ctime as i128,
        stat.st_ctime_nsec as i128,
    ]
}
fn digest_with_hook(
    root: &File,
    request: &Value,
    content_limit: usize,
    after_read: impl FnOnce(),
) -> io::Result<Value> {
    let path = field(request, "path")?;
    let mut file = checked_file(root, request, path, libc::O_RDONLY, 0)?;
    let before = fstat(&file)?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(content_limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > content_limit {
        return Err(error(libc::EFBIG, "file exceeds content limit"));
    }
    after_read();
    let after = fstat(&file)?;
    let entry = parent(root, request, path, false, 0)
        .and_then(|(dir, name)| lstat_at(&dir, name))
        .map_err(|_| error(libc::EBUSY, "entry changed during measurement"))?;
    if fingerprint(&before) != fingerprint(&after) || fingerprint(&before) != fingerprint(&entry) {
        return Err(error(libc::EBUSY, "entry changed during measurement"));
    }
    let mut digest = Sha256::new();
    digest.update(&bytes);
    let mut value = json!({"digest":format!("{:x}", digest.finalize()), "sizeBytes":bytes.len()});
    if request["content"] == true {
        value["base64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
    }
    Ok(value)
}
fn birthtime_at(dir: &File, name: &OsStr, stat: &libc::stat) -> io::Result<Option<f64>> {
    #[cfg(target_os = "linux")]
    {
        use rustix::fs::{statx, AtFlags, StatxFlags};
        // Keep lookup relative to the pinned directory and never follow a link.
        // rustix supplies the Linux syscall on both glibc and musl; libc's
        // statx bindings are not available on every supported libc.
        let extended = match statx(
            dir,
            name,
            AtFlags::SYMLINK_NOFOLLOW | AtFlags::NO_AUTOMOUNT,
            StatxFlags::INO | StatxFlags::BTIME,
        ) {
            Ok(value) => value,
            Err(failure) => {
                let failure = io::Error::from(failure);
                return match failure.raw_os_error() {
                    Some(libc::ENOSYS | libc::EOPNOTSUPP | libc::EINVAL) => Ok(None),
                    _ => Err(failure),
                };
            }
        };
        if extended.stx_mask & StatxFlags::BTIME.bits() == 0 {
            return Ok(None);
        }
        if extended.stx_mask & StatxFlags::INO.bits() == 0
            || extended.stx_ino != stat.st_ino
            || libc::makedev(extended.stx_dev_major, extended.stx_dev_minor) != stat.st_dev
        {
            return Err(error(libc::EBUSY, "entry changed during stat"));
        }
        Ok(Some(
            extended.stx_btime.tv_sec as f64 * 1000.0
                + extended.stx_btime.tv_nsec as f64 / 1_000_000.0,
        ))
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (dir, name);
        Ok(Some(
            stat.st_birthtime as f64 * 1000.0 + stat.st_birthtime_nsec as f64 / 1_000_000.0,
        ))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (dir, name, stat);
        Ok(None)
    }
}
fn stat_json(stat: libc::stat, birthtime: Option<f64>) -> Value {
    let kind = match stat.st_mode & libc::S_IFMT {
        libc::S_IFREG => "File",
        libc::S_IFDIR => "Directory",
        libc::S_IFLNK => "SymbolicLink",
        libc::S_IFIFO => "FIFO",
        libc::S_IFSOCK => "Socket",
        libc::S_IFBLK => "BlockDevice",
        libc::S_IFCHR => "CharacterDevice",
        _ => "Unknown",
    };
    #[cfg(target_os = "macos")]
    let (mtime_ns, atime_ns) = (stat.st_mtime_nsec, stat.st_atime_nsec);
    #[cfg(not(target_os = "macos"))]
    let (mtime_ns, atime_ns) = (stat.st_mtime_nsec, stat.st_atime_nsec);
    json!({ "type":kind, "mtime":stat.st_mtime as f64 * 1000.0 + mtime_ns as f64 / 1_000_000.0,
        "atime":stat.st_atime as f64 * 1000.0 + atime_ns as f64 / 1_000_000.0,
        "birthtime":birthtime, "dev":stat.st_dev, "ino":stat.st_ino, "mode":stat.st_mode,
        "nlink":stat.st_nlink, "uid":stat.st_uid, "gid":stat.st_gid, "rdev":stat.st_rdev,
        "size":stat.st_size.to_string(), "blksize":stat.st_blksize.to_string(), "blocks":stat.st_blocks })
}
fn read_entries(dir: &File) -> io::Result<Vec<(String, libc::stat)>> {
    let fd = unsafe { libc::dup(dir.as_raw_fd()) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe { libc::close(fd) };
        return Err(io::Error::last_os_error());
    }
    let mut out = Vec::new();
    loop {
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        let name = OsStr::from_bytes(name.to_bytes());
        let stat = lstat_at(dir, name)?;
        out.push((name.to_string_lossy().into_owned(), stat));
        if out.len() > MAX_ENTRIES {
            unsafe { libc::closedir(stream) };
            return Err(error(libc::EFBIG, "directory listing too large"));
        }
    }
    unsafe { libc::closedir(stream) };
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}
fn listing(
    dir: &File,
    recursive: bool,
    prefix: &str,
    depth: usize,
    out: &mut Vec<String>,
) -> io::Result<()> {
    if depth > 512 {
        return Err(error(libc::EFBIG, "directory is too deep"));
    }
    for (name, stat) in read_entries(dir)? {
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        out.push(path.clone());
        if out.len() > MAX_ENTRIES {
            return Err(error(libc::EFBIG, "directory listing too large"));
        }
        if recursive && stat.st_mode & libc::S_IFMT == libc::S_IFDIR {
            let child = open_at(
                dir.as_raw_fd(),
                OsStr::new(&name),
                libc::O_RDONLY | libc::O_DIRECTORY,
                0,
            )?;
            listing(&child, true, &path, depth + 1, out)?;
        }
    }
    Ok(())
}
fn remove_at(dir: &File, name: &OsStr, recursive: bool, depth: usize) -> io::Result<()> {
    let stat = lstat_at(dir, name)?;
    if stat.st_mode & libc::S_IFMT == libc::S_IFLNK {
        return Err(error(libc::ELOOP, "symlink removal denied"));
    }
    let cname = cstring(name)?;
    if stat.st_mode & libc::S_IFMT == libc::S_IFDIR {
        if recursive {
            if depth > 512 {
                return Err(error(libc::EFBIG, "remove depth exceeded"));
            }
            let child = open_at(dir.as_raw_fd(), name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
            for (entry, _) in read_entries(&child)? {
                remove_at(&child, OsStr::new(&entry), true, depth + 1)?;
            }
        }
        if unsafe { libc::unlinkat(dir.as_raw_fd(), cname.as_ptr(), libc::AT_REMOVEDIR) } < 0 {
            return Err(io::Error::last_os_error());
        }
    } else if unsafe { libc::unlinkat(dir.as_raw_fd(), cname.as_ptr(), 0) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
struct GlobWalk<'a> {
    selected: &'a GlobRule,
    excluded: &'a [GlobRule],
    response_limit: usize,
    base: &'a str,
}

fn glob_walk(
    dir: &File,
    prefix: &str,
    rules: &GlobWalk<'_>,
    budget: &mut usize,
    depth: usize,
    result: &mut Vec<String>,
) -> io::Result<()> {
    if depth > 512 {
        return Err(error(libc::EFBIG, "glob depth exceeded"));
    }
    for (name, stat) in read_entries(dir)? {
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let is_directory = stat.st_mode & libc::S_IFMT == libc::S_IFDIR;
        *budget += relative.len() + 4;
        if *budget > rules.response_limit {
            return Err(error(libc::EFBIG, "glob listing exceeds response limit"));
        }
        if rules
            .excluded
            .iter()
            .any(|rule| rule.matches(&relative, is_directory))
        {
            continue;
        }
        if rules.selected.matches(&relative, is_directory) {
            result.push(format!("{}/{relative}", rules.base));
            if result.len() > MAX_ENTRIES {
                return Err(error(libc::EFBIG, "glob result too large"));
            }
        }
        if is_directory && rules.selected.below(&relative) {
            let child = open_at(
                dir.as_raw_fd(),
                OsStr::new(&name),
                libc::O_RDONLY | libc::O_DIRECTORY,
                0,
            )?;
            glob_walk(&child, &relative, rules, budget, depth + 1, result)?;
        }
    }
    Ok(())
}

fn run(request: &Value, content_limit: usize, response_limit: usize) -> io::Result<Value> {
    let operation = field(request, "operation")?;
    let boundary = field(request, "boundaryRoot")?;
    let root = root(boundary).map_err(|_| error(libc::EPERM, "atomic root unavailable"))?;
    if identity(&root)? != field(request, "rootIdentity")? {
        return Err(error(libc::EPERM, "root identity changed"));
    }
    let options = &request["options"];
    match operation {
        "exists" | "stat" | "realPath" => {
            let path = field(request, "path")?;
            let parts = confined(request, path)?;
            let (stat, birthtime) = if parts.is_empty() {
                let stat = fstat(&root)?;
                let birthtime = if operation == "stat" {
                    birthtime_at(&root, OsStr::new("."), &stat)?
                } else {
                    None
                };
                (stat, birthtime)
            } else {
                let entry = parent(&root, request, path, false, 0)
                    .and_then(|(dir, name)| lstat_at(&dir, name).map(|stat| (dir, name, stat)));
                let (dir, name, stat) = match entry {
                    Ok(entry) => entry,
                    Err(e) if operation == "exists" && e.raw_os_error() == Some(libc::ENOENT) => {
                        return Ok(json!(false))
                    }
                    Err(e) => return Err(e),
                };
                let birthtime = if operation == "stat" {
                    birthtime_at(&dir, name, &stat)?
                } else {
                    None
                };
                (stat, birthtime)
            };
            if stat.st_mode & libc::S_IFMT == libc::S_IFLNK {
                return Err(error(libc::ELOOP, "symlink denied"));
            }
            if operation == "exists" {
                return Ok(json!(true));
            }
            if stat.st_mode & libc::S_IFMT == libc::S_IFREG && stat.st_nlink > 1 {
                return Err(error(libc::EPERM, "hard-linked file denied"));
            }
            if operation == "stat" {
                return Ok(stat_json(stat, birthtime));
            }
            let relative = parts
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            Ok(json!(if relative.is_empty() {
                boundary.to_owned()
            } else {
                format!("{boundary}/{relative}")
            }))
        }
        "readFile" | "readFileString" => {
            if confined(request, field(request, "path")?)?.is_empty() {
                return Err(error(libc::EISDIR, "root is a directory"));
            }
            let file = checked_file(&root, request, field(request, "path")?, libc::O_RDONLY, 0)?;
            let mut bytes = Vec::new();
            file.take(content_limit as u64 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > content_limit {
                return Err(error(libc::EFBIG, "file exceeds content limit"));
            }
            Ok(json!({"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}))
        }
        "writeFile" | "writeFileString" => {
            if confined(request, field(request, "path")?)?.is_empty() {
                return Err(error(libc::EISDIR, "root is a directory"));
            }
            let flag = options["flag"].as_str().unwrap_or("w");
            let (flags, truncate) = match flag {
                "r" => (libc::O_RDONLY, false),
                "r+" => (libc::O_RDWR, false),
                "w" => (libc::O_WRONLY | libc::O_CREAT, true),
                "w+" => (libc::O_RDWR | libc::O_CREAT, true),
                "wx" => (libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, false),
                "wx+" => (libc::O_RDWR | libc::O_CREAT | libc::O_EXCL, false),
                "a" => (libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND, false),
                "a+" => (libc::O_RDWR | libc::O_CREAT | libc::O_APPEND, false),
                "ax" => (
                    libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_APPEND,
                    false,
                ),
                "ax+" => (
                    libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_APPEND,
                    false,
                ),
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
                return Err(error(libc::EFBIG, "payload exceeds content limit"));
            }
            let mode = options["mode"].as_u64().unwrap_or(0o666) as u32;
            let mut file = checked_file(&root, request, field(request, "path")?, flags, mode)?;
            if truncate && unsafe { libc::ftruncate(file.as_raw_fd(), 0) } < 0 {
                return Err(io::Error::last_os_error());
            }
            file.write_all(&bytes)?;
            file.sync_all()?;
            Ok(Value::Null)
        }
        "makeDirectory" => {
            let path = field(request, "path")?;
            let recursive = options["recursive"].as_bool().unwrap_or(false);
            let mode = options["mode"].as_u64().unwrap_or(0o777) as u32;
            let parts = confined(request, path)?;
            if parts.is_empty() {
                if recursive {
                    return Ok(Value::Null);
                } else {
                    return Err(error(libc::EEXIST, "root exists"));
                }
            }
            let (dir, name) = parent(&root, request, path, recursive, mode)?;
            let name = cstring(name)?;
            if unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), mode as libc::mode_t) } < 0 {
                let e = io::Error::last_os_error();
                if !recursive || e.raw_os_error() != Some(libc::EEXIST) {
                    return Err(e);
                }
                let existing = lstat_at(&dir, OsStr::from_bytes(name.as_bytes()))?;
                if existing.st_mode & libc::S_IFMT != libc::S_IFDIR {
                    return Err(error(
                        if existing.st_mode & libc::S_IFMT == libc::S_IFLNK {
                            libc::ELOOP
                        } else {
                            libc::EEXIST
                        },
                        "existing entry is not a directory",
                    ));
                }
            }
            Ok(Value::Null)
        }
        "readDirectory" => {
            let dir = directory(
                &root,
                &confined(request, field(request, "path")?)?,
                false,
                0,
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
            let (dir, name) = match parent(&root, request, field(request, "path")?, false, 0) {
                Ok(pair) => pair,
                Err(e) if force && e.raw_os_error() == Some(libc::ENOENT) => {
                    return Ok(Value::Null)
                }
                Err(e) => return Err(e),
            };
            match remove_at(
                &dir,
                name,
                options["recursive"].as_bool().unwrap_or(false),
                0,
            ) {
                Err(e) if force && e.raw_os_error() == Some(libc::ENOENT) => Ok(Value::Null),
                other => other.map(|_| Value::Null),
            }
        }
        "rename" => {
            let (from_dir, from) = parent(&root, request, field(request, "from")?, false, 0)?;
            let (to_dir, to) = parent(&root, request, field(request, "to")?, false, 0)?;
            for (dir, name) in [(&from_dir, from), (&to_dir, to)] {
                match lstat_at(dir, name) {
                    Ok(stat) if stat.st_mode & libc::S_IFMT == libc::S_IFLNK => {
                        return Err(error(libc::ELOOP, "symlink rename denied"))
                    }
                    Err(e) if e.raw_os_error() != Some(libc::ENOENT) => return Err(e),
                    _ => {}
                }
            }
            let from = cstring(from)?;
            let to = cstring(to)?;
            if unsafe {
                libc::renameat(
                    from_dir.as_raw_fd(),
                    from.as_ptr(),
                    to_dir.as_raw_fd(),
                    to.as_ptr(),
                )
            } < 0
            {
                return Err(io::Error::last_os_error());
            }
            from_dir.sync_all()?;
            to_dir.sync_all()?;
            Ok(Value::Null)
        }
        "chmod" | "chown" => {
            if operation == "chmod"
                && (options["mode"].as_i64().unwrap_or(-1) < 0
                    || options["mode"].as_u64().unwrap_or(u64::MAX) > 0o7777)
            {
                return Err(error(libc::EINVAL, "invalid mode"));
            }
            if operation == "chown"
                && (options["uid"].as_i64().unwrap_or(-2) < -1
                    || options["gid"].as_i64().unwrap_or(-2) < -1)
            {
                return Err(error(libc::EINVAL, "invalid owner"));
            }
            let file = checked_file(&root, request, field(request, "path")?, libc::O_RDONLY, 0)?;
            let rc = if operation == "chmod" {
                unsafe {
                    libc::fchmod(
                        file.as_raw_fd(),
                        options["mode"].as_u64().ok_or_else(|| invalid("mode"))? as libc::mode_t,
                    )
                }
            } else {
                unsafe {
                    libc::fchown(
                        file.as_raw_fd(),
                        options["uid"].as_i64().ok_or_else(|| invalid("uid"))? as libc::uid_t,
                        options["gid"].as_i64().ok_or_else(|| invalid("gid"))? as libc::gid_t,
                    )
                }
            };
            if rc < 0 {
                return Err(io::Error::last_os_error());
            }
            file.sync_all()?;
            Ok(Value::Null)
        }
        "readLink" => {
            if confined(request, field(request, "path")?)?.is_empty() {
                return Err(error(libc::EINVAL, "root is not a link"));
            }
            let (dir, name) = parent(&root, request, field(request, "path")?, false, 0)?;
            let name = cstring(name)?;
            let mut buffer = vec![0u8; 4096];
            let len = unsafe {
                libc::readlinkat(
                    dir.as_raw_fd(),
                    name.as_ptr(),
                    buffer.as_mut_ptr() as *mut libc::c_char,
                    buffer.len(),
                )
            };
            if len < 0 {
                return Err(io::Error::last_os_error());
            }
            buffer.truncate(len as usize);
            Ok(json!(String::from_utf8_lossy(&buffer)))
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
                sub["logicalRoot"] = request["logicalRoot"].clone();
                sub["boundaryRoot"] = request["boundaryRoot"].clone();
                sub["rootIdentity"] = request["rootIdentity"].clone();
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
                            rejection(&sub, &error(libc::EFBIG, "batch entry exceeds limit"))
                        } else {
                            success
                        }
                    }
                    Err(e) => rejection(&sub, &e),
                };
                if serde_json::to_vec(&result)?.len() > entry_limit {
                    return Err(error(libc::EFBIG, "batch failure exceeds entry limit"));
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
        "glob" => {
            let base = field(request, "root")?;
            let dir = directory(&root, &confined(request, base)?, false, 0)?;
            let selected = GlobRule::new(
                &relative_pattern(field(request, "pattern")?, base, false),
                true,
            )
            .map_err(|error| invalid(&error.to_string()))?;
            let excluded = options["exclude"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|value| GlobRule::new(&relative_pattern(value, base, true), false))
                        .collect::<io::Result<Vec<_>>>()
                })
                .transpose()
                .map_err(|error| invalid(&error.to_string()))?
                .unwrap_or_default();
            if excluded.iter().any(|rule| rule.includes_root()) {
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
                        response_limit,
                        base,
                    },
                    &mut budget,
                    0,
                    &mut result,
                )?;
            }
            Ok(json!(result))
        }
        _ => Err(error(libc::ENOTSUP, "unsupported atomic operation")),
    }
}
fn errno_name(code: i32) -> &'static str {
    match code {
        libc::EACCES => "EACCES",
        libc::EBUSY => "EBUSY",
        libc::EEXIST => "EEXIST",
        libc::EFBIG => "EFBIG",
        libc::EISDIR => "EISDIR",
        libc::ELOOP => "ELOOP",
        libc::ENOENT => "ENOENT",
        libc::ENOTDIR => "ENOTDIR",
        libc::ENXIO => "ENXIO",
        libc::EPERM => "EPERM",
        libc::EINVAL => "EINVAL",
        _ => "EIO",
    }
}
fn rejection(request: &Value, error: &io::Error) -> Value {
    let operation = request["operation"].as_str().unwrap_or("");
    let code = error.raw_os_error().unwrap_or(libc::EIO);
    let flag = request["options"]["flag"].as_str().unwrap_or("w");
    let bad_argument = code == libc::EINVAL
        && (operation == "glob"
            || ((operation == "writeFile" || operation == "writeFileString")
                && !["r", "r+", "w", "w+", "wx", "wx+", "a", "a+", "ax", "ax+"].contains(&flag)));
    let message = if operation == "glob"
        && code == libc::EINVAL
        && (request["pattern"]
            .as_str()
            .unwrap_or("")
            .matches("{,a}")
            .count()
            > 64
            || request["options"]["exclude"]
                .as_array()
                .is_some_and(|list| {
                    list.iter()
                        .any(|value| value.as_str().unwrap_or("").matches("{,a}").count() > 64)
                })) {
        "glob pattern expands past 64 alternatives".to_owned()
    } else {
        error.to_string()
    };
    json!({"ok":false,"code":errno_name(code),"syscall":syscall(operation),"badArgument":bad_argument,"message":message})
}
pub fn serve() -> io::Result<()> {
    atomic_protocol::serve(run, rejection, invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use tempfile::tempdir;

    fn request(root: &Path, operation: &str, path: &Path) -> Value {
        let pinned = super::root(root.to_str().unwrap()).unwrap();
        json!({"operation":operation,"boundaryRoot":root,"logicalRoot":root,
            "rootIdentity":identity(&pinned).unwrap(),"path":path})
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn birthtime_preserves_identity_checks_across_libcs() {
        let temp = tempdir().unwrap();
        let file = temp.path().join("created.txt");
        fs::write(&file, "original").unwrap();
        let dir = super::root(temp.path().to_str().unwrap()).unwrap();
        let opened = File::open(&file).unwrap();
        let original = fstat(&opened).unwrap();
        let observed = birthtime_at(&dir, OsStr::new("created.txt"), &original).unwrap();
        if let Some(birthtime) = observed {
            assert!(birthtime > 0.0);
            if let Ok(created) = opened.metadata().unwrap().created() {
                let expected = created
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs_f64()
                    * 1000.0;
                assert!((birthtime - expected).abs() < 0.001);
            }
            fs::rename(&file, temp.path().join("original.txt")).unwrap();
            fs::write(&file, "replacement").unwrap();
            assert_eq!(
                birthtime_at(&dir, OsStr::new("created.txt"), &original)
                    .unwrap_err()
                    .raw_os_error(),
                Some(libc::EBUSY)
            );
        }
    }

    #[test]
    fn exact_root_glob_ignores_trailing_separators_on_either_side() {
        let dir = tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("file.txt"), "").unwrap();
        let bare = root.to_str().unwrap().to_owned();
        let slashed = format!("{bare}/");
        for (pattern, base) in [
            (&bare, &bare),
            (&bare, &slashed),
            (&slashed, &bare),
            (&slashed, &slashed),
        ] {
            let mut glob = request(&root, "glob", &root);
            glob["root"] = json!(base);
            glob["pattern"] = json!(pattern);
            assert_eq!(
                run(&glob, 1024, 1024).unwrap(),
                json!([base]),
                "pattern {pattern:?} under root {base:?}"
            );
        }
    }

    #[test]
    fn writes_reads_and_renames_through_pinned_directories() {
        let dir = tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let sub = root.join("sub");
        let mut mkdir = request(&root, "makeDirectory", &sub);
        mkdir["options"] = json!({"recursive":true});
        assert_eq!(run(&mkdir, 1024, 1024).unwrap(), Value::Null);
        let file = sub.join("file.txt");
        let mut write = request(&root, "writeFileString", &file);
        write["data"] = json!("from Rust\n");
        run(&write, 1024, 1024).unwrap();
        let read = request(&root, "readFile", &file);
        let encoded = run(&read, 1024, 1024).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(encoded["base64"].as_str().unwrap())
                .unwrap(),
            b"from Rust\n"
        );
        let renamed = sub.join("renamed.txt");
        let mut rename = request(&root, "rename", &file);
        rename["from"] = json!(file);
        rename["to"] = json!(renamed);
        run(&rename, 1024, 1024).unwrap();
        assert_eq!(fs::read_to_string(renamed).unwrap(), "from Rust\n");
    }

    #[test]
    fn refuses_symlink_hardlink_and_replaced_root() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let parent = fs::canonicalize(dir.path()).unwrap();
        let root = parent.join("workspace");
        fs::create_dir(&root).unwrap();
        fs::write(outside.path().join("secret"), "outside").unwrap();
        symlink(outside.path(), root.join("escape")).unwrap();
        let escaped = request(&root, "readFile", &root.join("escape/secret"));
        assert!(run(&escaped, 1024, 1024).is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join("secret")).unwrap(),
            "outside"
        );
        fs::write(root.join("file"), "one").unwrap();
        fs::hard_link(root.join("file"), root.join("hard")).unwrap();
        assert_eq!(
            run(&request(&root, "readFile", &root.join("file")), 1024, 1024)
                .unwrap_err()
                .raw_os_error(),
            Some(libc::EPERM)
        );
        let original = request(&root, "readFile", &root.join("file"));
        fs::rename(&root, parent.join("parked")).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(root.join("file"), "replacement").unwrap();
        assert_eq!(
            run(&original, 1024, 1024).unwrap_err().raw_os_error(),
            Some(libc::EPERM)
        );
    }

    #[test]
    fn bounds_content_before_overwriting_a_file() {
        let dir = tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let path = root.join("file");
        fs::write(&path, "original").unwrap();
        let mut write = request(&root, "writeFileString", &path);
        write["data"] = json!("too much content");
        assert_eq!(
            run(&write, 4, 1024).unwrap_err().raw_os_error(),
            Some(libc::EFBIG)
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "original");
    }

    #[test]
    fn rejects_digest_when_the_measured_entry_changes() {
        for mutation in ["rewrite", "rename", "remove", "ancestor rename"] {
            let dir = tempdir().unwrap();
            let root = fs::canonicalize(dir.path()).unwrap();
            let parent = root.join("dir");
            fs::create_dir(&parent).unwrap();
            let target = parent.join("a");
            fs::write(&target, "before").unwrap();
            let request = request(&root, "digest", &target);
            let pinned = super::root(root.to_str().unwrap()).unwrap();
            let result = digest_with_hook(&pinned, &request, 1024, || match mutation {
                "rewrite" => fs::write(&target, "AFTER!").unwrap(),
                "rename" => {
                    fs::rename(&target, root.join("moved")).unwrap();
                    fs::write(&target, "before").unwrap();
                }
                "remove" => fs::remove_file(&target).unwrap(),
                "ancestor rename" => fs::rename(&parent, root.join("moved")).unwrap(),
                _ => unreachable!(),
            });
            assert_eq!(
                result.unwrap_err().raw_os_error(),
                Some(libc::EBUSY),
                "{mutation}"
            );
        }
    }

    #[test]
    fn removes_wide_and_deep_trees_but_bounds_depth() {
        fn chain(base: &Path, depth: usize) -> Vec<File> {
            fs::create_dir(base).unwrap();
            let mut dirs = vec![super::root(base.to_str().unwrap()).unwrap()];
            for _ in 0..depth {
                let name = CString::new("d").unwrap();
                assert_eq!(
                    unsafe {
                        libc::mkdirat(dirs.last().unwrap().as_raw_fd(), name.as_ptr(), 0o700)
                    },
                    0
                );
                dirs.push(
                    open_at(
                        dirs.last().unwrap().as_raw_fd(),
                        OsStr::new("d"),
                        libc::O_RDONLY | libc::O_DIRECTORY,
                        0,
                    )
                    .unwrap(),
                );
            }
            let mut leaf = open_at(
                dirs.last().unwrap().as_raw_fd(),
                OsStr::new("leaf"),
                libc::O_WRONLY | libc::O_CREAT,
                0o600,
            )
            .unwrap();
            leaf.write_all(b"leaf").unwrap();
            dirs
        }
        let dir = tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let wide = root.join("wide");
        fs::create_dir(&wide).unwrap();
        for index in 0..2000 {
            fs::write(wide.join(format!("entry-{index}")), "").unwrap();
        }
        let mut remove = request(&root, "remove", &wide);
        remove["options"] = json!({"recursive":true});
        run(&remove, 1024, 1024).unwrap();
        assert!(!wide.exists());
        let deep = root.join("deep");
        let handles = chain(&deep, 400);
        let mut remove = request(&root, "remove", &deep);
        remove["options"] = json!({"recursive":true});
        run(&remove, 1024, 1024).unwrap();
        assert!(!deep.exists());
        drop(handles);
        let beyond = root.join("beyond");
        let handles = chain(&beyond, 600);
        let mut remove = request(&root, "remove", &beyond);
        remove["options"] = json!({"recursive":true});
        assert_eq!(
            run(&remove, 1024, 1024).unwrap_err().raw_os_error(),
            Some(libc::EFBIG)
        );
        assert!(beyond.exists());
        let leaf = CString::new("leaf").unwrap();
        assert_eq!(
            unsafe { libc::unlinkat(handles.last().unwrap().as_raw_fd(), leaf.as_ptr(), 0) },
            0
        );
        let name = CString::new("d").unwrap();
        for index in (1..handles.len()).rev() {
            assert_eq!(
                unsafe {
                    libc::unlinkat(
                        handles[index - 1].as_raw_fd(),
                        name.as_ptr(),
                        libc::AT_REMOVEDIR,
                    )
                },
                0
            );
        }
        drop(handles);
        fs::remove_dir(beyond).unwrap();
    }
}
