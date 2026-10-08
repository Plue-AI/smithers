//! Which processes of one registered terminal session are the member's own
//! Claude Code or Codex, and where each one's transcript is (spec §9.6.6).
//!
//! This is the root broker's half. It reads only what the kernel says about a
//! process: the session's `cgroup.procs`, and `/proc/<pid>/{stat,status,exe,
//! environ,fd}`. It never opens a home, a transcript or any path a process
//! names; those are hints, and the owner-uid resolver and reader open them
//! beneath the owner's agent root without following a link. No request selects
//! the session, the owner or a pid: the caller passes the registry's own entry.
//!
//! A process is an agent only when every check agrees: it is in the session's
//! cgroup, every one of its uids is the session owner's, its executable is one
//! this module names, its agent home is beneath the owner's home, and it is
//! linked to one transcript (Codex holds its rollout open; Claude Code writes
//! `sessions/<pid>.json`, which only the owner reads). A recent file or a
//! directory that looks right is never enough.
use crate::broker::process_identity::start_ticks;
use std::{
    fs::{self, File},
    io::{self, Read},
    os::unix::ffi::OsStrExt,
    path::{Component, Path, PathBuf},
};

/// The most processes one session's scan reads; a cgroup past it is refused.
pub const MAX_PROCESSES: usize = 4096;
/// The most descriptors of one process a scan follows.
const MAX_DESCRIPTORS: usize = 4096;
/// `/proc/<pid>/environ` past this is not read for an agent-home override.
const MAX_ENVIRON: usize = 256 * 1024;
const MAX_PATH: usize = 4096;

/// The agents this install reads. Each names the executables it runs as and
/// the profile family the host's adapters decode.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Agent {
    Codex,
    ClaudeCode,
}
impl Agent {
    /// The adapter profile family; the release line is appended after the
    /// owner-uid resolver reads it from the agent's own files.
    pub fn family(self) -> &'static str {
        match self {
            Self::Codex => "codex-rollout",
            Self::ClaudeCode => "claude-code",
        }
    }
    /// The agent's home beneath the owner's home when no override is set.
    fn default_root(self) -> &'static str {
        match self {
            Self::Codex => ".codex",
            Self::ClaudeCode => ".claude",
        }
    }
    /// The environment variable a member sets to move the agent's home.
    fn root_variable(self) -> &'static [u8] {
        match self {
            Self::Codex => b"CODEX_HOME",
            Self::ClaudeCode => b"CLAUDE_CONFIG_DIR",
        }
    }
}

/// How the owner-uid resolver finds the transcript beneath the agent root.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Link {
    /// The rollout this process holds open, relative to the agent root.
    Rollout(String),
    /// Claude Code names its session in `sessions/<pid>.json`.
    SessionFile,
}

/// One agent process of the session: its kernel lifetime, which agent it is,
/// the owner's agent root and the link to its transcript.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub pid: u32,
    pub start_ticks: u64,
    pub agent: Agent,
    /// Absolute, beneath the owner's home, no `.`/`..` component.
    pub root: String,
    pub link: Link,
}

fn refused() -> io::Error {
    io::ErrorKind::InvalidData.into()
}

/// Which agent an executable path is, or none. Codex's native binary is named
/// `codex` wherever it is installed. Claude Code's native install is a file
/// named by its release under `claude/versions/`; other installs name it
/// `claude`. A launcher script's interpreter (node, sh) is never an agent: the
/// process that writes the transcript is the native one.
pub fn agent_of(exe: &Path) -> Option<Agent> {
    let name = exe.file_name()?.to_str()?;
    if name == "codex" {
        return Some(Agent::Codex);
    }
    if name == "claude" {
        return Some(Agent::ClaudeCode);
    }
    let versions = exe.parent()?;
    let release = name.split('.').count() == 3
        && name.split('.').all(|part| {
            !part.is_empty() && part.len() <= 9 && part.bytes().all(|c| c.is_ascii_digit())
        });
    (release && versions.file_name()? == "versions" && versions.parent()?.file_name()? == "claude")
        .then_some(Agent::ClaudeCode)
}

/// `path` as an absolute path strictly beneath `home`, with only normal
/// components, or none. A hint that leaves the owner's home is not followed.
fn beneath_home(path: &[u8], home: &str) -> Option<String> {
    let text = std::str::from_utf8(path).ok()?;
    if text.len() > MAX_PATH || text.contains('\0') {
        return None;
    }
    let path = Path::new(text);
    let rest = path.strip_prefix(home).ok()?;
    if rest.as_os_str().is_empty() {
        return None;
    }
    // Rebuild from components so `//` and a trailing `/` cannot differ later.
    let mut rebuilt = PathBuf::from(home);
    for component in rest.components() {
        rebuilt.push(normal(&component)?);
    }
    Some(rebuilt.to_str()?.to_owned())
}

/// The owner's agent root: the override the process was started with when it
/// is beneath the owner's home, the default otherwise. An override that points
/// anywhere else refuses the process instead of falling back: its transcript
/// is not where the default says, and nowhere this install may read.
pub fn agent_root(agent: Agent, environ: &[u8], home: &str) -> Option<String> {
    let variable = agent.root_variable();
    for entry in environ.split(|byte| *byte == 0) {
        if let Some(value) = entry
            .strip_prefix(variable)
            .and_then(|rest| rest.strip_prefix(b"="))
        {
            if value.is_empty() {
                break;
            }
            return beneath_home(value, home);
        }
    }
    Some(format!("{home}/{}", agent.default_root()))
}

/// The one rollout among a Codex process's open files, relative to its root:
/// `sessions/YYYY/MM/DD/rollout-<...>.jsonl`. None when it holds no rollout or
/// more than one, so a process is never linked to a transcript by guessing.
pub fn codex_rollout<'a>(
    targets: impl IntoIterator<Item = &'a Path>,
    root: &str,
) -> Option<String> {
    let mut found = None;
    for target in targets {
        let Ok(rest) = target.strip_prefix(root) else {
            continue;
        };
        let parts: Vec<_> = rest.components().collect();
        let digits =
            |text: &str, len: usize| text.len() == len && text.bytes().all(|c| c.is_ascii_digit());
        let [sessions, year, month, day, file] = parts.as_slice() else {
            continue;
        };
        let (Some("sessions"), Some(year), Some(month), Some(day), Some(file)) = (
            normal(sessions),
            normal(year),
            normal(month),
            normal(day),
            normal(file),
        ) else {
            continue;
        };
        if !digits(year, 4)
            || !digits(month, 2)
            || !digits(day, 2)
            || !file.starts_with("rollout-")
            || !file.ends_with(".jsonl")
            || file.len() > 255
        {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some(format!("sessions/{year}/{month}/{day}/{file}"));
    }
    found
}

fn normal<'a>(component: &Component<'a>) -> Option<&'a str> {
    match component {
        Component::Normal(name) => name.to_str(),
        _ => None,
    }
}

fn bounded(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(refused());
    }
    Ok(bytes)
}

/// Every uid of the process (real, effective, saved, filesystem) from
/// `/proc/<pid>/status`.
fn uids(status: &[u8]) -> Option<[u32; 4]> {
    let text = std::str::from_utf8(status).ok()?;
    let line = text.lines().find_map(|line| line.strip_prefix("Uid:"))?;
    let mut values = line.split_whitespace().map(str::parse::<u32>);
    let ids = [
        values.next()?.ok()?,
        values.next()?.ok()?,
        values.next()?.ok()?,
        values.next()?.ok()?,
    ];
    values.next().is_none().then_some(ids)
}

/// One process, or none when it is not this owner's agent. An error is a
/// process that changed under the scan or a kernel answer out of bounds; the
/// caller skips it and the next reconciliation reads it again.
fn inspect(pid: u32, owner: u32, home: &str) -> io::Result<Option<Found>> {
    let dir = Path::new("/proc").join(pid.to_string());
    let before = start_ticks(pid)?;
    if uids(&bounded(&dir.join("status"), 16 * 1024)?) != Some([owner; 4]) {
        return Ok(None);
    }
    let exe = fs::read_link(dir.join("exe"))?;
    // A replaced binary reads "<path> (deleted)": it is no longer the file
    // this module would name, so the process is not identified.
    let Some(agent) = agent_of(&exe) else {
        return Ok(None);
    };
    let Some(root) = agent_root(agent, &bounded(&dir.join("environ"), MAX_ENVIRON)?, home) else {
        return Ok(None);
    };
    let link = match agent {
        Agent::ClaudeCode => Link::SessionFile,
        Agent::Codex => {
            let mut targets = Vec::new();
            for entry in fs::read_dir(dir.join("fd"))? {
                if targets.len() == MAX_DESCRIPTORS {
                    return Err(refused());
                }
                // A descriptor closed between listing and reading is not an error.
                if let Ok(target) = fs::read_link(entry?.path()) {
                    if target.as_os_str().as_bytes().len() <= MAX_PATH {
                        targets.push(target);
                    }
                }
            }
            match codex_rollout(targets.iter().map(PathBuf::as_path), &root) {
                Some(path) => Link::Rollout(path),
                None => return Ok(None),
            }
        }
    };
    // The pid named the same process for every read above, or none of it counts.
    if start_ticks(pid)? != before {
        return Err(refused());
    }
    Ok(Some(Found {
        pid,
        start_ticks: before,
        agent,
        root,
        link,
    }))
}

/// The owner's agent processes among the pids `cgroup_procs` lists. `owner`
/// and `home` come from the session's registry entry. A process that is not an
/// agent, exits mid-scan or cannot be read is left out; the list itself out of
/// bounds refuses the scan.
pub fn scan(cgroup_procs: &Path, owner: u32, home: &str) -> io::Result<Vec<Found>> {
    if owner == 0 || !home.starts_with('/') || home.len() > MAX_PATH || home.contains('\0') {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let listed = bounded(cgroup_procs, 16 * MAX_PROCESSES)?;
    let text = std::str::from_utf8(&listed).map_err(|_| refused())?;
    let mut found = Vec::new();
    let mut count = 0;
    for line in text.lines() {
        count += 1;
        if count > MAX_PROCESSES {
            return Err(refused());
        }
        let pid = line.parse::<u32>().map_err(|_| refused())?;
        if pid == 0 {
            return Err(refused());
        }
        if let Ok(Some(agent)) = inspect(pid, owner, home) {
            found.push(agent);
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_agents_by_their_native_executables_only() {
        for (exe, agent) in [
            ("/usr/local/bin/codex", Some(Agent::Codex)),
            ("/home/ben/.nvm/versions/node/v26.10.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/codex/codex", Some(Agent::Codex)),
            ("/home/ben/.local/share/claude/versions/2.1.291", Some(Agent::ClaudeCode)),
            ("/usr/local/bin/claude", Some(Agent::ClaudeCode)),
            // An interpreter running a launcher, a shell, and look-alikes.
            ("/usr/bin/node", None),
            ("/bin/bash", None),
            ("/home/ben/bin/codex-wrapper", None),
            ("/home/ben/bin/codex (deleted)", None),
            ("/home/ben/.local/share/claude/versions/latest", None),
            ("/home/ben/.local/share/claude/versions/2.1", None),
            ("/home/ben/.local/share/claude/versions/2.1.x", None),
            ("/home/ben/.local/share/other/versions/2.1.291", None),
            ("/home/ben/versions/2.1.291", None),
            ("/", None),
        ] {
            assert_eq!(agent_of(Path::new(exe)), agent, "{exe}");
        }
    }

    #[test]
    fn agent_root_is_the_default_or_an_override_beneath_the_owner_home() {
        let home = "/home/ben";
        let env = |entries: &[&str]| entries.join("\0").into_bytes();
        assert_eq!(
            agent_root(Agent::Codex, b"", home).as_deref(),
            Some("/home/ben/.codex")
        );
        assert_eq!(
            agent_root(
                Agent::ClaudeCode,
                &env(&["PATH=/bin", "CODEX_HOME=/home/ben/x"]),
                home
            )
            .as_deref(),
            Some("/home/ben/.claude")
        );
        assert_eq!(
            agent_root(
                Agent::Codex,
                &env(&["CODEX_HOME=/home/ben/work/.codex", "HOME=/home/ben"]),
                home
            )
            .as_deref(),
            Some("/home/ben/work/.codex")
        );
        // The same directory spelled another way is the same root, written one way.
        assert_eq!(
            agent_root(
                Agent::ClaudeCode,
                &env(&["CLAUDE_CONFIG_DIR=/home/ben/c//d/"]),
                home
            )
            .as_deref(),
            Some("/home/ben/c/d")
        );
        assert_eq!(
            agent_root(Agent::Codex, &env(&["CODEX_HOME=/home/ben/./.codex"]), home).as_deref(),
            Some("/home/ben/.codex")
        );
        // An empty override is unset. A similarly named variable is not it.
        assert_eq!(
            agent_root(Agent::Codex, &env(&["CODEX_HOME="]), home).as_deref(),
            Some("/home/ben/.codex")
        );
        assert_eq!(
            agent_root(
                Agent::Codex,
                &env(&["CODEX_HOME_2=/home/maya/.codex"]),
                home
            )
            .as_deref(),
            Some("/home/ben/.codex")
        );
        // An override outside the owner's home refuses the process: no fallback.
        for hostile in [
            "CODEX_HOME=/home/maya/.codex",
            "CODEX_HOME=/home/ben",
            "CODEX_HOME=/home/ben/../maya/.codex",
            "CODEX_HOME=/home/ben/x/../../maya/.codex",
            "CODEX_HOME=/home/benjamin/.codex",
            "CODEX_HOME=relative/.codex",
            "CODEX_HOME=/",
            "CODEX_HOME=/etc",
        ] {
            assert_eq!(
                agent_root(Agent::Codex, &env(&[hostile]), home),
                None,
                "{hostile}"
            );
        }
        assert_eq!(
            agent_root(Agent::Codex, b"CODEX_HOME=/home/ben/\xff", home),
            None
        );
        let long = format!("CODEX_HOME=/home/ben/{}", "a".repeat(MAX_PATH));
        assert_eq!(agent_root(Agent::Codex, long.as_bytes(), home), None);
    }

    #[test]
    fn a_codex_process_is_linked_to_exactly_one_open_rollout_beneath_its_root() {
        let root = "/home/ben/.codex";
        let link = |targets: &[&str]| codex_rollout(targets.iter().map(|t| Path::new(*t)), root);
        let rollout =
            "/home/ben/.codex/sessions/2026/10/08/rollout-2026-10-08T05-05-52-01a119e7.jsonl";
        assert_eq!(
            link(&[
                "/dev/pts/0",
                "/home/ben/.codex/logs_2.sqlite",
                rollout,
                "socket:[1234]"
            ])
            .as_deref(),
            Some("sessions/2026/10/08/rollout-2026-10-08T05-05-52-01a119e7.jsonl")
        );
        // Nothing open, another agent home, another member's rollout, a
        // look-alike beside the sessions tree, a deleted file: no link.
        for targets in [
            vec!["/dev/pts/0"],
            vec!["/home/maya/.codex/sessions/2026/10/08/rollout-x.jsonl"],
            vec!["/home/ben/.codex-other/sessions/2026/10/08/rollout-x.jsonl"],
            vec!["/home/ben/.codex/sessions/2026/10/rollout-x.jsonl"],
            vec!["/home/ben/.codex/sessions/2026/10/08/extra/rollout-x.jsonl"],
            vec!["/home/ben/.codex/sessions/2026/10/08/notes.jsonl"],
            vec!["/home/ben/.codex/sessions/2026/10/08/rollout-x.json"],
            vec!["/home/ben/.codex/sessions/20x6/10/08/rollout-x.jsonl"],
            vec!["/home/ben/.codex/sessions/2026/10/08/rollout-x.jsonl (deleted)"],
            vec!["/home/ben/.codex/history/2026/10/08/rollout-x.jsonl"],
        ] {
            assert_eq!(link(&targets), None, "{targets:?}");
        }
        // Two open rollouts are ambiguous: neither is chosen.
        assert_eq!(
            link(&[
                rollout,
                "/home/ben/.codex/sessions/2026/10/07/rollout-older.jsonl"
            ]),
            None
        );
    }

    #[test]
    fn reads_every_uid_of_a_process_and_refuses_a_changed_status() {
        assert_eq!(uids(b"Name:\tcodex\nUid:\t20001\t20001\t20001\t20001\nGid:\t20001\t20001\t20001\t20001\n"), Some([20001; 4]));
        assert_eq!(
            uids(b"Uid:\t20001\t0\t20001\t20001\n"),
            Some([20001, 0, 20001, 20001])
        );
        for bad in [
            b"Name:\tcodex\n".as_slice(),
            b"Uid:\t20001\t20001\t20001\n",
            b"Uid:\t20001\t20001\t20001\t20001\t7\n",
            b"Uid:\tben\t20001\t20001\t20001\n",
            b"Uid:\t-1\t20001\t20001\t20001\n",
            b"\xff",
        ] {
            assert_eq!(uids(bad), None);
        }
    }

    #[test]
    fn a_scan_refuses_an_owner_or_a_process_list_out_of_bounds() {
        let dir =
            std::env::temp_dir().join(format!("smithers-discovery-unit-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let procs = dir.join("cgroup.procs");
        fs::write(&procs, "").unwrap();
        assert_eq!(scan(&procs, 20001, "/home/ben").unwrap(), vec![]);
        for (owner, home) in [
            (0, "/home/ben"),
            (20001, "home/ben"),
            (20001, "/home/\0ben"),
        ] {
            assert_eq!(
                scan(&procs, owner, home).unwrap_err().kind(),
                io::ErrorKind::PermissionDenied
            );
        }
        for listed in ["0\n", "abc\n", "-4\n", "1 2\n"] {
            fs::write(&procs, listed).unwrap();
            assert!(scan(&procs, 20001, "/home/ben").is_err(), "{listed:?}");
        }
        fs::write(&procs, "1\n".repeat(MAX_PROCESSES + 1)).unwrap();
        assert!(scan(&procs, 20001, "/home/ben").is_err());
        // A pid that is not this owner's, or is gone, is left out, not an error.
        fs::write(&procs, format!("{}\n4194303\n", std::process::id())).unwrap();
        assert_eq!(scan(&procs, 4_000_000_000, "/home/ben").unwrap(), vec![]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
