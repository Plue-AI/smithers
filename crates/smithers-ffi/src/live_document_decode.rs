//! Strict Yjs v1 decoding at the C boundary. Yrs' small-client compatibility
//! decoder wraps oversized varints; doing so before identity checks aliases a
//! foreign client to an authenticated one. Require canonical 32-bit unsigned
//! values (the selected Yrs client-id domain) and consume the entire frame.
use std::sync::Arc;
use yrs::encoding::{
    read::{Cursor, Error, Read},
    varint::VarInt,
};
use yrs::updates::decoder::{Decode, Decoder};
use yrs::{Any, ClientID, ID};

pub fn decode<T: Decode>(bytes: &[u8]) -> Result<T, Error> {
    let mut decoder = Strict {
        cursor: Cursor::new(bytes),
        update: std::any::type_name::<T>() == std::any::type_name::<yrs::Update>(),
        clock: false,
        info: 0,
    };
    let value = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| T::decode(&mut decoder)))
        .map_err(|_| Error::UnexpectedValue)??;
    if decoder.cursor.has_content() {
        return Err(Error::UnexpectedValue);
    }
    Ok(value)
}
struct Strict<'a> {
    cursor: Cursor<'a>,
    update: bool,
    clock: bool,
    info: u8,
}
impl Read for Strict<'_> {
    fn read_u8(&mut self) -> Result<u8, Error> {
        self.cursor.read_u8()
    }
    fn read_exact(&mut self, len: usize) -> Result<&[u8], Error> {
        self.cursor.read_exact(len)
    }
    fn read_string(&mut self) -> Result<&str, Error> {
        std::str::from_utf8(self.read_buf()?).map_err(|_| Error::UnexpectedValue)
    }
    fn read_var<T: VarInt>(&mut self) -> Result<T, Error> {
        let start = self.cursor.next;
        let value = T::read(self)?;
        let raw = &self.cursor.buf[start..self.cursor.next];
        let mut canonical = Vec::new();
        value.write(&mut canonical);
        let unsigned = matches!(std::any::type_name::<T>(), "u32" | "u64" | "usize");
        if raw != canonical || unsigned && (raw.len() > 5 || (raw.len() == 5 && raw[4] > 15)) {
            return Err(Error::InvalidVarInt);
        }
        let clock = std::mem::take(&mut self.clock);
        if unsigned {
            let n = u64::read(&mut Cursor::new(raw))?;
            // Every count needs at least one byte per element. Clocks and ids
            // are exempt. This checks BEFORE Yrs reserves attacker-sized tables.
            if (start == 0
                || std::any::type_name::<T>() == "usize"
                || self.update && std::any::type_name::<T>() == "u32" && !clock)
                && n > self.cursor.buf.len() as u64
            {
                return Err(Error::UnexpectedValue);
            }
        }
        Ok(value)
    }
}
impl Strict<'_> {
    fn any(&mut self, depth: usize) -> Result<Any, Error> {
        if depth > 64 {
            return Err(Error::UnexpectedValue);
        }
        let start = self.cursor.next;
        match self.read_u8()? {
            117 => {
                let n: usize = self.read_var()?;
                let mut values = Vec::new();
                for _ in 0..n {
                    values.push(self.any(depth + 1)?);
                }
                Ok(Any::Array(values.into()))
            }
            118 => {
                let n: usize = self.read_var()?;
                let mut values = std::collections::HashMap::new();
                for _ in 0..n {
                    let key = self.read_string()?.to_owned();
                    values.insert(key, self.any(depth + 1)?);
                }
                Ok(Any::Map(Arc::new(values)))
            }
            _ => {
                self.cursor.next = start;
                Any::decode(self)
            }
        }
    }

    fn id(&mut self) -> Result<ID, Error> {
        Ok(ID::new(self.read_client()?, self.read_var()?))
    }
}
impl Decoder for Strict<'_> {
    fn reset_ds_cur_val(&mut self) {}
    fn read_ds_clock(&mut self) -> Result<u32, Error> {
        self.clock = true;
        self.read_var()
    }
    fn read_ds_len(&mut self) -> Result<u32, Error> {
        self.clock = true;
        self.read_var()
    }
    fn read_left_id(&mut self) -> Result<ID, Error> {
        self.id()
    }
    fn read_right_id(&mut self) -> Result<ID, Error> {
        self.id()
    }
    fn read_client(&mut self) -> Result<ClientID, Error> {
        self.clock = true;
        let client = self.read_var::<u32>()?;
        self.clock = true;
        Ok(ClientID::new(client as u64))
    }
    fn read_info(&mut self) -> Result<u8, Error> {
        self.info = self.read_u8()?;
        if self.info == 10 {
            self.clock = true;
        } // skip range, not an allocation count
        Ok(self.info)
    }
    fn read_parent_info(&mut self) -> Result<bool, Error> {
        match self.read_var::<u32>()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(Error::UnexpectedValue),
        }
    }
    fn read_type_ref(&mut self) -> Result<u8, Error> {
        self.read_u8()
    }
    fn read_len(&mut self) -> Result<u32, Error> {
        if matches!(self.info & 15, 0 | 1) {
            self.clock = true;
        } // GC/deleted range
        self.read_var()
    }
    fn read_any(&mut self) -> Result<Any, Error> {
        self.any(0)
    }
    fn read_json(&mut self) -> Result<Any, Error> {
        Any::from_json(self.read_string()?)
    }
    fn read_key(&mut self) -> Result<Arc<str>, Error> {
        Ok(self.read_string()?.into())
    }
    fn read_to_end(&mut self) -> Result<&[u8], Error> {
        let end = self.cursor.buf.len();
        let start = self.cursor.next;
        self.cursor.next = end;
        Ok(&self.cursor.buf[start..end])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::encoding::write::Write;
    #[test]
    fn allocation_counts_and_aliases_refuse_before_reservation() {
        for bytes in [
            vec![255, 255, 255, 255, 15],
            vec![1, 255, 255, 255, 255, 15],
        ] {
            assert!(decode::<yrs::Update>(&bytes).is_err());
        }
        // Oversized id would truncate to 11 with the compatibility decoder.
        let mut bytes = vec![1, 1];
        bytes.write_var((1u64 << 32) + 11);
        bytes.extend_from_slice(&[
            0, 4, 1, 7, b'c', b'o', b'n', b't', b'e', b'n', b't', 1, b'x', 0,
        ]);
        assert!(decode::<yrs::Update>(&bytes).is_err());
        assert!(decode::<yrs::Update>(&[0, 0, 1]).is_err()); // trailing bytes
        let mut sv = vec![1];
        sv.write_var(u32::MAX);
        sv.write_var(u32::MAX);
        let state = decode::<yrs::StateVector>(&sv).unwrap();
        assert_eq!(state.get(&ClientID::new(u32::MAX as u64)), u32::MAX);
    }
    #[test]
    fn invalid_utf8_wire_strings_are_rejected() {
        // One client insertion into content, with an invalid UTF-8 payload.
        let update = [
            1, 1, 11, 0, 4, 1, 7, b'c', b'o', b'n', b't', b'e', b'n', b't', 1, 255, 0,
        ];
        assert!(decode::<yrs::Update>(&update).is_err());
        assert!(decode::<yrs::sync::AwarenessUpdate>(&[1, 11, 1, 1, 255]).is_err());
    }
    #[test]
    fn nested_any_has_a_depth_budget() {
        let mut bytes = vec![];
        for _ in 0..100 {
            bytes.extend_from_slice(&[117, 1]);
        }
        bytes.push(126);
        let mut decoder = Strict {
            cursor: Cursor::new(&bytes),
            update: true,
            clock: false,
            info: 0,
        };
        assert!(decoder.read_any().is_err());
    }
}
