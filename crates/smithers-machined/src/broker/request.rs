//! Typed session commands at the privileged socketpair boundary. The shared
//! wire schema checks lengths/fields first; semantic checks precede any provider
//! call. The provider must additionally authorize against its current roster.
use super::sessions::{Kind, User};
use crate::conn;
use std::io;

#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    Open {
        user: User,
        kind: Kind,
        argv: Vec<String>,
        size: Option<(u16, u16)>,
    },
    Tcp(u16),
    Close(u32),
    KillUser(User),
    KillRun(String),
    Register {
        run: String,
        session: u32,
    },
    Attach {
        session: u32,
        received: u64,
    },
    Roster(Vec<User>),
}
fn invalid() -> io::Error {
    io::ErrorKind::InvalidInput.into()
}
fn string(bytes: &[u8]) -> io::Result<String> {
    // Only called on values already validated by the shared schema.
    let value = std::str::from_utf8(&bytes[2..]).map_err(|_| invalid())?;
    if value.contains('\0') {
        return Err(invalid());
    }
    Ok(value.to_owned())
}
fn user(bytes: &[u8]) -> io::Result<User> {
    let fields = conn::fields("user", bytes).map_err(|_| invalid())?;
    let user = User {
        login: string(fields[0].1)?,
        uid: u32::from_be_bytes(fields[1].1.try_into().unwrap()),
    };
    user.validate()?;
    Ok(user)
}
fn id(bytes: &[u8]) -> io::Result<u32> {
    let value = u32::from_be_bytes(bytes.try_into().map_err(|_| invalid())?);
    if value == 0 || value > 0x7fffffff {
        return Err(invalid());
    }
    Ok(value)
}
fn run(bytes: &[u8]) -> io::Result<String> {
    let value = string(bytes)?;
    if value.is_empty() {
        return Err(invalid());
    }
    Ok(value)
}
impl Request {
    pub fn decode(method: u8, bytes: &[u8]) -> io::Result<Self> {
        if !matches!(method, 6..=10 | 15 | 16) || bytes.len() > 65527 {
            return Err(invalid());
        }
        let fields = conn::fields(&format!("args{method}"), bytes).map_err(|_| invalid())?;
        Ok(match method {
            6 => {
                let user = user(fields[0].1)?;
                let kind = match fields[1].1[0] {
                    1 => Kind::Pty,
                    2 => Kind::Exec,
                    3 => Kind::Sftp,
                    _ => return Err(invalid()),
                };
                let mut argv = vec![];
                let mut size = None;
                for (tag, bytes) in &fields[2..] {
                    if *tag == 3 {
                        let mut rest = &bytes[2..];
                        while !rest.is_empty() {
                            let n = u16::from_be_bytes(rest[..2].try_into().unwrap()) as usize;
                            argv.push(string(&rest[..n + 2])?);
                            rest = &rest[n + 2..];
                        }
                    } else {
                        let size_fields = conn::fields("size", bytes).map_err(|_| invalid())?;
                        let cols = u16::from_be_bytes(size_fields[0].1.try_into().unwrap());
                        let rows = u16::from_be_bytes(size_fields[1].1.try_into().unwrap());
                        if rows == 0 || cols == 0 {
                            return Err(invalid());
                        }
                        size = Some((rows, cols));
                    }
                }
                if argv.first().is_some_and(String::is_empty)
                    || (kind == Kind::Exec && argv.is_empty())
                    || (kind == Kind::Sftp && !argv.is_empty())
                    || (kind != Kind::Pty && size.is_some())
                {
                    return Err(invalid());
                }
                Self::Open {
                    user,
                    kind,
                    argv,
                    size,
                }
            }
            7 => {
                let port = u16::from_be_bytes(fields[0].1.try_into().unwrap());
                if port == 0 {
                    return Err(invalid());
                }
                Self::Tcp(port)
            }
            8 => Self::Close(id(fields[0].1)?),
            9 => {
                let target = fields[0].1;
                if target[0] == 1 {
                    let fields =
                        conn::fields("target_user", &target[1..]).map_err(|_| invalid())?;
                    Self::KillUser(user(fields[0].1)?)
                } else {
                    let fields = conn::fields("run_actor", &target[1..]).map_err(|_| invalid())?;
                    Self::KillRun(run(fields[0].1)?)
                }
            }
            10 => Self::Register {
                run: run(fields[0].1)?,
                session: id(fields[1].1)?,
            },
            15 => Self::Attach {
                session: id(fields[0].1)?,
                received: u64::from_be_bytes(fields[1].1.try_into().unwrap()),
            },
            16 => {
                let members = conn::roster_args(bytes).map_err(|_| invalid())?;
                let mut uids = std::collections::BTreeSet::new();
                let mut logins = std::collections::BTreeSet::new();
                for member in &members {
                    member.validate()?;
                    if member.uid == 19999
                        || !uids.insert(member.uid)
                        || !logins.insert(&member.login)
                    {
                        return Err(invalid());
                    }
                }
                Self::Roster(members)
            }
            _ => unreachable!(),
        })
    }
}

pub fn roster_bytes(members: &[User]) -> io::Result<Vec<u8>> {
    let count = u16::try_from(members.len()).map_err(|_| invalid())?;
    let mut list = count.to_be_bytes().to_vec();
    for member in members {
        member.validate()?;
        list.extend(conn::structure_bytes(&[
            conn::field(
                1,
                [
                    (member.login.len() as u16).to_be_bytes().as_slice(),
                    member.login.as_bytes(),
                ]
                .concat(),
            ),
            conn::field(2, member.uid.to_be_bytes()),
        ]));
    }
    let bytes = conn::structure_bytes(&[conn::field(1, list)]);
    Request::decode(16, &bytes)?;
    Ok(bytes)
}
