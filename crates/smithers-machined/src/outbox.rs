//! Durable event seam; A3 supplies recovery and receipt persistence.
use crate::{hooks::EventSink, msg::*};
pub struct Outbox;
impl Outbox {
    pub fn recover(_: &std::path::Path) -> Result<Self, Error> {
        Err(Error::unsupported())
    }
    pub async fn wait_empty(&self) -> Result<(), Error> {
        Err(Error::unsupported())
    }
}
impl EventSink for Outbox {
    fn append(&self, _: Event, _: Option<Oid>) -> Result<(u64, Id128), Error> {
        Err(Error::unsupported())
    }
    fn hint(&self, _: Hint) {}
}
