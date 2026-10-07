//! Broker-owned registry, reconnect grace and confirmed cgroup cleanup.
//! No request selects a cgroup path or a pid. Entries survive process exit and
//! close so background children remain attributable and revocable.
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::time::{Duration, Instant};

pub const GRACE: Duration = Duration::from_secs(30);
pub const KILL_DEADLINE: Duration = Duration::from_secs(5);
pub const MAX_SESSIONS: usize = 512;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct User {
    pub login: String,
    pub uid: u32,
}
impl User {
    pub fn validate(&self) -> io::Result<()> {
        if self.login.is_empty()
            || self.login.len() > 32
            || !self
                .login
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
            || matches!(self.login.as_str(), "root" | "machined")
            || if self.login == "agent" {
                self.uid != 19999
            } else {
                !(20000..=2147483647).contains(&self.uid)
            }
        {
            return Err(refusal("invalid session user"));
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Kind {
    Pty,
    Exec,
    Sftp,
    Tcp,
}
/// Host-committed attribution. The local socket inherits this entire binding;
/// it cannot supply a reference or change the run. It grants no roster access.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Admission {
    pub principal: [u8; 16],
    pub run: Option<String>,
}
impl Admission {
    pub fn validate(&self, user: &User, kind: Kind) -> io::Result<()> {
        if self.principal == [0; 16]
            || self.run.as_ref().is_some_and(|r| {
                r.is_empty() || r.len() > 4096 || r.contains('\0') || r.trim() != r
            })
            || (user.uid != 19999 && self.run.is_some())
            || (user.uid == 19999 && kind != Kind::Tcp && self.run.is_none())
        {
            return Err(refusal("invalid session attribution"));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Entry {
    pub id: u32,
    pub user: User,
    pub kind: Kind,
    pub run: Option<String>,
    #[serde(default)]
    pub principal: [u8; 16],
    pub closed: bool,
    pub exited: bool,
}
impl Entry {
    pub fn cgroup(&self) -> String {
        format!("/sys/fs/cgroup/smithers/sessions/s{}", self.id)
    }
}
fn refusal(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// Implemented by the root process with held descriptors. `kill` must return
/// only after populated=0; it shares one deadline across the whole selector.
/// `close` sends PTY HUP or closes stdin, never destroys a lingering cgroup.
pub trait Controls {
    fn close(&mut self, id: u32, kind: Kind) -> io::Result<()>;
    fn kill(&mut self, id: u32, deadline: Instant) -> io::Result<()>;
}

pub struct Sessions<C> {
    entries: BTreeMap<u32, Entry>,
    controls: C,
    detached: BTreeMap<u32, Instant>,
    fenced: BTreeSet<u32>,
    roster: Option<BTreeMap<u32, String>>,
    roster_ready: bool,
}
impl<C: Controls> Sessions<C> {
    pub fn new(controls: C) -> Self {
        Self {
            entries: BTreeMap::new(),
            controls,
            detached: BTreeMap::new(),
            fenced: BTreeSet::new(),
            roster: None,
            roster_ready: false,
        }
    }
    /// The authenticated host supplies the entire current roster before ready.
    /// Install the restriction before cleanup: a failed kill must never leave
    /// the revoked identity authorized to spawn or reattach. Retrying the same
    /// roster completes cleanup of any still-populated cgroups.
    pub fn set_roster(&mut self, members: &[User], now: Instant) -> io::Result<()> {
        let mut roster = BTreeMap::new();
        let mut logins = std::collections::BTreeSet::new();
        for member in members {
            member.validate()?;
            if member.uid == 19999
                || roster.insert(member.uid, member.login.clone()).is_some()
                || !logins.insert(member.login.clone())
            {
                return Err(refusal("invalid or duplicate roster member"));
            }
        }
        self.roster = Some(roster.clone());
        self.roster_ready = false;
        self.kill_matching(
            |entry| {
                entry.user.uid != 19999 && roster.get(&entry.user.uid) != Some(&entry.user.login)
            },
            now,
        )?;
        self.roster_ready = true;
        Ok(())
    }
    /// Call before any account creation, fork or cgroup allocation, and again
    /// when recording the spawn. Agent is an image identity, never a member.
    pub fn authorize(&self, user: &User) -> io::Result<()> {
        user.validate()?;
        if !self.roster_ready {
            return Err(refusal("roster cleanup incomplete"));
        }
        let roster = self
            .roster
            .as_ref()
            .ok_or_else(|| refusal("roster not synchronized"))?;
        if user.uid != 19999 && roster.get(&user.uid) != Some(&user.login) {
            return Err(refusal("session user is not in roster"));
        }
        Ok(())
    }
    /// Reserve ownership after trusted account binding and BEFORE cgroup spawn.
    /// Stream allocation is owned by the shared daemon allocator, not this map.
    pub fn insert(
        &mut self,
        id: u32,
        user: User,
        kind: Kind,
        admission: Admission,
    ) -> io::Result<()> {
        self.authorize(&user)?;
        admission.validate(&user, kind)?;
        if id == 0
            || id > 0x7fffffff
            || self.entries.contains_key(&id)
            || self.entries.len() >= MAX_SESSIONS
        {
            return Err(refusal("invalid or occupied session id"));
        }
        self.entries.insert(
            id,
            Entry {
                id,
                user,
                kind,
                run: admission.run,
                principal: admission.principal,
                closed: false,
                exited: false,
            },
        );
        Ok(())
    }
    /// Record an agent-local PTY with its caller's immutable run in the same
    /// registry mutation. No observer can see an admitted but unattributed PTY.
    /// Reserve before spawning, under the broker's serialization boundary.
    pub fn insert_local(&mut self, id: u32, peer_uid: u32, caller: u32) -> io::Result<()> {
        let admission = self.local_admission(peer_uid, caller)?;
        self.insert(
            id,
            User {
                login: "agent".into(),
                uid: 19999,
            },
            Kind::Pty,
            admission,
        )?;
        Ok(())
    }
    /// A failed launch may have forked before descriptor setup failed. Fence
    /// its authority immediately, but retain ownership until cleanup confirms
    /// that no children survive. A later kill/revocation/restart retries it.
    pub(super) fn abort_spawn(&mut self, id: u32, now: Instant) -> io::Result<()> {
        self.entries
            .get_mut(&id)
            .ok_or_else(|| refusal("unknown session"))?
            .closed = true;
        self.fenced.insert(id);
        self.kill_matching(|entry| entry.id == id, now)?;
        Ok(())
    }
    pub(super) fn admission_fenced(&self, id: u32) -> bool {
        self.fenced.contains(&id)
    }
    pub fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.entries.values()
    }
    pub fn register_run(&mut self, id: u32, run: &str) -> io::Result<()> {
        if run.is_empty() || run.len() > 4096 || run.contains('\0') {
            return Err(refusal("invalid run"));
        }
        let entry = self
            .entries
            .get_mut(&id)
            .ok_or_else(|| refusal("unknown session"))?;
        if entry.user.uid != 19999 || entry.closed || entry.exited {
            return Err(refusal("run requires a live agent session"));
        }
        // Retained request decoding is allowed; late binding is not. A live
        // run was admitted before spawn and this can only confirm that binding.
        if entry.run.as_deref() != Some(run) {
            return Err(refusal("run binding is immutable"));
        }
        Ok(())
    }
    /// The daemon derives this id from the local peer's kernel cgroup, never
    /// from a request's actor or user fields.
    pub fn local_run(&self, peer_uid: u32, caller_session: u32) -> io::Result<&str> {
        if peer_uid != 19999 || self.fenced.contains(&caller_session) {
            return Err(refusal("local caller is not agent"));
        }
        let entry = self
            .entries
            .get(&caller_session)
            .filter(|e| e.user.uid == peer_uid)
            .ok_or_else(|| refusal("caller is outside a registered run"))?;
        // Retained cgroups remain attributable during failed roster cleanup,
        // but must not grant local mutation authority while admission is fenced.
        self.authorize(&entry.user)?;
        entry
            .run
            .as_deref()
            .ok_or_else(|| refusal("caller is outside a registered run"))
    }
    pub fn local_admission(&self, peer_uid: u32, caller: u32) -> io::Result<Admission> {
        let run = self.local_run(peer_uid, caller)?.to_owned();
        let entry = self
            .entries
            .get(&caller)
            .ok_or_else(|| refusal("unknown caller"))?;
        let admission = Admission {
            principal: entry.principal,
            run: Some(run),
        };
        admission.validate(&entry.user, entry.kind)?;
        Ok(admission)
    }
    pub fn exited(&mut self, id: u32) -> io::Result<()> {
        self.entries
            .get_mut(&id)
            .ok_or_else(|| refusal("unknown session"))?
            .exited = true;
        Ok(())
    }
    pub fn close(&mut self, id: u32) -> io::Result<()> {
        let entry = self
            .entries
            .get_mut(&id)
            .ok_or_else(|| refusal("unknown session"))?;
        if !entry.closed {
            self.controls.close(id, entry.kind)?;
            entry.closed = true;
        }
        Ok(())
    }
    fn kill_matching(&mut self, matches: impl Fn(&Entry) -> bool, now: Instant) -> io::Result<u16> {
        let ids: Vec<_> = self
            .entries
            .values()
            .filter(|e| matches(e))
            .map(|e| e.id)
            .collect();
        let deadline = now + KILL_DEADLINE;
        let mut killed = 0;
        for id in ids {
            // Failed cleanup keeps this and subsequent entries for retry.
            self.controls.kill(id, deadline)?;
            self.entries.remove(&id);
            self.detached.remove(&id);
            self.fenced.remove(&id);
            killed += 1;
        }
        Ok(killed)
    }
    pub fn kill_user(&mut self, user: &User, now: Instant) -> io::Result<u16> {
        user.validate()?;
        self.kill_matching(|e| &e.user == user, now)
    }
    pub fn kill_run(&mut self, run: &str, now: Instant) -> io::Result<u16> {
        if run.is_empty() || run.len() > 4096 || run.contains('\0') {
            return Err(refusal("invalid run"));
        }
        self.kill_matching(|e| e.run.as_deref() == Some(run), now)
    }
    /// A command cancellation targets one owned cgroup, not its siblings in
    /// the run. Retain identity and deny further use until cleanup is confirmed.
    /// An already reaped id returns zero, so a lost success reply is retryable.
    pub fn kill_session(&mut self, id: u32, now: Instant) -> io::Result<u16> {
        if id == 0 || id > 0x7fffffff {
            return Err(refusal("invalid session"));
        }
        if let Some(entry) = self.entries.get_mut(&id) {
            entry.closed = true;
            self.fenced.insert(id);
        }
        self.kill_matching(|entry| entry.id == id, now)
    }
    pub fn disconnected(&mut self, now: Instant) {
        // Repeated disconnect notifications must not extend any session's grace.
        for entry in self.entries.values().filter(|e| !e.closed) {
            self.detached.entry(entry.id).or_insert(now);
        }
    }
    /// Call after validating both stream replay offsets. A successful transport
    /// reconnect does not reattach sessions the host omitted.
    pub fn check_attach(&self, id: u32, now: Instant) -> io::Result<()> {
        let user = &self
            .entries
            .get(&id)
            .ok_or_else(|| refusal("unknown session"))?
            .user;
        self.authorize(user)?;
        if self
            .detached
            .get(&id)
            .is_some_and(|start| now.saturating_duration_since(*start) >= GRACE)
        {
            return Err(refusal("reattachment grace expired"));
        }
        let entry = self
            .entries
            .get(&id)
            .ok_or_else(|| refusal("unknown session"))?;
        if entry.closed {
            return Err(refusal("session closed"));
        }
        Ok(())
    }
    pub fn attach(&mut self, id: u32, now: Instant) -> io::Result<()> {
        self.check_attach(id, now)?;
        self.detached.remove(&id);
        Ok(())
    }
    pub fn expire(&mut self, now: Instant) -> io::Result<()> {
        let ids: Vec<_> = self
            .detached
            .iter()
            .filter(|(_, start)| now.saturating_duration_since(**start) >= GRACE)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.close(id)?;
            self.detached.remove(&id);
        }
        Ok(())
    }
    /// Startup must not restart the daemon until this succeeds. A failed kill
    /// retains the cgroup registry and keeps restart refused.
    pub fn before_restart(&mut self, now: Instant) -> io::Result<()> {
        self.kill_matching(|_| true, now)?;
        self.detached.clear();
        Ok(())
    }
}

/// Decode only canonical broker cgroup names. Decimal names are retained-state
/// compatibility for cleanup of older installs; newly allocated groups use s<id>.
pub fn cgroup_id(name: &str) -> io::Result<u32> {
    let decimal = name.strip_prefix('s').unwrap_or(name);
    let id: u32 = decimal.parse().map_err(|_| refusal("invalid cgroup id"))?;
    if id == 0 || id > 0x7fff_ffff || decimal != id.to_string() {
        return Err(refusal("invalid cgroup id"));
    }
    Ok(id)
}
