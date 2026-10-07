//! RFC 4254 terminal settings, applied only after the child drops credentials.
use std::io;
fn invalid() -> io::Error {
    io::Error::other("invalid terminal settings")
}
pub fn decode(bytes: &[u8]) -> io::Result<Vec<(u8, u32)>> {
    if bytes.len() > 1024 {
        return Err(invalid());
    }
    let mut modes = Vec::new();
    let mut seen = [false; 160];
    let mut rest = bytes;
    while !rest.is_empty() {
        let opcode = rest[0];
        if opcode == 0 {
            return if rest.len() == 1 {
                Ok(modes)
            } else {
                Err(invalid())
            };
        }
        if opcode >= 160 || rest.len() < 5 || seen[opcode as usize] {
            return Err(invalid());
        }
        seen[opcode as usize] = true;
        let value = u32::from_be_bytes(rest[1..5].try_into().unwrap());
        if opcode < 30 && value > 255 {
            return Err(invalid());
        }
        if matches!(opcode, 128 | 129) {
            speed(value)?;
        }
        modes.push((opcode, value));
        rest = &rest[5..];
    }
    Err(invalid())
}
pub fn valid_term(term: &str) -> bool {
    term.len() <= 128
        && term
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
}
fn speed(value: u32) -> io::Result<libc::speed_t> {
    Ok(match value {
        0 => libc::B0,
        50 => libc::B50,
        75 => libc::B75,
        110 => libc::B110,
        300 => libc::B300,
        600 => libc::B600,
        1200 => libc::B1200,
        2400 => libc::B2400,
        4800 => libc::B4800,
        9600 => libc::B9600,
        19200 => libc::B19200,
        38400 => libc::B38400,
        57600 => libc::B57600,
        115200 => libc::B115200,
        230400 => libc::B230400,
        _ => return Err(invalid()),
    })
}
fn flag(field: &mut libc::tcflag_t, bit: libc::tcflag_t, value: u32) {
    if value == 0 {
        *field &= !bit
    } else {
        *field |= bit
    }
}
pub fn apply(modes: &[(u8, u32)]) -> io::Result<()> {
    let mut term = std::mem::MaybeUninit::<libc::termios>::uninit();
    if unsafe { libc::tcgetattr(0, term.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut term = unsafe { term.assume_init() };
    for &(code, value) in modes {
        let control = match code {
            1 => Some(libc::VINTR),
            2 => Some(libc::VQUIT),
            3 => Some(libc::VERASE),
            4 => Some(libc::VKILL),
            5 => Some(libc::VEOF),
            6 => Some(libc::VEOL),
            7 => Some(libc::VEOL2),
            8 => Some(libc::VSTART),
            9 => Some(libc::VSTOP),
            10 => Some(libc::VSUSP),
            12 => Some(libc::VREPRINT),
            13 => Some(libc::VWERASE),
            14 => Some(libc::VLNEXT),
            18 => Some(libc::VDISCARD),
            _ => None,
        };
        if let Some(index) = control {
            term.c_cc[index] = value as u8;
            continue;
        }
        match code {
            30 => flag(&mut term.c_iflag, libc::IGNPAR, value),
            31 => flag(&mut term.c_iflag, libc::PARMRK, value),
            32 => flag(&mut term.c_iflag, libc::INPCK, value),
            33 => flag(&mut term.c_iflag, libc::ISTRIP, value),
            34 => flag(&mut term.c_iflag, libc::INLCR, value),
            35 => flag(&mut term.c_iflag, libc::IGNCR, value),
            36 => flag(&mut term.c_iflag, libc::ICRNL, value),
            37 => flag(&mut term.c_iflag, libc::IUCLC, value),
            38 => flag(&mut term.c_iflag, libc::IXON, value),
            39 => flag(&mut term.c_iflag, libc::IXANY, value),
            40 => flag(&mut term.c_iflag, libc::IXOFF, value),
            41 => flag(&mut term.c_iflag, libc::IMAXBEL, value),
            42 => flag(&mut term.c_iflag, libc::IUTF8, value),
            50 => flag(&mut term.c_lflag, libc::ISIG, value),
            51 => flag(&mut term.c_lflag, libc::ICANON, value),
            52 => flag(&mut term.c_lflag, libc::XCASE, value),
            53 => flag(&mut term.c_lflag, libc::ECHO, value),
            54 => flag(&mut term.c_lflag, libc::ECHOE, value),
            55 => flag(&mut term.c_lflag, libc::ECHOK, value),
            56 => flag(&mut term.c_lflag, libc::ECHONL, value),
            57 => flag(&mut term.c_lflag, libc::NOFLSH, value),
            58 => flag(&mut term.c_lflag, libc::TOSTOP, value),
            59 => flag(&mut term.c_lflag, libc::IEXTEN, value),
            60 => flag(&mut term.c_lflag, libc::ECHOCTL, value),
            61 => flag(&mut term.c_lflag, libc::ECHOKE, value),
            62 => flag(&mut term.c_lflag, libc::PENDIN, value),
            70 => flag(&mut term.c_oflag, libc::OPOST, value),
            71 => flag(&mut term.c_oflag, libc::OLCUC, value),
            72 => flag(&mut term.c_oflag, libc::ONLCR, value),
            73 => flag(&mut term.c_oflag, libc::OCRNL, value),
            74 => flag(&mut term.c_oflag, libc::ONOCR, value),
            75 => flag(&mut term.c_oflag, libc::ONLRET, value),
            90 | 91 if value != 0 => {
                term.c_cflag &= !libc::CSIZE;
                term.c_cflag |= if code == 90 { libc::CS7 } else { libc::CS8 };
            }
            92 => flag(&mut term.c_cflag, libc::PARENB, value),
            93 => flag(&mut term.c_cflag, libc::PARODD, value),
            128 => {
                if unsafe { libc::cfsetispeed(&mut term, speed(value)?) } != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            129 if unsafe { libc::cfsetospeed(&mut term, speed(value)?) } != 0 => {
                return Err(io::Error::last_os_error());
            }
            _ => {}
        }
    }
    if unsafe { libc::tcsetattr(0, libc::TCSANOW, &term) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literal_modes_reject_truncation_duplicate_invalid_speed_and_nul_term() {
        assert_eq!(
            decode(&[1, 0, 0, 0, 3, 53, 0, 0, 0, 0, 0]).unwrap(),
            [(1, 3), (53, 0)]
        );
        for bytes in [
            vec![],
            vec![1, 0],
            vec![160, 0],
            vec![0, 0],
            vec![1, 0, 0, 1, 0, 0],
            vec![53, 0, 0, 0, 1, 53, 0, 0, 0, 0, 0],
            vec![128, 0, 0, 0, 1, 0],
        ] {
            assert!(decode(&bytes).is_err());
        }
        assert!(valid_term("xterm-256color"));
        assert!(!valid_term("xterm\0"));
        assert!(!valid_term("../term"));
    }
}
