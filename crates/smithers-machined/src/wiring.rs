//! One composition point; later components replace the named defaults here.
use crate::{
    broker::SocketpairBroker,
    hooks::{none::*, Hooks},
    stream::FrameTx,
};
use std::sync::Arc;
pub fn hooks(out: FrameTx) -> Hooks {
    Hooks {
        watcher: Arc::new(NoWatcher),
        documents: Arc::new(NoDocuments),
        sessions: Arc::new(NoSessions { out }),
        broker: Arc::new(SocketpairBroker),
    }
}
