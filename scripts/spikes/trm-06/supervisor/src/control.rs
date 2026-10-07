//! Authenticated installed relay dispatch. The boot-authentication provider
//! must finish mutual authentication before calling serve; main cannot call it.
use crate::live::Live;
use crate::protocol::Frame;
use crate::registry::{Kind, Owner, Registry, Selector};
use crate::runtime::{Kernel, validate_open};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    OpenSession {
        kind: String,
        #[serde(default)]
        argv: Vec<String>,
        #[serde(default)]
        cols: u16,
        #[serde(default)]
        rows: u16,
        #[serde(default)]
        port: u16,
    },
    AttachSession {
        id: String,
        received: u64,
    },
    CloseSession {
        id: String,
    },
    KillSessions {},
    Restart {},
}
#[derive(Serialize)]
#[serde(untagged)]
enum Response {
    Open {
        session: String,
    },
    Attach {
        session: String,
        received: u64,
    },
    Ok {
        ok: bool,
    },
    Error {
        class: &'static str,
        code: &'static str,
    },
}
pub struct Supervisor {
    registry: Registry<Kernel>,
    live: BTreeMap<String, Arc<Live>>,
}
fn refused() -> io::Error {
    io::Error::other("invalid authenticated session control")
}
impl Supervisor {
    pub fn installed() -> io::Result<Self> {
        Ok(Self {
            registry: Kernel::open()?,
            live: BTreeMap::new(),
        })
    }
    fn open(
        &mut self,
        kind: String,
        argv: Vec<String>,
        cols: u16,
        rows: u16,
        port: u16,
    ) -> io::Result<(String, Arc<Live>)> {
        let kind = match kind.as_str() {
            "pty" => Kind::Pty,
            "exec" => Kind::Exec,
            "sftp" => Kind::Sftp,
            "tcp" => Kind::Tcp,
            _ => return Err(refused()),
        };
        validate_open(kind, &argv, (cols, rows), port)?;
        let id = self.registry.reserve(Owner::Ben, kind, None)?;
        match self
            .registry
            .resources()
            .spawn(&id, Owner::Ben, kind, &argv, (cols, rows), port)
        {
            Ok(live) => {
                self.live.insert(id.clone(), live.clone());
                Ok((id, live))
            }
            Err(error) => {
                self.registry.abort(&id)?;
                Err(error)
            }
        }
    }
}
/// Bounded control decoding refuses caller-selected uid/run/cgroup/env/cwd and
/// duplicate fields before spawning, filesystem resolution or session lookup.
pub fn read_request(reader: &mut impl Read) -> io::Result<Request> {
    let mut length = [0; 4];
    reader.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > 65536 {
        return Err(refused());
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(|_| refused())
}
fn response(writer: &mut impl Write, response: Response) -> io::Result<()> {
    let bytes = serde_json::to_vec(&response).map_err(|_| refused())?;
    writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
    writer.write_all(&bytes)
}
/// One installed, mutually authenticated relay connection per control operation
/// or attached session stream. No direct TCP fallback exists in the gateway.
pub fn serve(mut stream: TcpStream, supervisor: Arc<Mutex<Supervisor>>) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let request = read_request(&mut stream)?;
    let result = (|| -> io::Result<Option<(String, Arc<Live>, u64)>> {
        let mut supervisor = supervisor.lock().map_err(|_| refused())?;
        match request {
            Request::OpenSession {
                kind,
                argv,
                cols,
                rows,
                port,
            } => {
                let (id, live) = supervisor.open(kind, argv, cols, rows, port)?;
                response(
                    &mut stream,
                    Response::Open {
                        session: id.clone(),
                    },
                )?;
                Ok(Some((id, live, 0)))
            }
            Request::AttachSession { id, received } => {
                let live = supervisor.live.get(&id).ok_or_else(refused)?.clone();
                let now = Instant::now();
                // Validate replay before consuming either grace state.
                live.replay(received)?;
                supervisor.registry.attach(Owner::Ben, &id, now)?;
                let input_received = live.attach(received, now)?;
                response(
                    &mut stream,
                    Response::Attach {
                        session: id.clone(),
                        received: input_received,
                    },
                )?;
                Ok(Some((id, live, received)))
            }
            Request::CloseSession { id } => {
                supervisor.registry.close(Owner::Ben, &id)?;
                response(&mut stream, Response::Ok { ok: true })?;
                Ok(None)
            }
            Request::KillSessions {} => {
                supervisor.registry.kill(Selector::User(Owner::Ben))?;
                supervisor.live.clear();
                response(&mut stream, Response::Ok { ok: true })?;
                Ok(None)
            }
            Request::Restart {} => {
                supervisor.registry.restart()?;
                supervisor.live.clear();
                response(&mut stream, Response::Ok { ok: true })?;
                Ok(None)
            }
        }
    })();
    let session = match result {
        Ok(session) => session,
        Err(error) => {
            response(
                &mut stream,
                Response::Error {
                    class: "invalid",
                    code: "session_refused",
                },
            )?;
            return Err(error);
        }
    };
    if let Some((id, live, received)) = session {
        stream.set_read_timeout(None)?;
        let result = pump(&mut stream, live.clone(), received);
        // A failed/dropped relay keeps its bounded replay for the 30 s grace.
        let now = Instant::now();
        live.detach(now)?;
        supervisor
            .lock()
            .map_err(|_| refused())?
            .registry
            .detach(Owner::Ben, &id, now)?;
        result
    } else {
        Ok(())
    }
}
fn pump(stream: &mut TcpStream, live: Arc<Live>, mut received: u64) -> io::Result<()> {
    let mut input = stream.try_clone()?;
    let output = stream.try_clone()?;
    let reading = live.clone();
    let reader = std::thread::spawn(move || {
        let result = (|| -> io::Result<()> {
            loop {
                let frame = Frame::read(&mut input)?;
                let closed = matches!(frame, Frame::Close {});
                reading.receive(frame)?;
                if closed {
                    return Ok(());
                }
            }
        })();
        let _ = input.shutdown(Shutdown::Both);
        result
    });
    let mut eof_sent = [false; 3];
    let result = (|| -> io::Result<()> {
        loop {
            if live.is_closed()? {
                Frame::Close {}.write(stream)?;
                return Ok(());
            }
            if reader.is_finished() {
                return Ok(());
            }
            if let Some(window) = live.take_credit()? {
                window.write(stream)?;
            }
            let frames = live.replay(received)?;
            // EOF metadata stays in the journal for reattachment. Within this attached
            // transport emit it once, in sequence, before the first-process exit.
            for frame in frames {
                match &frame {
                    Frame::Data { bytes, .. } => {
                        frame.write(stream)?;
                        received += bytes.len() as u64;
                    }
                    Frame::Eof { stream: direction } => {
                        if !eof_sent[*direction as usize] {
                            frame.write(stream)?;
                            eof_sent[*direction as usize] = true;
                        }
                    }
                    Frame::Exit { .. } | Frame::ExitSignal { .. } => {
                        frame.write(stream)?;
                        return Ok(());
                    }
                    _ => return Err(refused()),
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    })();
    let _ = output.shutdown(Shutdown::Both);
    let _ = reader.join();
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticated_control_refuses_identity_and_path_injection() {
        for body in [
            r#"{"type":"open_session","kind":"exec","uid":0}"#,
            r#"{"type":"open_session","kind":"exec","kind":"pty"}"#,
            r#"{"type":"kill_sessions","user":"agent"}"#,
            r#"{"type":"close_session","id":"s-1","cgroup":"../agent"}"#,
            r#"{"type":"open_session","kind":"exec","env":{"PYTHONPATH":"/workspace"}}"#,
        ] {
            let mut bytes = (body.len() as u32).to_be_bytes().to_vec();
            bytes.extend(body.as_bytes());
            assert!(read_request(&mut &bytes[..]).is_err(), "{body}");
        }
        for body in [
            r#"{"type":"open_session","kind":"exec","argv":["/bin/sh","-c","exit 7"]}"#,
            r#"{"type":"kill_sessions"}"#,
            r#"{"type":"attach_session","id":"s-0000000000000001","received":12}"#,
        ] {
            let mut bytes = (body.len() as u32).to_be_bytes().to_vec();
            bytes.extend(body.as_bytes());
            read_request(&mut &bytes[..]).unwrap();
        }
        assert!(read_request(&mut &[0, 1, 0, 1][..]).is_err());
    }
}
