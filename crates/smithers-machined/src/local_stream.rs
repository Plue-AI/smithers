//! Multiplexed agent-local PTY transport after kernel admission. A socket owns
//! exactly one stream; it cannot send host RPCs or drain another session's output.
use crate::{
    conn::Frame,
    lock::{Lock, LockCx},
};
use std::{
    io,
    os::unix::net::UnixStream,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

pub fn serve(
    mut socket: UnixStream,
    session: u32,
    lock: Lock,
    authorized: Arc<dyn Fn(&LockCx) -> bool + Send + Sync>,
) -> io::Result<()> {
    if session == 0 || session > 0x7fff_ffff {
        return Err(io::ErrorKind::InvalidData.into());
    }
    // A timeout partway through a frame cannot be retried as a new envelope.
    // The writer interrupts a silent reader when authorization is revoked.
    socket.set_read_timeout(None)?;
    socket.set_write_timeout(Some(Duration::from_secs(5)))?;
    let output = Arc::new(Mutex::new(socket.try_clone()?));
    let receipts = output.clone();
    let finished = Arc::new(AtomicBool::new(false));
    let stopping = finished.clone();
    let output_lock = lock.clone();
    let output_authorized = authorized.clone();
    let writer = std::thread::spawn(move || {
        let result = (|| {
            while !stopping.load(Ordering::Acquire) {
                let check = output_authorized.clone();
                let mut output_socket = output
                    .lock()
                    .map_err(|_| io::Error::other("writer poisoned"))?;
                let frames = output_lock
                    .run_blocking("local_session_poll", move |cx| {
                        if !check(cx) {
                            return Err(crate::hooks::Error::unsupported());
                        }
                        cx.hooks.sessions.poll_local(session)
                    })
                    .map_err(|_| io::Error::other("mutation executor stopped"))?
                    .map_err(|_| io::Error::other("session unavailable"))?;
                for frame in frames {
                    if frame.kind != 5 || frame.stream != session {
                        return Err(io::ErrorKind::InvalidData.into());
                    }
                    frame.write(&mut *output_socket)?;
                    if matches!(frame.payload.first(), Some(5 | 7)) {
                        return Ok(true);
                    }
                }
                drop(output_socket);
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(false)
        })();
        if let Ok(socket) = output.lock() {
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
        result
    });
    let result = (|| loop {
        let frame = Frame::read_envelope(&mut socket).map_err(io::Error::other)?;
        frame.validate(false).map_err(io::Error::other)?;
        if frame.kind != 5 || frame.stream != session {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let close = frame.payload.first() == Some(&7);
        let check = authorized.clone();
        let mut receipt_socket = receipts
            .lock()
            .map_err(|_| io::Error::other("writer poisoned"))?;
        let response = lock
            .run_blocking("local_session_input", move |cx| {
                if !check(cx) {
                    return Err(crate::hooks::Error::unsupported());
                }
                cx.hooks.sessions.frame_local(&frame)
            })
            .map_err(|_| io::Error::other("mutation executor stopped"))?
            .map_err(|_| io::Error::other("session input refused"))?;
        // Session providers return their input receipt here, just as on the host
        // connection. Output remains exclusively on the scoped polling path.
        if let Some(response) = response {
            if response.kind != 5 || response.stream != session {
                return Err(io::ErrorKind::InvalidData.into());
            }
            response.write(&mut *receipt_socket)?;
        }
        if close {
            return Ok(());
        }
    })();
    finished.store(true, Ordering::Release);
    let _ = socket.shutdown(std::net::Shutdown::Both);
    let output_result = writer
        .join()
        .map_err(|_| io::Error::other("session writer panicked"))?;
    // Close only this socket's admitted stream. The broker retains its cgroup
    // for lingering descendants; this is not a kill or a user/run selector.
    let cleanup = lock
        .run_blocking("local_session_close", move |cx| {
            cx.hooks.sessions.call(
                8,
                &crate::conn::structure_bytes(&[crate::conn::field(1, session.to_be_bytes())]),
            )
        })
        .map_err(|_| io::Error::other("mutation executor stopped"))?
        .map_err(|_| io::Error::other("session close failed"));
    cleanup?;
    // EOF caused by a normal exit frame is a successful terminal completion.
    match output_result {
        Ok(true) => Ok(()),
        Ok(false) => result,
        Err(error) => Err(error),
    }
}
