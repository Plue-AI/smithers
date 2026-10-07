//! Trusted per-boot authority. The fixed boot file is opened without following
//! symlinks; its bytes are never logged and branch configuration is not read.
use crate::link::Identity;
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, Read},
    os::unix::fs::MetadataExt,
};
#[derive(Debug, PartialEq, Eq)]
pub enum Topology {
    Relay,
    Bridge(u16),
}
pub struct Boot {
    pub identity: Identity,
    pub topology: Topology,
    pub item: Option<ItemBinding>,
    pub moved_off: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ItemBinding {
    pub number: u64,
    pub change: String,
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid boot authority")
}
fn hex<const N: usize>(value: &str) -> io::Result<[u8; N]> {
    if value.len() != 2 * N
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid());
    }
    let mut result = [0; N];
    for (i, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).map_err(|_| invalid())?;
    }
    Ok(result)
}
impl Boot {
    pub fn parse(bytes: &[u8]) -> io::Result<Self> {
        if bytes.len() > 4096 || bytes.contains(&0) {
            return Err(invalid());
        }
        let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
        let mut values = BTreeMap::new();
        for line in text.lines() {
            let (key, value) = line.split_once('=').ok_or_else(invalid)?;
            if !matches!(
                key,
                "boot_id"
                    | "relay_secret"
                    | "credential"
                    | "topology"
                    | "bridge_port"
                    | "item_number"
                    | "item_change"
                    | "moved_off"
            ) || value.is_empty()
                || values.insert(key, value).is_some()
            {
                return Err(invalid());
            }
        }
        let topology = match values.remove("topology") {
            Some("relay") => Topology::Relay,
            Some("bridge") => {
                let port = values.remove("bridge_port").ok_or_else(invalid)?;
                if !port.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(invalid());
                }
                let port: u16 = port.parse().map_err(|_| invalid())?;
                if port == 0 {
                    return Err(invalid());
                }
                Topology::Bridge(port)
            }
            _ => return Err(invalid()),
        };
        let boot = hex(values.remove("boot_id").ok_or_else(invalid)?)?;
        let secret = hex(values.remove("relay_secret").ok_or_else(invalid)?)?;
        let credential = values
            .remove("credential")
            .ok_or_else(invalid)?
            .as_bytes()
            .to_vec();
        let item = match (values.remove("item_number"), values.remove("item_change")) {
            (None, None) => None,
            (Some("0"), None) => Some(ItemBinding {
                number: 0,
                change: String::new(),
            }),
            (Some(number), Some(change))
                if number.bytes().all(|b| b.is_ascii_digit())
                    && change.len() == 32
                    && change.bytes().all(|b| (b'k'..=b'z').contains(&b)) =>
            {
                let number = number.parse::<u64>().map_err(|_| invalid())?;
                if number == 0 {
                    return Err(invalid());
                }
                Some(ItemBinding {
                    number,
                    change: change.into(),
                })
            }
            _ => return Err(invalid()),
        };
        let moved_off = values
            .remove("moved_off")
            .map(|value| {
                if item.as_ref().map(|item| item.number).unwrap_or(0) == 0 {
                    return Err(invalid());
                }
                hex::<20>(value)?;
                Ok(value.to_owned())
            })
            .transpose()?;
        if !values.is_empty() {
            return Err(invalid());
        }
        Ok(Self {
            identity: Identity::new(boot, secret, credential)?,
            topology,
            item,
            moved_off,
        })
    }
    /// Validate the descriptor, then read a bounded amount. This can also be
    /// used with the descriptor retained by the broker before uid drop.
    pub fn read(mut file: File) -> io::Result<Self> {
        let stat = file.metadata()?;
        if !stat.is_file()
            || stat.uid() != 19998
            || stat.mode() & 0o7777 != 0o400
            || stat.nlink() != 1
            || stat.len() > 4096
        {
            return Err(invalid());
        }
        let mut bytes = Vec::new();
        (&mut file).take(4097).read_to_end(&mut bytes)?;
        Self::parse(&bytes)
    }
    #[cfg(target_os = "linux")]
    pub fn open() -> io::Result<Self> {
        use rustix::fs::{openat2, Mode, OFlags, ResolveFlags};
        let root = File::open("/")?;
        let fd = openat2(
            &root,
            "run/smithers/machined/boot",
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NONBLOCK | OFlags::NOFOLLOW,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
        )?;
        Self::read(fd.into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_item_binding_is_paired_bounded_and_not_repository_selected() {
        let source = fixture();
        let binding = "item_number=2\nitem_change=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n";
        assert_eq!(
            Boot::parse(format!("{source}{binding}").as_bytes())
                .unwrap()
                .item,
            Some(ItemBinding {
                number: 2,
                change: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz".into()
            })
        );
        let recovered = Boot::parse(
            format!("{source}{binding}moved_off=1234567890abcdef1234567890abcdef12345678\n")
                .as_bytes(),
        )
        .unwrap();
        assert_eq!(
            recovered.moved_off.as_deref(),
            Some("1234567890abcdef1234567890abcdef12345678")
        );
        for invalid in [
            format!("{source}moved_off=1234567890abcdef1234567890abcdef12345678\n"),
            format!("{source}{binding}moved_off=main\n"),
        ] {
            assert!(Boot::parse(invalid.as_bytes()).is_err());
        }
        assert!(Boot::parse(source.as_bytes()).unwrap().item.is_none());
        assert_eq!(
            Boot::parse(format!("{source}item_number=0\n").as_bytes())
                .unwrap()
                .item,
            Some(ItemBinding {
                number: 0,
                change: String::new()
            })
        );
        for invalid in [
            "item_number=2\n",
            "item_change=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n",
            "item_number=0\nitem_change=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n",
            "item_number=2\nitem_change=main\n",
            "item_number=18446744073709551616\nitem_change=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n",
        ] {
            assert!(
                Boot::parse(format!("{source}{invalid}").as_bytes()).is_err(),
                "{invalid}"
            );
        }
    }
    fn fixture() -> String {
        format!(
            "boot_id={}\nrelay_secret={}\ncredential=fixture=token\ntopology=relay\n",
            "04".repeat(16),
            "09".repeat(32)
        )
    }
    #[test]
    fn strict_boot_inputs() {
        let source = fixture();
        assert_eq!(
            Boot::parse(source.as_bytes()).unwrap().topology,
            Topology::Relay
        );
        let bridge = source.replace("topology=relay", "topology=bridge\nbridge_port=970");
        assert_eq!(
            Boot::parse(bridge.as_bytes()).unwrap().topology,
            Topology::Bridge(970)
        );
        for bad in [
            source.clone() + "credential=other\n",
            source.clone() + "executable=/workspace/a\n",
            source.clone() + "bridge_port=970\n",
            source.replace("topology=relay", "topology=bridge"),
            source.replace("topology=relay", "topology=bridge\nbridge_port=0"),
            source.replace("topology=relay", "topology=bridge\nbridge_port=65536"),
            source.replace("04", "GG"),
            source.replace("credential=fixture=token", "credential="),
            source.clone() + "\0",
            "x".repeat(4097),
        ] {
            assert!(Boot::parse(bad.as_bytes()).is_err());
        }
    }
}
