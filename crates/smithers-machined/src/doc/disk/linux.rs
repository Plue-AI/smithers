//! No path-based or non-Linux filesystem fallback. The startup owner supplies
//! already opened workspace/store descriptors after the kernel probes pass.
use super::super::{
    state::{Digest, Record},
    Error, Result, MAX_STATE_BYTES, MAX_TEXT_BYTES,
};
use super::{valid_path, Disk, Displaced, Recovery};
use rustix::fs::{self, AtFlags, Mode, OFlags, RenameFlags, ResolveFlags};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, PermissionsExt},
};

const RESOLVE: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_MAGICLINKS)
    .union(ResolveFlags::NO_XDEV);

/// T-COL-04a's recorded-version adapter supplies this; no local blob substitute.
pub trait Versions: Send {
    fn outside(&mut self, path: &str, bytes: &[u8], actor: &str) -> Result<String>;
    fn own_write(&mut self, path: &str, digest: Digest);
}
struct Inode {
    parent: File,
    name: String,
    file: File,
}
pub struct LinuxDisk<V: Versions> {
    workspace: File,
    store: File,
    versions: V,
    inodes: BTreeMap<u64, Inode>,
    next: u64,
}
fn io(error: rustix::io::Errno) -> Error {
    std::io::Error::from(error).into()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn random() -> Result<String> {
    let mut bytes = [0u8; 16];
    let mut done = 0;
    while done < bytes.len() {
        match rustix::rand::getrandom(&mut bytes[done..], rustix::rand::GetRandomFlags::empty()) {
            Ok(0) => return Err(Error::Invalid),
            Ok(n) => done += n,
            Err(rustix::io::Errno::INTR) => continue,
            Err(error) => return Err(io(error)),
        }
    }
    Ok(hex(&bytes))
}
fn meta(temp: &str) -> String {
    format!("displaced-{}", temp.trim_start_matches(".smithers-doc-"))
}
fn regular(file: &File) -> Result<()> {
    if !file.metadata()?.is_file() {
        return Err(Error::Invalid);
    }
    Ok(())
}
fn read(file: &mut File, limit: usize) -> Result<Vec<u8>> {
    regular(file)?;
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = vec![];
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    Ok(bytes)
}
fn open(parent: &File, name: &str, flags: OFlags, mode: Mode) -> Result<File> {
    Ok(fs::openat2(
        parent,
        name,
        flags | OFlags::CLOEXEC | OFlags::NONBLOCK | OFlags::NOFOLLOW,
        mode,
        RESOLVE,
    )
    .map_err(io)?
    .into())
}
impl<V: Versions> LinuxDisk<V> {
    pub fn new(workspace: File, store: File, versions: V) -> Result<Self> {
        // A branch build is never usable by root, even if it is called directly.
        if rustix::process::geteuid().as_raw() != 19998
            || rustix::process::getuid().as_raw() != 19998
        {
            return Err(Error::Unsupported);
        }
        let metadata = store.metadata()?;
        if !workspace.metadata()?.is_dir()
            || !metadata.is_dir()
            || metadata.uid() != 19998
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(Error::Invalid);
        }
        Ok(Self {
            workspace,
            store,
            versions,
            inodes: BTreeMap::new(),
            next: 1,
        })
    }
    fn parent(&self, path: &str) -> Result<(File, String)> {
        if !valid_path(path) {
            return Err(Error::Invalid);
        }
        let (parent, name) = path.rsplit_once('/').unwrap_or((".", path));
        let dir = fs::openat2(
            &self.workspace,
            parent,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
            RESOLVE,
        )
        .map_err(io)?;
        Ok((dir.into(), name.into()))
    }
    fn keep(&mut self, parent: File, name: String, file: File) -> Result<Displaced> {
        regular(&file)?;
        let token = self.next;
        self.next = self.next.checked_add(1).ok_or(Error::Invalid)?;
        self.inodes.insert(token, Inode { parent, name, file });
        Ok(token)
    }
    fn load_named(&mut self, name: &str) -> Result<Option<Record>> {
        let mut file = match open(&self.store, name, OFlags::RDONLY, Mode::empty()) {
            Ok(file) => file,
            Err(_) => return Ok(None),
        };
        let bytes = match read(&mut file, 2 * MAX_TEXT_BYTES + MAX_STATE_BYTES + 132) {
            Ok(bytes) => bytes,
            Err(_) => return Ok(None),
        };
        Ok(Record::decode(&bytes).ok())
    }
    fn store_named(&mut self, name: &str, record: &Record) -> Result<()> {
        let bytes = record.encode()?;
        let temp = format!(".record-{name}-{}", random()?);
        let mut file = open(
            &self.store,
            &temp,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
            Mode::from_raw_mode(0o600),
        )?;
        let result: Result<()> = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::renameat(&self.store, &temp, &self.store, name).map_err(io)?;
            self.store.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::unlinkat(&self.store, &temp, AtFlags::empty());
        }
        result
    }
    fn remove_meta(&self, temp: &str) -> Result<()> {
        let name = meta(temp);
        match fs::unlinkat(&self.store, &name, AtFlags::empty()) {
            Ok(()) | Err(rustix::io::Errno::NOENT) => (),
            Err(error) => return Err(io(error)),
        }
        self.store.sync_all()?;
        Ok(())
    }
}
impl<V: Versions> Disk for LinuxDisk<V> {
    fn read(&mut self, path: &str) -> Result<Option<Vec<u8>>> {
        let (parent, name) = self.parent(path)?;
        match fs::openat2(
            &parent,
            &name,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
            RESOLVE,
        ) {
            Ok(fd) => {
                let mut file = File::from(fd);
                Ok(Some(read(&mut file, MAX_TEXT_BYTES)?))
            }
            Err(rustix::io::Errno::NOENT) => Ok(None),
            Err(error) => Err(io(error)),
        }
    }
    fn load_record(&mut self, key: Digest) -> Result<Option<Record>> {
        self.load_named(&hex(&key))
    }
    fn store_record(&mut self, key: Digest, record: &Record) -> Result<()> {
        self.store_named(&hex(&key), record)
    }
    fn swap_text(&mut self, path: &str, key: Digest, bytes: &[u8]) -> Result<Option<Displaced>> {
        if bytes.len() > MAX_TEXT_BYTES {
            return Err(Error::Invalid);
        }
        let (parent, name) = self.parent(path)?;
        let old = match fs::openat2(
            &parent,
            &name,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
            RESOLVE,
        ) {
            Ok(fd) => Some(File::from(fd)),
            Err(rustix::io::Errno::NOENT) => None,
            Err(error) => return Err(io(error)),
        };
        let mode = if let Some(old) = &old {
            regular(old)?;
            let metadata = old.metadata()?;
            // Transferring set-id bits to machined would grant its authority.
            if metadata.mode() & 0o6000 != 0 {
                return Err(Error::Unsupported);
            }
            metadata.mode() & 0o777
        } else {
            0o664
        };
        let temp = format!(".smithers-doc-{}-{}", hex(&key), random()?);
        // Persist the displaced inode's original merge base before the swap.
        // Later saves may replace the path record while this writer stays open.
        let record = self.load_record(key)?.ok_or(Error::Invalid)?;
        self.store_named(&meta(&temp), &record)?;
        let mut file = open(
            &parent,
            &temp,
            OFlags::RDWR | OFlags::CREATE | OFlags::EXCL,
            Mode::from_raw_mode(0o600),
        )?;
        let result: Result<()> = (|| {
            file.write_all(bytes)?;
            let gid = match &old {
                Some(old) => old.metadata()?.gid(),
                None => parent.metadata()?.gid(),
            };
            fs::fchown(&file, None, Some(rustix::process::Gid::from_raw(gid))).map_err(io)?;
            fs::fchmod(&file, Mode::from_raw_mode(mode)).map_err(io)?;
            file.sync_all()?;
            fs::renameat_with(
                &parent,
                &temp,
                &parent,
                &name,
                if old.is_some() {
                    RenameFlags::EXCHANGE
                } else {
                    RenameFlags::NOREPLACE
                },
            )
            .map_err(io)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::unlinkat(&parent, &temp, AtFlags::empty());
            self.remove_meta(&temp)?;
            result?;
        }
        if old.is_none() {
            parent.sync_all()?;
            self.remove_meta(&temp)?;
            return Ok(None);
        }
        let displaced = match open(&parent, &temp, OFlags::RDONLY, Mode::empty()).and_then(|f| {
            regular(&f)?;
            Ok(f)
        }) {
            Ok(file) => file,
            Err(error) => {
                // A symlink/nonregular target swapped in after the precheck.
                fs::renameat_with(&parent, &temp, &parent, &name, RenameFlags::EXCHANGE)
                    .map_err(io)?;
                parent.sync_all()?;
                fs::unlinkat(&parent, &temp, AtFlags::empty()).map_err(io)?;
                self.remove_meta(&temp)?;
                return Err(error);
            }
        };
        // Keep displaced bytes through any failed directory fsync or restart.
        let retained_parent = parent.try_clone()?;
        let token = self.keep(retained_parent, temp, displaced)?;
        parent.sync_all()?;
        Ok(Some(token))
    }
    fn recover_temps(&mut self, path: &str, key: Digest) -> Result<Vec<Recovery>> {
        let (parent, _) = self.parent(path)?;
        let prefix = format!(".smithers-doc-{}-", hex(&key));
        let mut directory = fs::Dir::read_from(&parent).map_err(io)?;
        let mut tokens = vec![];
        while let Some(entry) = directory.read() {
            let entry = entry.map_err(io)?;
            let Some(name) = entry
                .file_name()
                .to_str()
                .ok()
                .filter(|name| name.starts_with(&prefix))
            else {
                continue;
            };
            let file = open(&parent, name, OFlags::RDONLY, Mode::empty())?;
            let record = self.load_named(&meta(name))?.ok_or(Error::Invalid)?;
            let token = self.keep(parent.try_clone()?, name.into(), file)?;
            tokens.push(Recovery { token, record });
        }
        // Reclaim metadata left by an interrupted, unswapped temp creation or
        // deletion. Only this open path's digest can select entries to remove.
        let meta_prefix = format!("displaced-{}-", hex(&key));
        let mut records = fs::Dir::read_from(&self.store).map_err(io)?;
        while let Some(entry) = records.read() {
            let entry = entry.map_err(io)?;
            let Some(name) = entry
                .file_name()
                .to_str()
                .ok()
                .filter(|name| name.starts_with(&meta_prefix))
            else {
                continue;
            };
            let temp = format!(".smithers-doc-{}", name.trim_start_matches("displaced-"));
            match open(&parent, &temp, OFlags::RDONLY, Mode::empty()) {
                Ok(file) => regular(&file)?,
                Err(Error::Io(_)) => {
                    // Use a raw lookup to distinguish absence from confinement
                    // refusal; a symlink or permission failure is never absence.
                    match fs::openat2(
                        &parent,
                        &temp,
                        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                        Mode::empty(),
                        RESOLVE,
                    ) {
                        Err(rustix::io::Errno::NOENT) => self.remove_meta(&temp)?,
                        Err(error) => return Err(io(error)),
                        Ok(_) => (),
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Ok(tokens)
    }
    fn read_displaced(&mut self, token: u64) -> Result<Vec<u8>> {
        let inode = self.inodes.get_mut(&token).ok_or(Error::Invalid)?;
        read(&mut inode.file, MAX_TEXT_BYTES)
    }
    fn remove_displaced(&mut self, token: u64) -> Result<()> {
        let inode = self.inodes.get(&token).ok_or(Error::Invalid)?;
        match fs::unlinkat(&inode.parent, &inode.name, AtFlags::empty()) {
            Ok(()) | Err(rustix::io::Errno::NOENT) => (),
            Err(error) => return Err(io(error)),
        }
        inode.parent.sync_all()?;
        self.remove_meta(&inode.name)?;
        self.inodes.remove(&token);
        Ok(())
    }
    fn record_outside(&mut self, path: &str, text: &[u8], actor: &str) -> Result<String> {
        self.versions.outside(path, text, actor)
    }
    fn own_write(&mut self, path: &str, post_digest: Digest) {
        self.versions.own_write(path, post_digest);
    }
}
