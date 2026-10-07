//! Bounded kernel process lifetime reads; no home or branch pathname is opened.
use std::{
    fs::File,
    io::{self, Read},
};

fn invalid() -> io::Error {
    io::ErrorKind::InvalidData.into()
}

pub fn start_ticks(pid: u32) -> io::Result<u64> {
    if pid == 0 {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    File::open(format!("/proc/{pid}/stat"))?
        .take(4097)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        return Err(invalid());
    }
    parse_start_ticks(pid, &bytes)
}

fn parse_start_ticks(pid: u32, bytes: &[u8]) -> io::Result<u64> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let (identity, rest) = text.split_once(" (").ok_or_else(invalid)?;
    if identity.parse::<u32>().map_err(|_| invalid())? != pid {
        return Err(invalid());
    }
    // comm can contain spaces and parentheses. The final closing parenthesis
    // separates it from the fixed numeric kernel fields.
    let (_, fields) = rest.rsplit_once(") ").ok_or_else(invalid)?;
    let ticks = fields
        .split_whitespace()
        .nth(19)
        .ok_or_else(invalid)?
        .parse::<u64>()
        .map_err(|_| invalid())?;
    if ticks == 0 {
        return Err(invalid());
    }
    Ok(ticks)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kernel_lifetime_is_stable_for_a_retained_child() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("60")
            .spawn()
            .unwrap();
        let first = start_ticks(child.id()).unwrap();
        assert_eq!(start_ticks(child.id()).unwrap(), first);
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(start_ticks(child.id()).is_err());
    }
    #[test]
    fn literal_stat_handles_parentheses_and_rejects_wrong_pid_or_fields() {
        let stat = b"42 (an odd ) (name) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 12345 20\n";
        assert_eq!(parse_start_ticks(42, stat).unwrap(), 12345);
        assert!(parse_start_ticks(43, stat).is_err());
        for bad in [b"42 (x) S 1".as_slice(), b"42 (x) S \xff", b"42 x) S 1"] {
            assert!(parse_start_ticks(42, bad).is_err());
        }
        assert!(start_ticks(0).is_err());
    }
}
