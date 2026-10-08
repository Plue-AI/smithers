//! The broker's start of the owner's two transcript children (spec §9.6.6):
//! the one-shot resolver and the reader that tails. Each is this installed
//! executable, started again with a fixed argument on a private socketpair,
//! after a permanent drop to the session owner's groups, gid and uid.
//!
//! Nothing a branch or a member controls chooses what runs or how: the
//! executable is the broker's own path, the argument is one of two constants,
//! the environment is empty, the working directory is `/`, and the child's
//! only descriptors are its two ends of the socketpair. Home paths are data
//! the child receives after the drop.
use std::{
    fs::File,
    io::{self, Write},
    os::{
        fd::OwnedFd,
        unix::{net::UnixStream, process::CommandExt},
    },
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};

/// The session owner's account, as the broker's registry holds it. No request
/// supplies any of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub uid: u32,
    pub gid: u32,
    pub groups: Vec<u32>,
}

/// Which of the two owner-uid children to start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// Answers once which file is the transcript and which release wrote it.
    Resolve,
    /// Tails the resolved transcript until its socket closes.
    Read,
}
impl Role {
    fn argument(self) -> &'static str {
        match self {
            Self::Resolve => "transcript-resolve",
            Self::Read => "transcript-reader",
        }
    }
}

/// How long one exchange on a child's socket may take before the broker
/// gives the child up. A child cannot hold the broker by going quiet.
pub const EXCHANGE: Duration = Duration::from_secs(2);

/// Start `executable` as `owner` in `role`. The returned socket is the
/// broker's end, with both deadlines set to [`EXCHANGE`]. `cgroup`, the
/// session's own held `cgroup.procs`, puts the child where killing the session
/// kills it too, so a revoked member's reader stops with their processes.
///
/// The caller is root and reaps the child. A drop that does not take every id
/// fails the start: the child never runs with more than the owner has.
pub fn spawn(
    executable: &Path,
    role: Role,
    owner: &Owner,
    cgroup: Option<File>,
) -> io::Result<(Child, UnixStream)> {
    if owner.uid == 0
        || owner.gid == 0
        || owner.groups.len() > 64
        || owner.groups.contains(&0)
        || !executable.is_absolute()
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let (broker, child) = UnixStream::pair()?;
    broker.set_read_timeout(Some(EXCHANGE))?;
    broker.set_write_timeout(Some(EXCHANGE))?;
    let input: OwnedFd = child.try_clone()?.into();
    let output: OwnedFd = child.into();
    let mut command = Command::new(executable);
    command
        .arg(role.argument())
        .env_clear()
        .current_dir("/")
        .stdin(Stdio::from(input))
        .stdout(Stdio::from(output))
        .stderr(Stdio::null());
    let (uid, gid, groups) = (owner.uid, owner.gid, owner.groups.clone());
    let mut cgroup = cgroup;
    // SAFETY: only syscalls and one write to a held descriptor run between
    // fork and exec. The ids are dropped in the order that keeps each next
    // drop permitted, then checked, then pinned.
    unsafe {
        command.pre_exec(move || {
            if let Some(procs) = cgroup.as_mut() {
                let mut digits = [0u8; 20];
                let mut n = libc::getpid() as u32;
                let mut i = digits.len();
                loop {
                    i -= 1;
                    digits[i] = b'0' + (n % 10) as u8;
                    n /= 10;
                    if n == 0 {
                        break;
                    }
                }
                procs.write_all(&digits[i..])?;
            }
            if libc::setgroups(groups.len(), groups.as_ptr()) != 0
                || libc::setresgid(gid, gid, gid) != 0
                || libc::setresuid(uid, uid, uid) != 0
            {
                return Err(io::Error::last_os_error());
            }
            // A drop the kernel reported as done but did not do must not exec.
            let (mut real, mut effective, mut saved) = (0, 0, 0);
            if libc::getresuid(&mut real, &mut effective, &mut saved) != 0
                || [real, effective, saved] != [uid; 3]
                || libc::getresgid(&mut real, &mut effective, &mut saved) != 0
                || [real, effective, saved] != [gid; 3]
                || libc::setuid(0) == 0
            {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok((command.spawn()?, broker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_root_identities_and_relative_executables_before_forking() {
        let owner = |uid, gid, groups: &[u32]| Owner {
            uid,
            gid,
            groups: groups.to_vec(),
        };
        let binary = Path::new("/bin/true");
        for bad in [
            owner(0, 20001, &[20000]),
            owner(20001, 0, &[20000]),
            owner(20001, 20001, &[0]),
            owner(20001, 20001, &[1; 65]),
        ] {
            assert_eq!(
                spawn(binary, Role::Read, &bad, None).unwrap_err().kind(),
                io::ErrorKind::PermissionDenied
            );
        }
        assert_eq!(
            spawn(
                Path::new("bin/true"),
                Role::Resolve,
                &owner(20001, 20001, &[20000]),
                None
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::PermissionDenied
        );
    }
}
