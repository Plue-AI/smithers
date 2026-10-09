//! The daemon's last words. The broker hands the daemon this file as stderr
//! and appends one record per daemon exit, so a daemon that exits leaves its
//! error and exit status in its state directory (#3385).
//!
//! The daemon owns that directory. Root opens the leaf beneath a verified
//! directory without following links and accepts only a single-link regular
//! file, so the daemon cannot redirect root's writes.
use rustix::fs::{Mode, OFlags, ResolveFlags};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    os::unix::{fs::MetadataExt, process::ExitStatusExt},
    process::ExitStatus,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const NAME: &str = "daemon.log";
/// Opening a larger log keeps its newest `LIMIT / 2` bytes.
pub const LIMIT: u64 = 256 * 1024;

pub struct DaemonLog(File);

impl DaemonLog {
    /// `/var/lib/smithers-machined/daemon.log`, created root-owned 0600.
    pub fn open() -> io::Result<Self> {
        let root = File::open("/")?;
        let directory = File::from(rustix::fs::openat2(
            &root,
            "var/lib/smithers-machined",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
        )?);
        Self::open_in(&directory, &[0, 19998])
    }
    /// The leaf in `directory`, which must be owned by one of `owners`.
    pub fn open_in(directory: &File, owners: &[u32]) -> io::Result<Self> {
        let refused = || io::Error::new(io::ErrorKind::PermissionDenied, "untrusted daemon log");
        if !owners.contains(&directory.metadata()?.uid()) {
            return Err(refused());
        }
        let file = File::from(rustix::fs::openat2(
            directory,
            NAME,
            OFlags::RDWR
                | OFlags::APPEND
                | OFlags::CREATE
                | OFlags::CLOEXEC
                | OFlags::NOFOLLOW
                | OFlags::NONBLOCK,
            Mode::from_raw_mode(0o600),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
        )?);
        let meta = file.metadata()?;
        if !meta.is_file() || meta.nlink() != 1 || !owners.contains(&meta.uid()) {
            return Err(refused());
        }
        let mut log = Self(file);
        if meta.len() > LIMIT {
            log.keep_tail(LIMIT / 2)?;
        }
        Ok(log)
    }
    fn keep_tail(&mut self, keep: u64) -> io::Result<()> {
        let length = self.0.metadata()?.len();
        let mut tail = Vec::with_capacity(keep as usize);
        self.0.seek(SeekFrom::Start(length.saturating_sub(keep)))?;
        (&self.0).take(keep).read_to_end(&mut tail)?;
        // Start the kept part at a record boundary.
        let start = tail.iter().position(|b| *b == b'\n').map_or(0, |i| i + 1);
        self.0.set_len(0)?;
        self.0.write_all(&tail[start..])
    }
    /// A descriptor for the daemon's stderr.
    pub fn stderr(&self) -> io::Result<File> {
        self.0.try_clone()
    }
    /// Append one JSON record. A failed write never stops the supervisor.
    pub fn record(&self, record: &serde_json::Value) {
        let _ = writeln!(&self.0, "{record}");
    }
}

/// The broker's record of one daemon exit.
pub fn exit_record(
    status: &ExitStatus,
    uptime: Duration,
    killed: Option<&io::Error>,
) -> serde_json::Value {
    serde_json::json!({
        "event": "daemon_exit",
        "at_ms": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        "uptime_ms": uptime.as_millis() as u64,
        "code": status.code(),
        "signal": status.signal(),
        "core_dumped": status.core_dumped(),
        // The broker kills the daemon when its control channel fails.
        "killed_by_broker": killed.map(|error| error.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn uid() -> u32 {
        rustix::process::geteuid().as_raw()
    }
    fn dir() -> (tempfile::TempDir, File) {
        let dir = tempfile::tempdir().unwrap();
        let handle = File::open(dir.path()).unwrap();
        (dir, handle)
    }
    #[test]
    fn records_stderr_and_exits_in_a_private_file() {
        let (dir, handle) = dir();
        let log = DaemonLog::open_in(&handle, &[uid()]).unwrap();
        let mut stderr = log.stderr().unwrap();
        writeln!(stderr, "smithers-machined: sessions not ready").unwrap();
        let status = ExitStatus::from_raw(1 << 8);
        log.record(&exit_record(&status, Duration::from_millis(1500), None));
        let killed = io::Error::other("control channel closed");
        log.record(&exit_record(
            &ExitStatus::from_raw(9),
            Duration::ZERO,
            Some(&killed),
        ));
        let path = dir.path().join(NAME);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines[0], "smithers-machined: sessions not ready");
        let exited: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(exited["event"], "daemon_exit");
        assert_eq!(
            (exited["code"].as_i64(), exited["uptime_ms"].as_u64()),
            (Some(1), Some(1500))
        );
        assert!(exited["signal"].is_null() && exited["killed_by_broker"].is_null());
        let killed: serde_json::Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(
            (killed["signal"].as_i64(), killed["code"].as_i64()),
            (Some(9), None)
        );
        assert_eq!(killed["killed_by_broker"], "control channel closed");
        // Reopening appends.
        DaemonLog::open_in(&handle, &[uid()])
            .unwrap()
            .record(&serde_json::json!({"n": 3}));
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 4);
    }
    #[test]
    fn a_full_log_keeps_its_newest_whole_records() {
        let (dir, handle) = dir();
        let path = dir.path().join(NAME);
        let line = format!("{}\n", "x".repeat(99));
        let mut body = String::new();
        let mut n = 0;
        while body.len() as u64 <= LIMIT {
            body.push_str(&format!("{n:06} {line}"));
            n += 1;
        }
        std::fs::write(&path, &body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let log = DaemonLog::open_in(&handle, &[uid()]).unwrap();
        log.record(&serde_json::json!({"event": "after"}));
        let kept = std::fs::read_to_string(&path).unwrap();
        assert!(kept.len() as u64 <= LIMIT / 2 + 100, "{}", kept.len());
        assert!(kept.lines().all(|l| l.len() == 106 || l.contains("after")));
        assert!(kept.contains(&format!("{:06} ", n - 1)));
        assert!(kept.ends_with("{\"event\":\"after\"}\n"));
    }
    #[test]
    fn refuses_links_special_files_and_foreign_owners() {
        let (dir, handle) = dir();
        let target = dir.path().join("elsewhere");
        std::fs::write(&target, "root's file\n").unwrap();
        symlink(&target, dir.path().join(NAME)).unwrap();
        assert!(DaemonLog::open_in(&handle, &[uid()]).is_err());
        std::fs::remove_file(dir.path().join(NAME)).unwrap();
        std::fs::hard_link(&target, dir.path().join(NAME)).unwrap();
        assert!(DaemonLog::open_in(&handle, &[uid()]).is_err());
        std::fs::remove_file(dir.path().join(NAME)).unwrap();
        rustix::fs::mknodat(
            &handle,
            NAME,
            rustix::fs::FileType::Fifo,
            Mode::from_raw_mode(0o600),
            0,
        )
        .unwrap();
        assert!(DaemonLog::open_in(&handle, &[uid()]).is_err());
        std::fs::remove_file(dir.path().join(NAME)).unwrap();
        assert!(DaemonLog::open_in(&handle, &[uid() + 1]).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "root's file\n");
    }
}
