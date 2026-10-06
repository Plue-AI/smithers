//! File RPCs share the FIFO and document/watcher hooks. All working-copy IO is
//! descriptor-relative and unprivileged; the displaced inode is checked after
//! the exchange, not just before it.
use crate::{
    confine, conn,
    hooks::{Actor, Base, Core, Digest, Error, Oid, Result, WriteRecord},
    lock::LockCx,
};
use rustix::fs::{self, AtFlags, Mode, OFlags, RenameFlags};
use sha2::{Digest as _, Sha256};
use std::{
    fs::File,
    io::{self, Write},
    os::unix::fs::MetadataExt,
    sync::Arc,
};

pub struct Contents {
    pub bytes: Vec<u8>,
    pub digest: Digest,
    pub mode: u32,
}
/// The shared repository provider owns blob creation and reads of captured trees.
/// It is required: successful writes cannot silently skip version recording.
pub trait Versions: Send + Sync {
    fn blob(&self, bytes: &[u8]) -> Result<Oid>;
    fn read_at(&self, path: &str, at: Oid) -> Result<Contents>;
}
pub struct Files {
    workspace: File,
    versions: Arc<dyn Versions>,
}
fn error(code: u8) -> Error {
    Error {
        code,
        ..Error::unsupported()
    }
}
fn malformed(e: conn::ProtocolError) -> Error {
    Error {
        code: 1,
        protocol: Some(e),
        ..Error::unsupported()
    }
}
fn io_error(e: io::Error) -> Error {
    error(match e.raw_os_error() {
        Some(40 | 18 | 20) => 6, // ELOOP / EXDEV: kernel confinement refusal
        Some(6 | 19 | 21) => 7,  // socket/device/directory
        _ if e.kind() == io::ErrorKind::NotFound => 5,
        _ if e.kind() == io::ErrorKind::InvalidInput => 6,
        _ => 12,
    })
}
fn too_large() -> Error {
    Error {
        code: 8,
        limit: Some(conn::MAX_FILE_BYTES as u32),
        ..Error::unsupported()
    }
}
fn stale(digest: Option<Digest>) -> Error {
    Error {
        code: 4,
        current_digest: digest,
        ..Error::unsupported()
    }
}
fn contents(file: &mut File) -> Result<Contents> {
    let stat = file.metadata().map_err(io_error)?;
    if !stat.is_file() {
        return Err(error(7));
    }
    if stat.len() > conn::MAX_FILE_BYTES as u64 {
        return Err(too_large());
    }
    let bytes = confine::read(file, conn::MAX_FILE_BYTES).map_err(io_error)?;
    if bytes.len() > conn::MAX_FILE_BYTES {
        return Err(too_large());
    }
    Ok(Contents {
        digest: Sha256::digest(&bytes).into(),
        bytes,
        mode: stat.mode() & 0o7777,
    })
}
fn open_current(parent: &File, name: &str) -> Result<Option<(File, Contents)>> {
    match confine::open(parent, name, OFlags::RDONLY, Mode::empty()) {
        Ok(mut file) => {
            let value = contents(&mut file)?;
            Ok(Some((file, value)))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_error(e)),
    }
}
/// Only an unswapped temporary is eligible for automatic cleanup. Once exchanged,
/// any failure leaves bytes reachable for recovery instead of deleting an outside
/// writer's inode (including failures during rollback or directory fsync).
struct Temp<'a> {
    parent: &'a File,
    name: String,
    cleanup: bool,
}
impl Drop for Temp<'_> {
    fn drop(&mut self) {
        if self.cleanup {
            let _ = fs::unlinkat(self.parent, &self.name, AtFlags::empty());
        }
    }
}
impl Files {
    pub fn new(workspace: File, versions: Arc<dyn Versions>) -> Result<Self> {
        if rustix::process::getuid().as_raw() != 19998
            || rustix::process::geteuid().as_raw() != 19998
        {
            return Err(error(11));
        }
        if !workspace.metadata().map_err(io_error)?.is_dir() {
            return Err(error(6));
        }
        Ok(Self {
            workspace,
            versions,
        })
    }
    pub fn read(&self, path: &str, at: Option<Oid>) -> Result<Contents> {
        if !crate::doc::disk::valid_path(path) {
            return Err(error(6));
        }
        if let Some(at) = at {
            return self.versions.read_at(path, at);
        }
        let (parent, name) = confine::parent(&self.workspace, path).map_err(io_error)?;
        open_current(&parent, &name)?
            .map(|(_, c)| c)
            .ok_or_else(|| error(5))
    }
    pub fn write(
        &self,
        cx: &mut LockCx,
        path: &str,
        base: &Base,
        bytes: &[u8],
        actor: &Actor,
    ) -> Result<Digest> {
        if !crate::doc::disk::valid_path(path) {
            return Err(error(6));
        }
        if bytes.len() > conn::MAX_FILE_BYTES {
            return Err(too_large());
        }
        let hooks = cx.hooks.clone();
        if let Some(result) = hooks.documents.write_through(cx, path, base, bytes, actor) {
            return result;
        }
        // An unavailable producer refuses before the first filesystem mutation.
        hooks.watcher.before_write(cx, path, actor)?;
        let (parent, name) = confine::parent(&self.workspace, path).map_err(io_error)?;
        let current = open_current(&parent, &name)?;
        let digest = current.as_ref().map(|(_, c)| c.digest);
        match (base, digest) {
            (Base::Absent, None) => (),
            (Base::Digest(expected), Some(actual)) if *expected == actual => (),
            _ => return Err(stale(digest)),
        }
        let mode = current.as_ref().map_or(Ok(0o664), |(_, c)| {
            crate::doc::disk::saved_mode(c.mode).map_err(|_| Error::unsupported())
        })?;
        let before = current
            .as_ref()
            .map(|(_, c)| self.versions.blob(&c.bytes))
            .transpose()?;
        let after = self.versions.blob(bytes)?;
        let post_digest: Digest = Sha256::digest(bytes).into();
        let mut random = [0; 16];
        getrandom::fill(&mut random).map_err(|_| error(12))?;
        let mut temp = Temp {
            parent: &parent,
            name: format!(
                ".smithers-write-{}",
                random
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            ),
            cleanup: true,
        };
        let mut file = confine::open(
            &parent,
            &temp.name,
            OFlags::RDWR | OFlags::CREATE | OFlags::EXCL,
            Mode::from_raw_mode(0o600),
        )
        .map_err(io_error)?;
        file.write_all(bytes).map_err(io_error)?;
        let gid = current
            .as_ref()
            .map(|(f, _)| f.metadata())
            .unwrap_or_else(|| parent.metadata())
            .map_err(io_error)?
            .gid();
        fs::fchown(&file, None, Some(rustix::process::Gid::from_raw(gid)))
            .map_err(|e| io_error(e.into()))?;
        fs::fchmod(&file, Mode::from_raw_mode(mode)).map_err(|e| io_error(e.into()))?;
        file.sync_all().map_err(io_error)?;
        self.exchange(&parent, &name, &mut temp, base, (&file, post_digest))?;
        hooks.watcher.after_write(
            cx,
            &WriteRecord {
                path: path.into(),
                actor: actor.clone(),
                before,
                after,
                post_digest,
            },
        )?;
        Ok(post_digest)
    }
    fn exchange(
        &self,
        parent: &File,
        name: &str,
        temp: &mut Temp<'_>,
        base: &Base,
        proposal: (&File, Digest),
    ) -> Result<()> {
        let flags = if matches!(base, Base::Absent) {
            RenameFlags::NOREPLACE
        } else {
            RenameFlags::EXCHANGE
        };
        match fs::renameat_with(parent, &temp.name, parent, name, flags) {
            Ok(()) => (),
            Err(rustix::io::Errno::EXIST | rustix::io::Errno::NOENT) => {
                return Err(stale(open_current(parent, name)?.map(|(_, c)| c.digest)));
            }
            Err(e) => return Err(io_error(e.into())),
        }
        temp.cleanup = false;
        if let Base::Digest(expected) = base {
            let displaced = open_current(parent, &temp.name);
            let actual = displaced
                .as_ref()
                .ok()
                .and_then(|c| c.as_ref().map(|(_, c)| c.digest));
            if actual != Some(*expected) {
                // Restore the exact displaced inode, including a raced symlink
                // or special file, without ever following or writing through it.
                fs::renameat_with(parent, &temp.name, parent, name, RenameFlags::EXCHANGE)
                    .map_err(|e| io_error(e.into()))?;
                parent.sync_all().map_err(io_error)?;
                // Reclaim only our unchanged proposal. If another writer
                // replaced or edited it before rollback, keep that inode's
                // bytes reachable instead of erasing an acknowledged write.
                if let Ok(Some((candidate, value))) = open_current(parent, &temp.name) {
                    let staged = proposal.0.metadata().map_err(io_error)?;
                    let found = candidate.metadata().map_err(io_error)?;
                    if staged.dev() == found.dev()
                        && staged.ino() == found.ino()
                        && value.digest == proposal.1
                    {
                        fs::unlinkat(parent, &temp.name, AtFlags::empty())
                            .map_err(|e| io_error(e.into()))?;
                        parent.sync_all().map_err(io_error)?;
                    }
                }
                return Err(stale(actual));
            }
            parent.sync_all().map_err(io_error)?;
            fs::unlinkat(parent, &temp.name, AtFlags::empty()).map_err(|e| io_error(e.into()))?;
        }
        parent.sync_all().map_err(io_error)?;
        Ok(())
    }
}
/// Mounts the file methods on the one Core hook; the lifecycle provider retains
/// responsibility for status, capture, reconciliation and readiness admission.
pub struct FileCore {
    pub files: Files,
    pub lifecycle: Arc<dyn Core>,
}
impl Core for FileCore {
    fn call(&self, cx: &mut LockCx, method: u8, args: &[u8]) -> Result<Vec<u8>> {
        if matches!(method, 2 | 3) {
            self.lifecycle.admit_files()?;
        }
        match method {
            2 => {
                let fields = conn::fields("args2", args).map_err(malformed)?;
                let path = std::str::from_utf8(&fields[0].1[2..])
                    .map_err(|_| malformed(conn::ProtocolError::BadUtf8))?;
                let at = fields.get(1).map(|(_, value)| (*value).try_into().unwrap());
                let c = self.files.read(path, at)?;
                let mut body = (c.bytes.len() as u32).to_be_bytes().to_vec();
                body.extend(c.bytes);
                Ok(conn::structure_bytes(&[
                    conn::field(1, body),
                    conn::field(2, c.digest),
                    conn::field(3, c.mode.to_be_bytes()),
                ]))
            }
            3 => {
                let a = conn::write_args(args).map_err(malformed)?;
                let digest = self
                    .files
                    .write(cx, &a.path, &a.base, &a.content, &a.actor)?;
                Ok(conn::structure_bytes(&[conn::field(1, digest)]))
            }
            _ => self.lifecycle.call(cx, method, args),
        }
    }
}

impl Versions for crate::objects::GitObjects {
    fn blob(&self, bytes: &[u8]) -> Result<Oid> {
        let output = self
            .run_input(&["hash-object", "-w", "--stdin"], bytes)
            .map_err(io_error)?;
        parse_oid(&output)
    }
    fn read_at(&self, path: &str, at: Oid) -> Result<Contents> {
        if !crate::doc::disk::valid_path(path) {
            return Err(error(6));
        }
        let hex: String = at.iter().map(|b| format!("{b:02x}")).collect();
        self.run_input(&["cat-file", "-e", &format!("{hex}^{{commit}}")], &[])
            .map_err(|_| error(5))?;
        // Literal pathspec, not a rev:path expression or a caller option. A
        // symlink in a captured tree is refused just like a working-copy leaf.
        let listing = self
            .run_input(
                &["ls-tree", "-z", &hex, "--", &format!(":(literal){path}")],
                &[],
            )
            .map_err(io_error)?;
        if listing.is_empty() {
            return Err(error(5));
        }
        let line = listing.strip_suffix(&[0]).ok_or_else(|| error(12))?;
        let tab = line
            .iter()
            .position(|b| *b == b'\t')
            .ok_or_else(|| error(12))?;
        let (metadata, listed) = (&line[..tab], &line[tab + 1..]);
        if listed != path.as_bytes() {
            return Err(error(5));
        }
        let metadata = std::str::from_utf8(metadata).map_err(|_| error(12))?;
        let parts: Vec<_> = metadata.split(' ').collect();
        if parts.len() != 3 {
            return Err(error(12));
        }
        if parts[1] != "blob" || !matches!(parts[0], "100644" | "100755") {
            return Err(error(7));
        }
        parse_oid(parts[2].as_bytes())?;
        let size = self
            .run_input(&["cat-file", "-s", parts[2]], &[])
            .map_err(io_error)?;
        let size: usize = std::str::from_utf8(&size)
            .map_err(|_| error(12))?
            .trim()
            .parse()
            .map_err(|_| error(12))?;
        if size > conn::MAX_FILE_BYTES {
            return Err(too_large());
        }
        let bytes = self
            .run_input(&["cat-file", "blob", parts[2]], &[])
            .map_err(io_error)?;
        if bytes.len() > conn::MAX_FILE_BYTES {
            return Err(too_large());
        }
        Ok(Contents {
            digest: Sha256::digest(&bytes).into(),
            bytes,
            mode: if parts[0] == "100755" { 0o755 } else { 0o644 },
        })
    }
}
fn parse_oid(bytes: &[u8]) -> Result<Oid> {
    let text = std::str::from_utf8(bytes).map_err(|_| error(12))?.trim();
    if text.len() != 40
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(error(12));
    }
    let mut oid = [0; 20];
    for (i, byte) in oid.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).map_err(|_| error(12))?;
    }
    Ok(oid)
}
