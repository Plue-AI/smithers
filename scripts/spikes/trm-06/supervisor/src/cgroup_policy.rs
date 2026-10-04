// Pure parsing for the Linux startup barrier; no filesystem or root effects.
use std::io;
fn refusal() -> io::Error {
    io::Error::other("invalid cgroup observation")
}
pub(crate) fn name_valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
pub(crate) fn empty(text: &str) -> io::Result<bool> {
    let mut populated = None;
    for line in text.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.first() == Some(&"populated") {
            if populated.is_some() || fields.len() != 2 {
                return Err(refusal());
            }
            populated = Some(match fields[1] {
                "0" => true,
                "1" => false,
                _ => return Err(refusal()),
            });
        }
    }
    populated.ok_or_else(refusal)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literal_population_and_name_policy() {
        assert!(empty("populated 0\nfrozen 0\n").unwrap());
        assert!(!empty("populated 1\nfrozen 0\n").unwrap());
        for text in [
            "",
            "populated 00",
            "populated 0 extra",
            "populated 0\npopulated 0",
            "populated 2",
        ] {
            assert!(empty(text).is_err());
        }
        assert!(name_valid("ben-012abc"));
        assert!(name_valid(&"a".repeat(64)));
        for name in [
            "",
            "..",
            "../ben",
            "Ben",
            "ben/abc",
            "ben\0",
            &"a".repeat(65),
        ] {
            assert!(!name_valid(name));
        }
    }
}
