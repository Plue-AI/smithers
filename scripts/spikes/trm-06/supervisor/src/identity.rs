//! Fixed prototype identities, never a member-selected uid or group list.
//! Ports the helper's drop_to pattern; no existing Rust session child provides it.
use std::io;

#[derive(Clone, Copy, Debug)]
pub enum User {
    Ben,
    Agent,
}
impl User {
    fn ids(self) -> (u32, u32) {
        match self {
            Self::Ben => (20001, 20001),
            Self::Agent => (19999, 19999),
        }
    }
}
trait Credentials {
    fn root(&self) -> bool;
    fn groups(&mut self, groups: &[u32]) -> io::Result<()>;
    fn gid(&mut self, gid: u32) -> io::Result<()>;
    fn uid(&mut self, uid: u32) -> io::Result<()>;
    fn verify(&self, uid: u32, gid: u32, groups: &[u32]) -> io::Result<()>;
    fn umask(&mut self);
}
fn drop_credentials(credentials: &mut impl Credentials, user: User) -> io::Result<()> {
    if !credentials.root() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "session child must start as root",
        ));
    }
    let (uid, gid) = user.ids();
    credentials.groups(&[20000])?;
    credentials.gid(gid)?;
    credentials.uid(uid)?;
    credentials.verify(uid, gid, &[20000])?;
    credentials.umask();
    Ok(())
}

/// Invoke only in a single-threaded session child, before decoding or applying
/// argv/env/cwd/SFTP bytes. On error the caller must exit without using payloads.
/// Dormant: neither main nor the launcher invokes this without accepted real
/// C-SPK-08/root-session-input-validation and installed-main provenance.
#[cfg(target_os = "linux")]
pub fn drop_child(user: User) -> io::Result<()> {
    drop_credentials(&mut Linux, user)
}
#[cfg(target_os = "linux")]
struct Linux;
#[cfg(target_os = "linux")]
fn syscall(result: i32) -> io::Result<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
#[cfg(target_os = "linux")]
impl Credentials for Linux {
    fn root(&self) -> bool {
        unsafe { libc::getuid() == 0 && libc::geteuid() == 0 }
    }
    fn groups(&mut self, groups: &[u32]) -> io::Result<()> {
        syscall(unsafe { libc::setgroups(groups.len(), groups.as_ptr()) })
    }
    fn gid(&mut self, gid: u32) -> io::Result<()> {
        syscall(unsafe { libc::setresgid(gid, gid, gid) })
    }
    fn uid(&mut self, uid: u32) -> io::Result<()> {
        syscall(unsafe { libc::setresuid(uid, uid, uid) })
    }
    fn verify(&self, uid: u32, gid: u32, groups: &[u32]) -> io::Result<()> {
        let (mut real_uid, mut effective_uid, mut saved_uid) = (0, 0, 0);
        let (mut real_gid, mut effective_gid, mut saved_gid) = (0, 0, 0);
        syscall(unsafe { libc::getresuid(&mut real_uid, &mut effective_uid, &mut saved_uid) })?;
        syscall(unsafe { libc::getresgid(&mut real_gid, &mut effective_gid, &mut saved_gid) })?;
        let mut actual_groups = [0; 2];
        let count = unsafe { libc::getgroups(2, actual_groups.as_mut_ptr()) };
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        if [real_uid, effective_uid, saved_uid] != [uid; 3]
            || [real_gid, effective_gid, saved_gid] != [gid; 3]
            || &actual_groups[..count as usize] != groups
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "session credentials did not drop",
            ));
        }
        Ok(())
    }
    fn umask(&mut self) {
        unsafe {
            libc::umask(0o002);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Probe {
        events: Vec<String>,
        failure: Option<&'static str>,
        root: bool,
    }
    impl Probe {
        fn step(&mut self, step: &str, value: String) -> io::Result<()> {
            self.events.push(value);
            if self.failure == Some(step) {
                Err(io::Error::other(step.to_string()))
            } else {
                Ok(())
            }
        }
    }
    impl Credentials for Probe {
        fn root(&self) -> bool {
            self.root
        }
        fn groups(&mut self, groups: &[u32]) -> io::Result<()> {
            self.step("groups", format!("groups {groups:?}"))
        }
        fn gid(&mut self, gid: u32) -> io::Result<()> {
            self.step("gid", format!("gid {gid}"))
        }
        fn uid(&mut self, uid: u32) -> io::Result<()> {
            self.step("uid", format!("uid {uid}"))
        }
        fn verify(&self, uid: u32, gid: u32, groups: &[u32]) -> io::Result<()> {
            assert_eq!(uid, gid);
            assert_eq!(groups, [20000]);
            assert!(uid == 20001 || uid == 19999);
            if self.failure == Some("verify") {
                Err(io::Error::other("verify"))
            } else {
                Ok(())
            }
        }
        fn umask(&mut self) {
            self.events.push("umask 002".into());
        }
    }
    #[test]
    fn fixed_ids_drop_groups_before_all_gids_before_all_uids() {
        for (user, expected) in [(User::Ben, 20001), (User::Agent, 19999)] {
            let mut probe = Probe {
                events: vec![],
                failure: None,
                root: true,
            };
            drop_credentials(&mut probe, user).unwrap();
            assert_eq!(
                probe.events,
                [
                    "groups [20000]".to_string(),
                    format!("gid {expected}"),
                    format!("uid {expected}"),
                    "umask 002".into()
                ]
            );
        }
    }
    #[test]
    fn every_failure_stops_before_payload_permission() {
        for (failure, expected_count) in [("groups", 1), ("gid", 2), ("uid", 3), ("verify", 3)] {
            let mut probe = Probe {
                events: vec![],
                failure: Some(failure),
                root: true,
            };
            assert_eq!(
                drop_credentials(&mut probe, User::Ben)
                    .unwrap_err()
                    .to_string(),
                failure
            );
            assert_eq!(probe.events.len(), expected_count);
            assert!(!probe.events.iter().any(|event| event.starts_with("umask")));
        }
        let mut probe = Probe {
            events: vec![],
            failure: None,
            root: false,
        };
        assert_eq!(
            drop_credentials(&mut probe, User::Ben).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert!(probe.events.is_empty());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn real_unprivileged_process_cannot_enter_drop_path() {
        assert_ne!(
            unsafe { libc::geteuid() },
            0,
            "run probe tests unprivileged"
        );
        assert_eq!(
            drop_child(User::Ben).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
    }
}
