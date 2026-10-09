//! The owner's half of discovery (spec §9.6.6): which file beneath the agent
//! root is this process's transcript, and which release wrote it.
//!
//! The root broker names a process and a hint (`discovery::Found`). This runs
//! once as the session owner, after the same permanent uid, gid and group drop
//! as the reader, and answers from the agent's own files: Codex's rollout names
//! its release on its first line; Claude Code's `sessions/<pid>.json` names the
//! session, the directory it ran in and its release. Every open is beneath the
//! held agent root, follows no link, and takes only a regular file the owner
//! owns. Nothing is listed or read beyond the one session's files, and a file
//! that is not there yet is "not yet", never a reason to look elsewhere.
//!
//! The answer is a path and a release. The broker checks its shape again
//! before it starts a reader: this process read member-controlled bytes.
use super::{
    discovery::{Agent, Link},
    reader::{open_root, receive, require_owner, seal, send, DONE, ERROR},
    MAX_RECORD_BYTES,
};
use rustix::fs::{self, Mode, OFlags, ResolveFlags};
use std::{
    fs::File,
    io::{self, Read, Write},
    os::unix::fs::MetadataExt,
};

/// Claude Code's session file is a small JSON object.
const MAX_SESSION_FILE: u64 = 64 * 1024;
/// The most project directories looked in for one session id.
const MAX_PROJECTS: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub uid: u32,
    pub gid: u32,
    pub groups: Vec<u32>,
    pub root: String,
    pub agent: Agent,
    pub pid: u32,
    pub link: Link,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resolved {
    /// The transcript, relative to the agent root.
    pub path: String,
    /// The CLI release that wrote it, as the agent's own file states it.
    pub release: String,
}

fn invalid() -> io::Error {
    io::ErrorKind::InvalidData.into()
}

/// `major.minor` of a release such as `2.1.291` or `0.160.1-alpha.2`.
fn release_line(release: &str) -> Option<String> {
    let mut parts = release.splitn(3, '.');
    let number = |part: &str| {
        !part.is_empty() && part.len() <= 9 && part.bytes().all(|c| c.is_ascii_digit())
    };
    let (major, minor) = (
        parts.next().filter(|p| number(p))?,
        parts.next().filter(|p| number(p))?,
    );
    let patch = parts.next()?;
    let digits = patch.bytes().take_while(u8::is_ascii_digit).count();
    let rest = &patch[digits..];
    (digits > 0
        && digits <= 9
        && release.len() <= 64
        && (rest.is_empty()
            || (rest.starts_with(['-', '+'])
                && rest
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'+' | b'.')))))
    .then(|| format!("{major}.{minor}"))
}

/// The adapter profile the host decodes this source with:
/// `<family>/<major.minor>`. None for a release this module cannot read a line
/// from; the source is then not imported.
pub fn profile(agent: Agent, release: &str) -> Option<String> {
    Some(format!("{}/{}", agent.family(), release_line(release)?))
}

fn uuid(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => c.is_ascii_hexdigit() && !c.is_ascii_uppercase(),
        })
}

impl Resolved {
    /// The broker's check of an answer this module produced from member files:
    /// the path is the one the kernel showed (Codex), or one Claude Code
    /// session's transcript under `projects/`; the release reads as one.
    pub fn validate(&self, request: &Request) -> io::Result<()> {
        let shape = match &request.link {
            Link::Rollout(path) => &self.path == path,
            Link::SessionFile => {
                let parts: Vec<_> = self.path.split('/').collect();
                matches!(parts.as_slice(), ["projects", project, file]
                    if !project.is_empty() && project.len() <= 255 && *project != "." && *project != ".."
                        && file.strip_suffix(".jsonl").is_some_and(uuid))
            }
        };
        if !shape
            || self.path.len() > 4096
            || self.path.contains('\0')
            || profile(request.agent, &self.release).is_none()
        {
            return Err(invalid());
        }
        Ok(())
    }
}

/// One regular file of the owner's beneath `root`, opened without following a
/// link at any component, or NotFound. A special file, another owner's file or
/// a second hard link is refused, not skipped.
fn open(root: &File, path: &str, uid: u32) -> io::Result<File> {
    let file: File = fs::openat2(
        root,
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_XDEV,
    )?
    .into();
    let meta = file.metadata()?;
    if !meta.is_file() || meta.uid() != uid || meta.nlink() != 1 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(file)
}

/// The release Codex names on its rollout's first record.
fn codex_release(root: &File, path: &str, uid: u32) -> io::Result<String> {
    let mut line = Vec::new();
    open(root, path, uid)?
        .take(MAX_RECORD_BYTES as u64 + 1)
        .read_to_end(&mut line)?;
    // The first record is complete only once its newline is written.
    let end = line
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| io::Error::from(io::ErrorKind::WouldBlock))?;
    #[derive(serde::Deserialize)]
    struct Meta {
        #[serde(rename = "type")]
        kind: String,
        payload: Payload,
    }
    #[derive(serde::Deserialize)]
    struct Payload {
        cli_version: String,
    }
    let meta: Meta = serde_json::from_slice(&line[..end]).map_err(|_| invalid())?;
    if meta.kind != "session_meta" {
        return Err(invalid());
    }
    Ok(meta.payload.cli_version)
}

/// Claude Code's project directory for a working directory: every character
/// that is not an ASCII letter or digit becomes `-`.
fn claude_project(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The transcript and release of the Claude Code process `pid`, from the
/// session file it wrote under its own pid.
fn claude_session(root: &File, pid: u32, uid: u32) -> io::Result<Resolved> {
    let file = open(root, &format!("sessions/{pid}.json"), uid)?;
    if file.metadata()?.len() > MAX_SESSION_FILE {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(MAX_SESSION_FILE + 1).read_to_end(&mut bytes)?;
    #[derive(serde::Deserialize)]
    struct Session {
        pid: u32,
        #[serde(rename = "sessionId")]
        session: String,
        cwd: String,
        version: String,
    }
    let session: Session = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    // The file is named by a pid and must be that process's own.
    if session.pid != pid
        || !uuid(&session.session)
        || !session.cwd.starts_with('/')
        || session.cwd.len() > 4096
        || session.cwd.contains('\0')
    {
        return Err(invalid());
    }
    let file = format!("{}.jsonl", session.session);
    let direct = format!("projects/{}/{file}", claude_project(&session.cwd));
    let path = match open(root, &direct, uid) {
        Ok(_) => direct,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // A directory name this module would not have written the same
            // way: look for this one session's file by its id, nothing else.
            let projects: File = match fs::openat2(
                root,
                "projects",
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
                ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
            ) {
                Ok(directory) => directory.into(),
                // No session of this home has been prompted yet.
                Err(rustix::io::Errno::NOENT) => return Err(io::ErrorKind::WouldBlock.into()),
                Err(error) => return Err(error.into()),
            };
            let mut found = None;
            let mut seen = 0;
            for entry in fs::Dir::read_from(&projects)? {
                let entry = entry?;
                let Ok(name) = entry.file_name().to_str() else {
                    continue;
                };
                if name == "." || name == ".." {
                    continue;
                }
                seen += 1;
                if seen > MAX_PROJECTS {
                    return Err(invalid());
                }
                let candidate = format!("projects/{name}/{file}");
                if name.len() <= 255 && !name.contains('/') && open(root, &candidate, uid).is_ok() {
                    if found.is_some() {
                        return Err(invalid());
                    }
                    found = Some(candidate);
                }
            }
            // Claude Code writes the transcript at the session's first prompt.
            found.ok_or_else(|| io::Error::from(io::ErrorKind::WouldBlock))?
        }
        Err(error) => return Err(error),
    };
    Ok(Resolved {
        path,
        release: session.version,
    })
}

/// Answer one request and return. Identity is checked before the agent root is
/// opened; a refusal writes ERROR and no detail.
pub fn serve(mut input: impl Read, mut output: impl Write) -> io::Result<()> {
    let (tag, bytes) = receive(&mut input)?;
    if tag != 0 {
        return Err(invalid());
    }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    require_owner(request.uid, request.gid, &request.groups, &request.root)?;
    let answer = (|| {
        if request.pid == 0 {
            return Err(invalid());
        }
        let root = open_root(&request.root)?;
        let meta = root.metadata()?;
        if !meta.is_dir() || meta.uid() != request.uid {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let resolved = match (request.agent, &request.link) {
            (Agent::Codex, Link::Rollout(path)) => Resolved {
                release: codex_release(&root, path, request.uid)?,
                path: path.clone(),
            },
            (Agent::ClaudeCode, Link::SessionFile) => {
                claude_session(&root, request.pid, request.uid)?
            }
            _ => return Err(invalid()),
        };
        resolved.validate(&request)?;
        Ok(resolved)
    })();
    match answer {
        Ok(resolved) => send(
            &mut output,
            DONE,
            &serde_json::to_vec(&resolved).map_err(|_| invalid())?,
        ),
        Err(error) => {
            // Agents create their root, session file and transcript during
            // startup. Missing files and partial records are "not yet", so
            // they do not accumulate the broker's hard-failure backoff.
            send(
                &mut output,
                ERROR,
                &[u8::from(matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::NotFound
                ))],
            )?;
            Err(error)
        }
    }
}

/// The installed executable is re-executed as `transcript-resolve` after the
/// broker's permanent group, GID and UID drop, on its private socketpair.
pub fn run() -> io::Result<()> {
    seal()?;
    serve(io::stdin().lock(), io::stdout().lock())
}

/// The longest answer the broker reads from a resolver.
pub const MAX_ANSWER: usize = 8192;

/// The broker's side, first half: write the one request. It is small enough
/// to fit a new socket's buffer, so a broker that must never wait on a
/// member's process writes it without blocking.
pub fn request(writer: &mut impl Write, request: &Request) -> io::Result<()> {
    send(
        writer,
        0,
        &serde_json::to_vec(request).map_err(|_| invalid())?,
    )
}

/// One whole answer frame at the start of `bytes` (what the broker has peeked
/// from the socket so far), or none while it is still arriving. A frame that
/// declares more than [`MAX_ANSWER`] is refused before it is read.
pub fn frame(bytes: &[u8]) -> io::Result<Option<(u8, &[u8])>> {
    let Some(header) = bytes.get(..5) else {
        return Ok(None);
    };
    let size = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
    if size > MAX_ANSWER {
        return Err(invalid());
    }
    Ok(bytes.get(5..5 + size).map(|body| (header[0], body)))
}

/// The broker's side, second half: what one answer frame says. `Ok(None)` is
/// "not yet". Any other refusal is an error.
pub fn answer(tag: u8, body: &[u8], request: &Request) -> io::Result<Option<Resolved>> {
    match tag {
        DONE if body.len() <= MAX_ANSWER => {
            let resolved: Resolved = serde_json::from_slice(body).map_err(|_| invalid())?;
            resolved.validate(request)?;
            Ok(Some(resolved))
        }
        ERROR if body == [1] => Ok(None),
        _ => Err(invalid()),
    }
}

/// Both halves on a socket with a deadline, for a caller that may wait.
pub fn ask(mut socket: impl Read + Write, asked: &Request) -> io::Result<Option<Resolved>> {
    request(&mut socket, asked)?;
    let (tag, bytes) = receive(&mut socket)?;
    answer(tag, &bytes, asked)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_is_the_family_and_the_release_line() {
        for (agent, release, expected) in [
            (Agent::ClaudeCode, "2.1.291", Some("claude-code/2.1")),
            (Agent::Codex, "0.160.1", Some("codex-rollout/0.160")),
            (Agent::Codex, "0.160.1-alpha.2", Some("codex-rollout/0.160")),
            (Agent::Codex, "0.161.0+build.7", Some("codex-rollout/0.161")),
            // Not a release: the source is not imported under a guess.
            (Agent::Codex, "0.160", None),
            (Agent::Codex, "0.160.", None),
            (Agent::Codex, "v0.160.1", None),
            (Agent::Codex, "0.160.1 ", None),
            (Agent::Codex, "0.160.1/../../etc", None),
            (Agent::Codex, "0..1", None),
            (Agent::Codex, "", None),
            (Agent::ClaudeCode, "2.1.291\nclaude-code/9.9", None),
            (Agent::ClaudeCode, "latest", None),
        ] {
            assert_eq!(profile(agent, release).as_deref(), expected, "{release:?}");
        }
        assert_eq!(
            profile(Agent::Codex, &format!("0.160.1-{}", "a".repeat(64))),
            None
        );
    }

    #[test]
    fn an_answer_frame_is_read_whole_or_not_at_all() {
        let asked = Request {
            uid: 20001,
            gid: 20001,
            groups: vec![20000],
            root: "/home/ben/.codex".into(),
            agent: Agent::Codex,
            pid: 7,
            link: Link::Rollout("sessions/2026/10/08/rollout-a.jsonl".into()),
        };
        let resolved = Resolved {
            path: "sessions/2026/10/08/rollout-a.jsonl".into(),
            release: "0.160.1".into(),
        };
        let mut wire = Vec::new();
        send(&mut wire, DONE, &serde_json::to_vec(&resolved).unwrap()).unwrap();
        // Every prefix is "still arriving"; bytes after the frame are not part of it.
        for cut in 0..wire.len() {
            assert_eq!(frame(&wire[..cut]).unwrap(), None, "{cut}");
        }
        let (tag, body) = frame(&wire).unwrap().unwrap();
        assert_eq!(answer(tag, body, &asked).unwrap(), Some(resolved.clone()));
        let mut trailing = wire.clone();
        trailing.extend(b"trailing");
        assert_eq!(frame(&trailing).unwrap().unwrap().1, body);
        // "Not yet", a refusal, and an answer for another request.
        assert_eq!(answer(ERROR, &[1], &asked).unwrap(), None);
        for (tag, body) in [
            (ERROR, &[0][..]),
            (ERROR, &[]),
            (ERROR, &[1, 1]),
            (9, &[1]),
            (DONE, b"{}"),
        ] {
            assert!(answer(tag, body, &asked).is_err(), "{tag} {body:?}");
        }
        let other = Request {
            link: Link::Rollout("sessions/2026/10/08/rollout-b.jsonl".into()),
            ..asked.clone()
        };
        assert!(answer(tag, body, &other).is_err());
        // A frame that declares more than the broker reads is refused from its header.
        let size = (MAX_ANSWER as u32 + 1).to_be_bytes();
        assert!(frame(&[DONE, size[0], size[1], size[2], size[3]]).is_err());
        let size = (MAX_ANSWER as u32).to_be_bytes();
        assert_eq!(
            frame(&[DONE, size[0], size[1], size[2], size[3]]).unwrap(),
            None
        );
    }

    #[test]
    fn claude_project_directory_replaces_every_other_character() {
        assert_eq!(claude_project("/home/ben/repo"), "-home-ben-repo");
        assert_eq!(
            claude_project("/workspace/agt-capture/work.qL7V"),
            "-workspace-agt-capture-work-qL7V"
        );
        assert_eq!(
            claude_project("/home/ben/my repo_2/é"),
            "-home-ben-my-repo-2--"
        );
    }

    #[test]
    fn the_broker_accepts_only_the_answer_shapes_discovery_can_produce() {
        let request = |agent, link| Request {
            uid: 20001,
            gid: 20001,
            groups: vec![20000],
            root: "/home/ben/.x".into(),
            agent,
            pid: 7,
            link,
        };
        let rollout = "sessions/2026/10/08/rollout-a.jsonl";
        let codex = request(Agent::Codex, Link::Rollout(rollout.into()));
        let ok = |path: &str, release: &str| Resolved {
            path: path.into(),
            release: release.into(),
        };
        assert!(ok(rollout, "0.160.1").validate(&codex).is_ok());
        // Codex's answer is the file the kernel showed, never another.
        assert!(ok("sessions/2026/10/08/rollout-b.jsonl", "0.160.1")
            .validate(&codex)
            .is_err());
        assert!(ok(rollout, "not a release").validate(&codex).is_err());
        let claude = request(Agent::ClaudeCode, Link::SessionFile);
        let session = "projects/-home-ben-repo/5b2c9e10-0000-4000-8000-00000000c1de.jsonl";
        assert!(ok(session, "2.1.291").validate(&claude).is_ok());
        for path in [
            "projects/../5b2c9e10-0000-4000-8000-00000000c1de.jsonl",
            "projects/./5b2c9e10-0000-4000-8000-00000000c1de.jsonl",
            "projects//5b2c9e10-0000-4000-8000-00000000c1de.jsonl",
            "projects/a/b/5b2c9e10-0000-4000-8000-00000000c1de.jsonl",
            "sessions/7.json",
            "projects/-home-ben-repo/notes.jsonl",
            "projects/-home-ben-repo/5B2C9E10-0000-4000-8000-00000000C1DE.jsonl",
            "projects/-home-ben-repo/5b2c9e10-0000-4000-8000-00000000c1de.json",
            "/home/maya/.claude/projects/x/5b2c9e10-0000-4000-8000-00000000c1de.jsonl",
            "",
        ] {
            assert!(ok(path, "2.1.291").validate(&claude).is_err(), "{path}");
        }
    }
}
