//! Internal states; T-COL-08b owns their authenticated wire representation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gone {
    Deleted { by: String },
    Renamed { to: String, by: String },
}
