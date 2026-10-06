//! Agent-only socket admission. The kernel peer and registered cgroup determine
//! the run; request bytes cannot select one or register a new run.
use crate::{
    conn::{self, Frame},
    daemon,
    files::Files,
    hooks::{Error, Sessions},
    lock::Lock,
};
use std::{
    io::{self, Read},
    os::unix::net::UnixStream,
    sync::Arc,
    time::Duration,
};
fn unauthorized() -> Error {
    Error {
        code: 11,
        ..Error::unsupported()
    }
}
pub fn run_for_peer(uid: u32, cgroups: &str, sessions: &dyn Sessions) -> Result<String, Error> {
    if uid != 19999 || cgroups.len() > 4096 {
        return Err(unauthorized());
    }
    let mut unified = cgroups.lines().filter_map(|line| line.strip_prefix("0::"));
    let path = unified.next().ok_or_else(unauthorized)?;
    if unified.next().is_some() || !path.starts_with("/smithers/sessions/") || path.contains("..") {
        return Err(unauthorized());
    }
    sessions.run_of_cgroup(path).ok_or_else(unauthorized)
}
pub fn serve(
    mut socket: UnixStream,
    ready: Arc<dyn Fn() -> bool + Send + Sync>,
    sessions: &dyn Sessions,
    lock: &Lock,
    files: Arc<Files>,
) -> io::Result<()> {
    if !ready() {
        return Ok(());
    }
    socket.set_read_timeout(Some(Duration::from_secs(5)))?;
    socket.set_write_timeout(Some(Duration::from_secs(5)))?;
    let peer = rustix::net::sockopt::socket_peercred(&socket)?;
    if peer.uid.as_raw() != 19999 {
        return Ok(());
    }
    let mut groups = String::new();
    std::fs::File::open(format!("/proc/{}/cgroup", peer.pid.as_raw_nonzero()))?
        .take(4097)
        .read_to_string(&mut groups)?;
    let run = run_for_peer(peer.uid.as_raw(), &groups, sessions)
        .map_err(|_| io::ErrorKind::PermissionDenied)?;
    let frame = Frame::read_envelope(&mut socket).map_err(io::Error::other)?;
    if let Err(e) = frame.validate(true) {
        return crate::rpc::malformed_response(&frame, e)
            .map_err(io::Error::other)?
            .write(&mut socket);
    }
    let (id, method, args) = frame.request().map_err(io::Error::other)?;
    let write = if method == 3 {
        Some(conn::local_write_args(args, run.clone()).map_err(io::Error::other)?)
    } else {
        None
    };
    let response = lock
        .run_blocking("local_rpc", move |cx| {
            // Recheck after queueing: revocation can happen while this request waits
            // behind a capture or rewrite. The original cgroup grants no lease.
            if !ready()
                || run_for_peer(peer.uid.as_raw(), &groups, &*cx.hooks.sessions)
                    .ok()
                    .as_ref()
                    != Some(&run)
            {
                return Ok(daemon::refused(id, unauthorized()));
            }
            match method {
                3 => Ok(match files.write(cx, write.unwrap()) {
                    Ok(body) => daemon::response(id, 3, body),
                    Err(e) => daemon::refused(id, e),
                }),
                2 => crate::rpc::dispatch(&frame, cx),
                _ => Ok(daemon::refused(id, Error::unsupported())),
            }
        })
        .map_err(|_| io::Error::other("mutation executor stopped"))?
        .map_err(io::Error::other)?;
    response.write(&mut socket)
}
