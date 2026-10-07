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
pub fn admission_for_peer(
    uid: u32,
    cgroups: &str,
    sessions: &dyn Sessions,
) -> Result<crate::broker::sessions::Admission, Error> {
    if uid != 19999 || cgroups.len() > 4096 {
        return Err(unauthorized());
    }
    let mut unified = cgroups.lines().filter_map(|line| line.strip_prefix("0::"));
    let path = unified.next().ok_or_else(unauthorized)?;
    if unified.next().is_some() || !path.starts_with("/smithers/sessions/") || path.contains("..") {
        return Err(unauthorized());
    }
    sessions.admission_of_cgroup(path).ok_or_else(unauthorized)
}
/// The local wire keeps ADR 0004 args6, but the peer cannot select an identity
/// or kind. Only an agent PTY can enter the dedicated broker-local operation.
pub fn validate_open(args: &[u8]) -> Result<(), Error> {
    use crate::broker::{request::Request, sessions::Kind};
    match Request::decode(6, args) {
        Ok(Request::Open {
            user,
            kind: Kind::Pty,
            admission: None,
            ..
        }) if user.uid == 19999 && user.login == "agent" => Ok(()),
        _ => Err(unauthorized()),
    }
}
fn unified_cgroup(groups: &str) -> Option<&str> {
    let mut paths = groups.lines().filter_map(|line| line.strip_prefix("0::"));
    let path = paths.next()?;
    if paths.next().is_some() {
        return None;
    }
    Some(path)
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
    let run = admission_for_peer(peer.uid.as_raw(), &groups, sessions)
        .map_err(|_| io::ErrorKind::PermissionDenied)?;
    let frame = Frame::read_envelope(&mut socket).map_err(io::Error::other)?;
    if let Err(e) = frame.validate(true) {
        return crate::rpc::malformed_response(&frame, e)
            .map_err(io::Error::other)?
            .write(&mut socket);
    }
    let (id, method, args) = frame.request().map_err(io::Error::other)?;
    if method == 6 && validate_open(args).is_err() {
        return daemon::refused(id, unauthorized()).write(&mut socket);
    }
    let open = (method == 6).then(|| args.to_vec());
    let write = if method == 3 {
        Some(conn::local_write_args(args, run.principal).map_err(io::Error::other)?)
    } else {
        None
    };
    let batch = if method == 17 {
        Some(conn::local_batch_write_args(args, run.principal).map_err(io::Error::other)?)
    } else {
        None
    };
    let stream_ready = ready.clone();
    let stream_groups = groups.clone();
    let stream_run = run.clone();
    let response = lock
        .run_blocking("local_rpc", move |cx| {
            // Recheck after queueing: revocation can happen while this request waits
            // behind a capture or rewrite. The original cgroup grants no lease.
            if !ready()
                || admission_for_peer(peer.uid.as_raw(), &groups, &*cx.hooks.sessions)
                    .ok()
                    .as_ref()
                    != Some(&run)
            {
                return Ok(daemon::refused(id, unauthorized()));
            }
            if cx.rewrite_pending && matches!(method, 3 | 17) {
                return Ok(daemon::refused(id, crate::freeze::pending_error()));
            }
            match method {
                3 => Ok(match files.write(cx, write.unwrap()) {
                    Ok(body) => daemon::response(id, 3, body),
                    Err(e) => daemon::refused(id, e),
                }),
                17 => {
                    let (changes, actor) = batch.unwrap();
                    Ok(match files.write_batch(cx, changes, actor) {
                        Ok(body) => daemon::response(id, 17, body),
                        Err(e) => daemon::refused(id, e),
                    })
                }
                6 => {
                    if cx.rewrite_pending {
                        return Ok(daemon::refused(id, crate::freeze::pending_error()));
                    }
                    let path =
                        unified_cgroup(&groups).ok_or(crate::conn::ProtocolError::BadValue)?;
                    Ok(match cx.hooks.sessions.open_local(path, &open.unwrap()) {
                        Ok(body) => daemon::response(id, 6, body),
                        Err(e) => daemon::refused(id, e),
                    })
                }
                2 => crate::rpc::dispatch(&frame, cx),
                _ => Ok(daemon::refused(id, Error::unsupported())),
            }
        })
        .map_err(|_| io::Error::other("mutation executor stopped"))?
        .map_err(io::Error::other)?;
    response.write(&mut socket)?;
    if method != 6 {
        return Ok(());
    }
    let fields = conn::fields("response", &response.payload[1..]).map_err(io::Error::other)?;
    let value = fields[1].1;
    if value.first() != Some(&6) {
        return Ok(());
    }
    let fields = conn::fields("result6", &value[1..]).map_err(io::Error::other)?;
    let session = u32::from_be_bytes(
        fields[0]
            .1
            .try_into()
            .map_err(|_| io::ErrorKind::InvalidData)?,
    );
    crate::local_stream::serve(
        socket,
        session,
        lock.clone(),
        Arc::new(move |cx| {
            stream_ready()
                && admission_for_peer(19999, &stream_groups, &*cx.hooks.sessions)
                    .ok()
                    .as_ref()
                    == Some(&stream_run)
        }),
    )
}
