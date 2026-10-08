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
    if args == ["write-files"] {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Change {
            path: String,
            base_digest: String,
            content: Option<Vec<u8>>,
        }
        let mut bytes = Vec::new();
        input.take((8 << 20) + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 8 << 20 {
            return Err(invalid());
        }
        let changes: Vec<Change> = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if changes.is_empty() || changes.len() > 256 {
            return Err(invalid());
        }
        let mut paths = std::collections::BTreeSet::new();
        let mut total = 0;
        let mut list = (changes.len() as u16).to_be_bytes().to_vec();
        for change in changes {
            if !paths.insert(change.path.clone()) {
                return Err(invalid());
            }
            if change.base_digest != "absent"
                && !change
                    .base_digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(invalid());
            }
            let base = if change.base_digest == "absent" {
                conn::tagged(2, &[])
            } else {
                conn::tagged(1, &[conn::field(1, unhex(&change.base_digest, 32)?)])
            };
            let mut fields = vec![conn::field(1, string(&change.path)?), conn::field(2, base)];
            if let Some(content) = change.content {
                total += content.len();
                if total > conn::MAX_FILE_BYTES {
                    return Err(invalid());
                }
                let mut bytes = (content.len() as u32).to_be_bytes().to_vec();
                bytes.extend(content);
                fields.push(conn::field(3, bytes));
            }
            list.extend(conn::structure_bytes(&fields));
        }
        for path in &paths {
            for (at, _) in path.match_indices('/') {
                if paths.contains(&path[..at]) {
                    return Err(invalid());
                }
            }
        }
        return Ok(Frame {
            kind: 1,
            stream: 0,
            payload: conn::tagged(
                1,
                &[
                    conn::field(1, 1u32.to_be_bytes()),
                    conn::field(2, conn::tagged(17, &[conn::field(1, list)])),
                ],
            ),
        });
    }
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
            writeln!(output, "{{\"post_digest\":\"{}\"}}", hex(f[0].1))?;
        }
        17 => {
            let request_fields =
                conn::fields("local_batch", request.request().map_err(|_| invalid())?.2)
                    .map_err(|_| invalid())?;
            let changes =
                conn::list("local_mutation", request_fields[0].1).map_err(|_| invalid())?;
            let f = conn::fields("result17", &result[1..]).map_err(|_| invalid())?;
            let results = conn::list("mutation_result", f[0].1).map_err(|_| invalid())?;
            if results.len() > changes.len() {
                return Err(invalid());
            }
            let mut writes = Vec::new();
            for (change, receipt) in changes.iter().zip(&results) {
                let change = conn::fields("local_mutation", change).map_err(|_| invalid())?;
                let receipt = conn::fields("mutation_result", receipt).map_err(|_| invalid())?;
                let path = std::str::from_utf8(&change[0].1[2..]).map_err(|_| invalid())?;
                let post = receipt[0].1;
                let content = change.iter().find(|(tag, _)| *tag == 3);
                let digest = if let Some((_, content)) = content {
                    use sha2::{Digest, Sha256};
                    let expected = Sha256::digest(&content[4..]);
                    if post[0] != 1 || &post[6..] != expected.as_slice() {
                        return Err(invalid());
                    }
                    hex(&expected)
                } else {
                    if post[0] != 2 {
                        return Err(invalid());
                    }
                    "absent".to_owned()
                };
                let mut write = serde_json::json!({"path": path, "post_digest": digest});
                if let Some((_, raced)) = receipt.iter().find(|(tag, _)| *tag == 2) {
                    let raced = conn::fields("raced", raced).map_err(|_| invalid())?;
                    if &raced[0].1[2..] != path.as_bytes() {
                        return Err(invalid());
                    }
                    write["raced"] = serde_json::json!(hex(raced[1].1));
                }
                writes.push(write);
            }
            let mut reply = serde_json::json!({"writes": writes});
            let mut success = true;
            if let Some((_, failure)) = f.iter().find(|(tag, _)| *tag == 2) {
                let failure = conn::fields("batch_failure", failure).map_err(|_| invalid())?;
                let index =
                    u16::from_be_bytes(failure[0].1.try_into().map_err(|_| invalid())?) as usize;
                let preflight = failure[1].1 == [1];
                if index >= changes.len()
                    || (preflight && !results.is_empty())
                    || (!preflight && index != results.len())
                {
                    return Err(invalid());
                }
                let error = conn::fields("error", failure[2].1).map_err(|_| invalid())?;
                let current = error
                    .iter()
                    .find(|(tag, _)| *tag == 3)
                    .map(|(_, d)| hex(d))
                    .unwrap_or_else(|| "absent".to_owned());
                reply["failure"] = serde_json::json!({"index": index, "preflight": preflight, "code": error[0].1[0], "current_digest": current});
                success = false;
            } else if results.len() != changes.len() {
                return Err(invalid());
            }
            writeln!(output, "{reply}")?;
            return Ok(success);
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
