//! The session child, after permanent identity drop, consumes one host binding
//! and the tmpfs environment. Root never parses either file's contents.
use crate::broker::sessions::User;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io};
#[cfg(target_os = "linux")]
use std::{fs::File, io::Read, os::unix::fs::MetadataExt};
const LIMIT: usize = 256 * 1024;
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub login: String,
    pub uid: u32,
    pub session: String,
    pub token_sha256: String,
    #[serde(deserialize_with = "unique_environment")]
    pub environment: BTreeMap<String, String>,
}
fn invalid() -> io::Error {
    io::ErrorKind::PermissionDenied.into()
}
fn key(k: &str) -> bool {
    !k.is_empty()
        && k.len() <= 256
        && k.bytes()
            .enumerate()
            .all(|(i, c)| c == b'_' || c.is_ascii_alphabetic() || (i != 0 && c.is_ascii_digit()))
}
fn unique_environment<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<BTreeMap<String, String>, D::Error> {
    struct Map;
    impl<'de> serde::de::Visitor<'de> for Map {
        type Value = BTreeMap<String, String>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("unique string environment")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> Result<Self::Value, A::Error> {
            let mut result = BTreeMap::new();
            while let Some((name, value)) = map.next_entry::<String, String>()? {
                if result.len() >= 1000
                    || !key(&name)
                    || value.contains('\0')
                    || result.insert(name, value).is_some()
                {
                    return Err(serde::de::Error::custom(
                        "invalid or duplicate environment entry",
                    ));
                }
            }
            Ok(result)
        }
    }
    d.deserialize_map(Map)
}
#[derive(Deserialize)]
struct Environment(#[serde(deserialize_with = "unique_environment")] BTreeMap<String, String>);
fn environment(bytes: &[u8]) -> io::Result<BTreeMap<String, String>> {
    if bytes.len() > LIMIT {
        return Err(invalid());
    }
    let Environment(e) = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if e.len() > 1000 || e.iter().any(|(k, v)| !key(k) || v.contains('\0')) {
        return Err(invalid());
    }
    Ok(e)
}
impl Binding {
    pub fn parse(bytes: &[u8], user: &User) -> io::Result<Self> {
        user.validate()?;
        if bytes.len() > LIMIT {
            return Err(invalid());
        }
        let b: Self = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if b.login != user.login
            || b.uid != user.uid
            || b.session.is_empty()
            || b.session.len() > 128
            || !b
                .session
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
            || b.token_sha256.len() != 64
            || !b
                .token_sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || b.environment.len() > 1000
            || b.environment
                .iter()
                .any(|(k, v)| !key(k) || v.contains('\0'))
            || b.environment.get("SMITHERS_TOKEN_FILE")
                != Some(&if user.uid >= 20000 {
                    format!(
                        "/run/smithers/{}/token/sessions/{}/token",
                        user.uid, b.session
                    )
                } else {
                    format!("/run/smithers/sessions/{}/token", b.session)
                })
            || b.environment
                .get("SMITHERS_URL")
                .is_none_or(|v| v.is_empty() || v.len() > 4096)
        {
            return Err(invalid());
        }
        Ok(b)
    }
    fn token(&self, bytes: &[u8]) -> io::Result<()> {
        if bytes.is_empty()
            || bytes.len() > 1025
            || bytes.last() != Some(&b'\n')
            || bytes[..bytes.len() - 1]
                .iter()
                .any(|b| *b <= 0x20 || *b > 0x7e)
            || format!("{:x}", Sha256::digest(&bytes[..bytes.len() - 1])) != self.token_sha256
        {
            return Err(invalid());
        }
        Ok(())
    }
}
#[cfg(target_os = "linux")]
fn bounded(mut file: File) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    (&mut file)
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > LIMIT {
        return Err(invalid());
    }
    Ok(bytes)
}
/// The team's session secrets (spec §8.8.1): the broker-written tmpfs file,
/// opened without following links and parsed only by an unprivileged child.
#[cfg(target_os = "linux")]
pub fn team_environment() -> io::Result<BTreeMap<String, String>> {
    use rustix::fs::{Mode, OFlags, ResolveFlags};
    let root = File::open("/")?;
    let secrets: File = rustix::fs::openat2(
        &root,
        "run/smithers/env",
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    )?
    .into();
    let m = secrets.metadata()?;
    if rustix::process::geteuid().is_root()
        || !m.is_file()
        || m.uid() != 0
        || m.gid() != 20000
        || m.mode() & 0o7777 != 0o640
        || m.nlink() != 1
        || rustix::fs::fstatfs(&secrets)?.f_type as u64 != 0x01021994
    {
        return Err(invalid());
    }
    environment(&bounded(secrets)?)
}
#[cfg(target_os = "linux")]
pub fn run(args: &[String]) -> io::Result<()> {
    use rustix::fs::{Mode, OFlags, ResolveFlags};
    use std::os::{fd::FromRawFd, unix::process::CommandExt};
    let uid = rustix::process::geteuid().as_raw();
    if uid < 19999 || rustix::process::getuid().as_raw() != uid || args.is_empty() {
        return Err(invalid());
    }
    let binding = unsafe { File::from_raw_fd(6) };
    let m = binding.metadata()?;
    // The broker unlinked the consumed binding, so nlink must now be zero.
    if !m.is_file()
        || m.uid() != 0
        || m.gid() != uid
        || m.mode() & 0o7777 != 0o640
        || m.nlink() != 0
        || m.len() > LIMIT as u64
    {
        return Err(invalid());
    }
    let bytes = bounded(binding)?;
    let user = User {
        login: std::env::var("USER").map_err(|_| invalid())?,
        uid,
    };
    let binding = Binding::parse(&bytes, &user)?;
    let root = File::open("/")?;
    let open = |path: &str| -> io::Result<File> {
        Ok(rustix::fs::openat2(
            &root,
            path.trim_start_matches('/'),
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
        )?
        .into())
    };
    let mut env = team_environment()?;
    let token = open(
        binding
            .environment
            .get("SMITHERS_TOKEN_FILE")
            .ok_or_else(invalid)?,
    )?;
    let m = token.metadata()?;
    if !m.is_file()
        || m.uid() != uid
        || m.gid() != uid
        || m.mode() & 0o7777 != 0o600
        || m.nlink() != 1
        || m.len() > 1025
    {
        return Err(invalid());
    }
    binding.token(&bounded(token)?)?;
    env.extend(binding.environment);
    install_smithers_skill(&format!("/home/{}", user.login))?;
    env.insert("HOME".into(), format!("/home/{}", user.login));
    env.insert("USER".into(), user.login.clone());
    env.insert("LOGNAME".into(), user.login);
    let path = env
        .get("PATH")
        .cloned()
        .unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into());
    env.insert(
        "PATH".into(),
        format!("/opt/smithers/bundle/bin/linux-arm64:{path}"),
    );
    let error = std::process::Command::new(&args[0])
        .args(&args[1..])
        .env_clear()
        .envs(env)
        .exec();
    Err(error)
}
// This runs only in the permanently unprivileged session child.
#[cfg(target_os = "linux")]
fn install_smithers_skill(home: &str) -> io::Result<()> {
    use std::os::unix::fs::symlink;
    let target = std::path::Path::new("/opt/smithers/bundle/share/skills/smithers");
    for directory in [".claude/skills", ".agents/skills"] {
        let parent = std::path::Path::new(home).join(directory);
        std::fs::create_dir_all(&parent)?;
        let link = parent.join("smithers");
        match symlink(target, &link) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if std::fs::read_link(&link)? != target {
                    return Err(invalid());
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[test]
    fn generated_skill_is_discoverable_and_foreign_links_refuse() {
        let home = tempfile::tempdir().unwrap();
        let home_path = home.path().to_str().unwrap();
        install_smithers_skill(home_path).unwrap();
        install_smithers_skill(home_path).unwrap();
        for directory in [".claude/skills", ".agents/skills"] {
            assert_eq!(
                std::fs::read_link(home.path().join(directory).join("smithers")).unwrap(),
                std::path::Path::new("/opt/smithers/bundle/share/skills/smithers")
            );
        }
        let link = home.path().join(".agents/skills/smithers");
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink("/tmp/foreign", link).unwrap();
        assert!(install_smithers_skill(home_path).is_err());
    }
    fn source() -> Vec<u8> {
        br#"{"login":"ben","uid":20001,"session":"terminal-a","token_sha256":"696e66e7bfa9c8319a19a7dfb18f2db9a151a680ba3c2c87e0dd204ea8ff11dd","environment":{"SMITHERS_TOKEN_FILE":"/run/smithers/20001/token/sessions/terminal-a/token","SMITHERS_URL":"http://127.0.0.1:4000"}}"#.to_vec()
    }
    #[test]
    fn exact_identity_and_session_binding_refuse_forged_or_unbounded_input() {
        let user = User {
            login: "ben".into(),
            uid: 20001,
        };
        assert_eq!(
            Binding::parse(&source(), &user).unwrap().session,
            "terminal-a"
        );
        for (from, to) in [
            ("ben", "root"),
            ("20001", "0"),
            ("terminal-a/token", "terminal-b/token"),
            ("/20001/token/", "/20002/token/"),
            ("/20001/token/", "/"),
            ("terminal-a\"", "../escape\""),
            ("SMITHERS_URL", "OTHER_URL"),
            ("696e66", "FFFF66"),
        ] {
            assert!(
                Binding::parse(
                    String::from_utf8(source())
                        .unwrap()
                        .replace(from, to)
                        .as_bytes(),
                    &user
                )
                .is_err()
            );
        }
        assert!(Binding::parse(&vec![b' '; LIMIT + 1], &user).is_err());
        assert!(environment(br#"{"1INVALID":"x"}"#).is_err());
        assert!(environment(br#"{"VALID":"a\u0000b"}"#).is_err());
        assert!(environment(br#"{"VALID":4}"#).is_err());
        assert!(environment(br#"{"VALID":"one","VALID":"two"}"#).is_err());
        assert_eq!(
            environment(br#"{"VALID":"literal $() bytes"}"#).unwrap()["VALID"],
            "literal $() bytes"
        );
    }
    #[test]
    fn private_member_paths_and_legacy_agent_paths_are_distinct() {
        let text = String::from_utf8(source()).unwrap();
        let member = User {
            login: "ben".into(),
            uid: 20001,
        };
        for path in [
            "/run/smithers/sessions/terminal-a/token",
            "/run/smithers/20002/token/sessions/terminal-a/token",
            "/run/smithers/20001/token/sessions/terminal-b/token",
        ] {
            assert!(
                Binding::parse(
                    text.replace("/run/smithers/20001/token/sessions/terminal-a/token", path)
                        .as_bytes(),
                    &member
                )
                .is_err()
            );
        }
        let agent = text
            .replace("\"ben\"", "\"agent\"")
            .replace("20001", "19999")
            .replace(
                "/run/smithers/19999/token/sessions",
                "/run/smithers/sessions",
            );
        let user = User {
            login: "agent".into(),
            uid: 19999,
        };
        assert!(Binding::parse(agent.as_bytes(), &user).is_ok());
        assert!(
            Binding::parse(
                agent
                    .replace(
                        "/run/smithers/sessions",
                        "/run/smithers/20001/token/sessions"
                    )
                    .as_bytes(),
                &user
            )
            .is_err()
        );
    }
    #[test]
    fn token_digest_and_framing_are_exact() {
        let mut b = Binding::parse(
            &source(),
            &User {
                login: "ben".into(),
                uid: 20001,
            },
        )
        .unwrap();
        b.token_sha256 = format!("{:x}", Sha256::digest(b"smithers_literal"));
        b.token(b"smithers_literal\n").unwrap();
        for bad in [
            b"smithers_other\n".as_slice(),
            b"smithers_literal",
            b"smithers_literal\n\n",
            b"\n",
            b"",
        ] {
            assert!(b.token(bad).is_err());
        }
    }
}
