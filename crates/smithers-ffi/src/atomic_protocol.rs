//! Bounded request and response framing shared by native filesystem backends.
use serde_json::{json, Value};
use std::io::{self, Read, Write};

const PROTOCOL: &str = "flows-atomic/1";
pub(super) const HARD_LIMIT: usize = 256 * 1024 * 1024;

pub(super) fn serve(
    run: impl FnOnce(&Value, usize, usize) -> io::Result<Value>,
    rejection: impl FnOnce(&Value, &io::Error) -> Value,
    invalid: fn(&str) -> io::Error,
) -> io::Result<()> {
    exchange(io::stdin(), io::stdout().lock(), run, rejection, invalid)
}

fn exchange(
    input: impl Read,
    mut stdout: impl Write,
    run: impl FnOnce(&Value, usize, usize) -> io::Result<Value>,
    rejection: impl FnOnce(&Value, &io::Error) -> Value,
    invalid: fn(&str) -> io::Error,
) -> io::Result<()> {
    let mut bytes = Vec::new();
    input
        .take(HARD_LIMIT as u64 + 257)
        .read_to_end(&mut bytes)?;
    let input = bytes;
    if input.len() > HARD_LIMIT + 256 {
        return Err(invalid("request exceeds hard limit"));
    }
    let newline = input
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| invalid("missing frame"))?;
    if newline > 256 {
        return Err(invalid("frame header too long"));
    }
    let header =
        std::str::from_utf8(&input[..newline]).map_err(|_| invalid("invalid frame header"))?;
    let fields = header.split(' ').collect::<Vec<_>>();
    if fields.len() != 5 || fields[0] != PROTOCOL {
        return Err(invalid("invalid frame protocol"));
    }
    let numbers = fields[1..]
        .iter()
        .map(|s| {
            s.parse::<usize>()
                .map_err(|_| invalid("invalid frame limit"))
        })
        .collect::<io::Result<Vec<_>>>()?;
    let (length, request_limit, content_limit, response_limit) =
        (numbers[0], numbers[1], numbers[2], numbers[3]);
    if request_limit > HARD_LIMIT
        || content_limit > HARD_LIMIT
        || response_limit > HARD_LIMIT
        || length > request_limit
        || input.len() - newline - 1 != length
    {
        return Err(invalid("frame limit exceeded"));
    }
    let request: Value = serde_json::from_slice(&input[newline + 1..])
        .map_err(|_| invalid("invalid request JSON"))?;
    let response = match run(&request, content_limit, response_limit) {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(e) => rejection(&request, &e),
    };
    let mut body = serde_json::to_vec(&response)?;
    if body.len() > response_limit {
        body = serde_json::to_vec(
            &json!({"ok":false,"code":"EFBIG","message":"response exceeds limit"}),
        )?;
    }
    writeln!(stdout, "{PROTOCOL} {}", body.len())?;
    stdout.write_all(&body)?;
    stdout.flush()
}

pub(super) fn syscall(operation: &str) -> &'static str {
    match operation {
        "readFile" | "readFileString" | "writeFile" | "writeFileString" | "digest" => "open",
        "exists" => "access",
        "stat" => "stat",
        "readLink" => "readlink",
        "realPath" => "realpath",
        "resolve" => "lstat",
        "makeDirectory" => "mkdir",
        "readDirectory" | "glob" => "scandir",
        "remove" => "unlink",
        "rename" => "rename",
        "chmod" => "fchmod",
        "chown" => "fchown",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invalid(message: &str) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidInput, message)
    }

    fn response(bytes: &[u8]) -> Value {
        let newline = bytes.iter().position(|byte| *byte == b'\n').unwrap();
        let header = std::str::from_utf8(&bytes[..newline]).unwrap();
        assert_eq!(header, format!("{PROTOCOL} {}", bytes.len() - newline - 1));
        serde_json::from_slice(&bytes[newline + 1..]).unwrap()
    }

    #[test]
    fn passes_only_valid_bounded_requests_to_the_backend() {
        let body = br#"{"operation":"stat","path":"C:\\workspace\\file"}"#;
        let mut frame = format!("{PROTOCOL} {} 1024 512 256\n", body.len()).into_bytes();
        frame.extend_from_slice(body);
        let mut output = Vec::new();
        exchange(
            frame.as_slice(),
            &mut output,
            |request, content, response| {
                assert_eq!((content, response), (512, 256));
                assert_eq!(request["path"], "C:\\workspace\\file");
                Ok(json!({"type": "File"}))
            },
            |_, _| panic!("successful backend must not serialize an error"),
            invalid,
        )
        .unwrap();
        assert_eq!(
            response(&output),
            json!({"ok": true, "value": {"type": "File"}})
        );
    }

    #[test]
    fn rejects_malformed_frames_before_any_filesystem_operation() {
        let frames = [
            String::new(),
            "other/1 2 2 2 2\n{}".into(),
            format!("{PROTOCOL} 2 2 2\n{{}}"),
            format!("{PROTOCOL} invalid 2 2 2\n{{}}"),
            format!("{}\n{{}}", "x".repeat(257)),
            format!("{PROTOCOL} 2 1 2 2\n{{}}"),
            format!("{PROTOCOL} 2 2 2 2\n{{"),
            format!("{PROTOCOL} 2 2 2 2\n{{}}extra"),
            format!("{PROTOCOL} 2 {} 2 2\n{{}}", HARD_LIMIT + 1),
            format!("{PROTOCOL} 2 2 {} 2\n{{}}", HARD_LIMIT + 1),
            format!("{PROTOCOL} 2 2 2 {}\n{{}}", HARD_LIMIT + 1),
            format!("{PROTOCOL} 1 2 2 2\n{{"),
        ];
        for frame in frames {
            let mut output = Vec::new();
            let error = exchange(
                frame.as_bytes(),
                &mut output,
                |_, _, _| panic!("malformed frame reached the backend"),
                |_, _| panic!("malformed frame reached the backend serializer"),
                invalid,
            )
            .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
            assert!(output.is_empty());
        }
    }

    #[test]
    fn frames_backend_failures_and_bounds_success_payloads() {
        let input = format!("{PROTOCOL} 2 2 2 128\n{{}}");
        let mut output = Vec::new();
        exchange(
            input.as_bytes(),
            &mut output,
            |_, _, _| Err(io::Error::from(io::ErrorKind::PermissionDenied)),
            |_, error| {
                assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
                json!({"ok": false, "code": "EACCES"})
            },
            invalid,
        )
        .unwrap();
        assert_eq!(response(&output), json!({"ok": false, "code": "EACCES"}));
        output.clear();
        exchange(
            input.as_bytes(),
            &mut output,
            |_, _, _| Ok(json!("x".repeat(1024))),
            |_, _| unreachable!(),
            invalid,
        )
        .unwrap();
        assert_eq!(response(&output)["code"], "EFBIG");
        assert!(output.len() < 128);
    }
}
