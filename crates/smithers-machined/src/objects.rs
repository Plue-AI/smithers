//! Git object operations for the durable outbox. The executable and repository
//! descriptor are installed inputs, never RPC payloads or branch configuration.
use crate::outbox::Objects;
use std::{
    fs::File,
    io,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

extern "C" {
    fn geteuid() -> u32;
}

pub struct GitObjects {
    git: PathBuf,
    workspace: PathBuf,
}
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn oid(value: &str) -> io::Result<()> {
    if !matches!(value.len(), 40 | 64)
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("invalid object id"));
    }
    Ok(())
}
fn reference(id: [u8; 16]) -> String {
    let hex: String = id.iter().map(|b| format!("{b:02x}")).collect();
    format!("refs/smithers/pending/{hex}")
}
fn terminate(child: &mut Child) {
    // This group was created by our spawn; never signal an inherited group.
    if let Some(pid) = rustix::process::Pid::from_raw(child.id() as i32) {
        let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
    }
    let _ = child.kill();
}
fn wait(child: &mut Child, timeout: Duration) -> io::Result<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                terminate(child);
                let _ = child.wait();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "git command timeout",
                ));
            }
            Err(error) => {
                terminate(child);
                let _ = child.wait();
                return Err(error);
            }
        }
    }
}
impl GitObjects {
    pub fn new(git: &Path, workspace: &Path) -> io::Result<Self> {
        // Never let a root broker execute a repository command.
        if unsafe { geteuid() } == 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        if !git.is_absolute() || !workspace.is_absolute() {
            return Err(invalid("installed paths must be absolute"));
        }
        Ok(Self {
            git: git.into(),
            workspace: workspace.into(),
        })
    }
    fn command(&self) -> Command {
        let mut cmd = Command::new(&self.git);
        cmd.process_group(0);
        cmd.env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", "/nonexistent")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .current_dir(&self.workspace)
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.fsmonitor=false",
            ]);
        cmd
    }
    fn run(&self, args: &[&str]) -> io::Result<Vec<u8>> {
        use std::{
            fs::{self, OpenOptions},
            io::{Read, Seek, SeekFrom},
            os::unix::fs::OpenOptionsExt,
        };
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).map_err(|_| invalid("random source unavailable"))?;
        let hex: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let path = std::env::temp_dir().join(format!("machined-git-{hex}"));
        let mut output = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        // An unlinked descriptor cannot be replaced by a path writer. Spooling
        // avoids pipe backpressure and leaves no reader thread after a timeout.
        fs::remove_file(path)?;
        let mut child = self
            .command()
            .args(args)
            .stdin(Stdio::null())
            .stdout(output.try_clone()?)
            .stderr(Stdio::null())
            .spawn()?;
        let status = wait(&mut child, Duration::from_secs(60))?;
        if !status.success() {
            return Err(invalid("git object operation failed"));
        }
        output.seek(SeekFrom::Start(0))?;
        let mut bytes = vec![];
        output.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(invalid("git output too large"));
        }
        Ok(bytes)
    }
    /// The first boot may have no prerequisites. Missing-object receipts supply
    /// explicit host haves; only validated OIDs are passed to Git.
    pub fn bundle(&self, ids: &[[u8; 16]], destination: File) -> io::Result<()> {
        self.bundle_with_haves(ids, &[], destination)
    }
    pub fn bundle_with_haves(
        &self,
        ids: &[[u8; 16]],
        haves: &[String],
        destination: File,
    ) -> io::Result<()> {
        if ids.is_empty() {
            return Err(invalid("empty object batch"));
        }
        let refs: Vec<_> = ids.iter().map(|id| reference(*id)).collect();
        for have in haves {
            oid(have)?;
        }
        let mut command = self.command();
        command.args(["bundle", "create", "-"]).args(refs);
        if !haves.is_empty() {
            command.arg("--not").args(haves);
        }
        let mut child = command
            .stdin(Stdio::null())
            .stdout(destination)
            .stderr(Stdio::null())
            .spawn()?;
        let status = wait(&mut child, Duration::from_secs(60))?;
        if !status.success() {
            return Err(invalid("git bundle creation failed"));
        }
        Ok(())
    }
}
impl Objects for GitObjects {
    fn pin(&mut self, id: [u8; 16], object: &str) -> io::Result<()> {
        oid(object)?;
        // A zero old value makes collision fail instead of replacing a live pin.
        self.run(&[
            "update-ref",
            &reference(id),
            object,
            &"0".repeat(object.len()),
        ])?;
        Ok(())
    }
    fn sync(&mut self) -> io::Result<()> {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            extern "C" {
                fn syncfs(fd: i32) -> i32;
            }
            let directory = File::open(&self.workspace)?;
            if unsafe { syncfs(directory.as_raw_fd()) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "durable workspace sync requires Linux syncfs",
            ))
        }
        #[cfg(target_os = "linux")]
        Ok(())
    }
    fn pending(&mut self) -> io::Result<Vec<[u8; 16]>> {
        let bytes = self.run(&[
            "for-each-ref",
            "--format=%(refname)",
            "refs/smithers/pending/",
        ])?;
        let text = std::str::from_utf8(&bytes).map_err(|_| invalid("invalid pending ref"))?;
        text.lines()
            .map(|line| {
                let hex = line
                    .strip_prefix("refs/smithers/pending/")
                    .ok_or_else(|| invalid("invalid pending ref"))?;
                if hex.len() != 32
                    || !hex
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                {
                    return Err(invalid("invalid pending id"));
                }
                let mut id = [0; 16];
                for (i, byte) in id.iter_mut().enumerate() {
                    *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
                        .map_err(|_| invalid("invalid pending id"))?;
                }
                Ok(id)
            })
            .collect()
    }
    fn unpin(&mut self, id: [u8; 16]) -> io::Result<()> {
        self.run(&["update-ref", "-d", &reference(id)])?;
        Ok(())
    }
    fn ack_head(&mut self, head: &str) -> io::Result<()> {
        oid(head)?;
        self.run(&["update-ref", "refs/smithers/acked/head", head])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        conn::Frame,
        stream::{ObjectReceiver, ObjectSender},
    };
    use std::{
        fs,
        io::Read,
        sync::atomic::{AtomicU64, Ordering},
    };
    #[test]
    fn installed_command_timeout_kills_and_reaps_its_own_process() {
        let mut command = Command::new("/bin/sleep");
        command.arg("5").process_group(0);
        let mut child = command.spawn().unwrap();
        assert_eq!(
            wait(&mut child, Duration::from_millis(10))
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        assert!(child.try_wait().unwrap().is_some());
    }
    #[test]
    fn real_git_pin_bundle_credit_transfer_and_receipt_refs() {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let base = std::env::temp_dir().join(format!(
            "machined-git-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&base).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                fs::remove_dir_all(&self.0).unwrap();
            }
        }
        let _cleanup = Cleanup(base.clone());
        let git = Path::new("/usr/bin/git");
        let ws = base.join("workspace");
        let host = base.join("host.git");
        assert!(Command::new(git)
            .args(["init", "-q"])
            .arg(&ws)
            .status()
            .unwrap()
            .success());
        assert!(Command::new(git)
            .args(["init", "--bare", "-q"])
            .arg(&host)
            .status()
            .unwrap()
            .success());
        // Independent, poorly compressible bytes make the bundle exceed credit.
        let mut x = 717_u64;
        let bytes: Vec<u8> = (0..700_000)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x as u8
            })
            .collect();
        fs::write(ws.join("payload"), &bytes).unwrap();
        assert!(Command::new(git)
            .current_dir(&ws)
            .args(["add", "payload"])
            .status()
            .unwrap()
            .success());
        assert!(Command::new(git)
            .current_dir(&ws)
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-qm",
                "fixture"
            ])
            .status()
            .unwrap()
            .success());
        let head = String::from_utf8(
            Command::new(git)
                .current_dir(&ws)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_owned();
        let mut objects = GitObjects::new(git, &ws).unwrap();
        assert!(objects.pin([1; 16], "--evil").is_err());
        objects.pin([1; 16], &head).unwrap();
        assert!(objects.pin([1; 16], &head).is_err());
        assert_eq!(objects.pending().unwrap(), [[1; 16]]);
        let bundle = base.join("source.bundle");
        objects
            .bundle(&[[1; 16]], File::create(&bundle).unwrap())
            .unwrap();
        assert!(fs::metadata(&bundle).unwrap().len() > 262_144);
        let received = base.join("received.bundle");
        let mut destination = File::create(&received).unwrap();
        let mut source = File::open(&bundle).unwrap();
        let mut sender = ObjectSender::new(1).unwrap();
        let mut receiver = ObjectReceiver::new(1).unwrap();
        let mut first = true;
        loop {
            let frame = sender.next(&mut source).unwrap().unwrap();
            let decoded = Frame::decode(&frame.encode().unwrap()).unwrap();
            match receiver.receive(&decoded, &mut destination).unwrap() {
                Some(window) => {
                    let decoded = Frame::decode(&window.encode().unwrap()).unwrap();
                    sender.peer(&decoded).unwrap();
                    first = false;
                }
                None => break,
            }
        }
        assert!(!first);
        destination.sync_all().unwrap();
        assert!(Command::new(git)
            .current_dir(&host)
            .args(["bundle", "verify"])
            .arg(&received)
            .output()
            .unwrap()
            .status
            .success());
        assert!(Command::new(git)
            .current_dir(&host)
            .arg("fetch")
            .arg(&received)
            .arg(format!(
                "{}:refs/smithers/branches/fixture/head",
                reference([1; 16])
            ))
            .output()
            .unwrap()
            .status
            .success());
        let result = Command::new(git)
            .current_dir(&host)
            .args(["show", "refs/smithers/branches/fixture/head:payload"])
            .output()
            .unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout, bytes);
        sender.peer(&receiver.verified_close().unwrap()).unwrap();
        objects.ack_head(&head).unwrap();
        objects.unpin([1; 16]).unwrap();
        assert!(objects.pending().unwrap().is_empty());
        assert_eq!(
            objects
                .run(&["rev-parse", "refs/smithers/acked/head"])
                .unwrap(),
            format!("{head}\n").as_bytes()
        );
        // Cross-platform tests must not advertise Linux durability.
        #[cfg(not(target_os = "linux"))]
        assert_eq!(
            objects.sync().unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
        #[cfg(target_os = "linux")]
        objects.sync().unwrap();
        let mut check = Vec::new();
        File::open(received)
            .unwrap()
            .read_to_end(&mut check)
            .unwrap();
        assert_eq!(check, fs::read(bundle).unwrap());
    }
}
