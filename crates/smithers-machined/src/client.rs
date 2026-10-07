//! The agent CLI uses ADR 0004 on the broker's local socket, not another codec.
use crate::conn::{self, Frame};
use std::io::{self, Read, Write};
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "invalid client request")
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(value: &str, n: usize) -> io::Result<Vec<u8>> {
    if value.len() != n * 2 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    (0..n)
        .map(|i| u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).map_err(|_| invalid()))
        .collect()
}
fn string(value: &str) -> io::Result<Vec<u8>> {
    if value.len() > 4096 || !crate::doc::disk::valid_path(value) {
        return Err(invalid());
    }
    let mut b = (value.len() as u16).to_be_bytes().to_vec();
    b.extend(value.as_bytes());
    Ok(b)
}
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for group in bytes.chunks(3) {
        let n = (u32::from(group[0]) << 16)
            | (u32::from(*group.get(1).unwrap_or(&0)) << 8)
            | u32::from(*group.get(2).unwrap_or(&0));
        out.push(ALPHABET[(n >> 18) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(if group.len() > 1 {
            ALPHABET[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if group.len() > 2 {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
pub fn request(args: &[String], input: &mut impl Read) -> io::Result<Frame> {
    if args.len() < 2 {
        return Err(invalid());
    }
    let mut fields = vec![conn::field(1, string(&args[1])?)];
    let method = match args[0].as_str() {
        "read-file" => {
            if args.len() == 4 && args[2] == "--at" {
                fields.push(conn::field(2, unhex(&args[3], 20)?));
            } else if args.len() != 2 {
                return Err(invalid());
            }
            2
        }
        "write-file" => {
            if args.len() != 4 || args[2] != "--base" {
                return Err(invalid());
            }
            let base = if args[3] == "absent" {
                conn::tagged(2, &[])
            } else {
                conn::tagged(1, &[conn::field(1, unhex(&args[3], 32)?)])
            };
            fields.push(conn::field(2, base));
            let mut bytes = Vec::new();
            input
                .take(conn::MAX_FILE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > conn::MAX_FILE_BYTES {
                return Err(invalid());
            }
            let mut content = (bytes.len() as u32).to_be_bytes().to_vec();
            content.extend(bytes);
            fields.push(conn::field(3, content));
            3
        }
        _ => return Err(invalid()),
    };
    Ok(Frame {
        kind: 1,
        stream: 0,
        payload: conn::tagged(
            1,
            &[
                conn::field(1, 1u32.to_be_bytes()),
                conn::field(2, conn::tagged(method, &fields)),
            ],
        ),
    })
}
/// Returns false for a typed refusal, true for a successful read/write.
pub fn exchange(
    stream: &mut (impl Read + Write),
    request: &Frame,
    output: &mut impl Write,
) -> io::Result<bool> {
    stream.write_all(&request.encode_local().map_err(|_| invalid())?)?;
    let response = Frame::read(stream).map_err(|_| invalid())?;
    if response.kind != 1 || response.payload[0] != 2 {
        return Err(invalid());
    }
    let fields = conn::fields("response", &response.payload[1..]).map_err(|_| invalid())?;
    if fields[0].1 != 1u32.to_be_bytes() {
        return Err(invalid());
    }
    let result = fields[1].1;
    if result[0] == 255 {
        let fields = conn::fields("error", &result[1..]).map_err(|_| invalid())?;
        let code = fields[0].1[0] as usize;
        let names = [
            "",
            "malformed",
            "unsupported",
            "not_ready",
            "stale",
            "not_found",
            "invalid_path",
            "not_regular",
            "too_large",
            "busy",
            "moved_off",
            "unauthorized",
            "internal",
        ];
        write!(
            output,
            "{{\"error\":{{\"code\":\"{}\"",
            names.get(code).ok_or_else(invalid)?
        )?;
        if code == 4 {
            if let Some((_, digest)) = fields.iter().find(|(tag, _)| *tag == 3) {
                write!(output, ",\"current_digest\":\"{}\"", hex(digest))?;
            }
        }
        writeln!(output, "}}}}")?;
        return Ok(false);
    }
    if result[0] != request.request().map_err(|_| invalid())?.1 {
        return Err(invalid());
    }
    match result[0] {
        2 => {
            let f = conn::fields("result2", &result[1..]).map_err(|_| invalid())?;
            writeln!(
                output,
                "{{\"digest\":\"{}\",\"mode\":{},\"content_b64\":\"{}\"}}",
                hex(f[1].1),
                u32::from_be_bytes(f[2].1.try_into().map_err(|_| invalid())?),
                base64(&f[0].1[4..])
            )?;
        }
        3 => {
            let f = conn::fields("result3", &result[1..]).map_err(|_| invalid())?;
            let mut raced = vec![];
            if let Some((_, raw)) = f.iter().find(|(tag, _)| *tag == 2) {
                let fields = conn::fields("raced", raw).map_err(|_| invalid())?;
                raced.push(serde_json::json!({
                    "path": std::str::from_utf8(&fields[0].1[2..]).map_err(|_| invalid())?,
                    "displaced_digest": hex(fields[1].1),
                    "version": std::str::from_utf8(&fields[2].1[2..]).map_err(|_| invalid())?,
                }));
            }
            serde_json::to_writer(
                &mut *output,
                &serde_json::json!({"post_digest": hex(f[0].1), "raced": raced}),
            )?;
            writeln!(output)?;
        }
        _ => return Err(invalid()),
    }
    Ok(true)
}
pub fn run(args: &[String]) -> io::Result<bool> {
    let request = request(args, &mut io::stdin().lock())?;
    let mut socket = std::os::unix::net::UnixStream::connect("/run/smithers/machined.sock")?;
    socket.set_read_timeout(Some(std::time::Duration::from_secs(30)))?;
    socket.set_write_timeout(Some(std::time::Duration::from_secs(5)))?;
    exchange(&mut socket, &request, &mut io::stdout().lock())
}
