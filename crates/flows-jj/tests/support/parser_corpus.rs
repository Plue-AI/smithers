//! Test-only grammar, independent of Request's serde implementation.
use serde_json::{Value, json};

pub fn next(state: &mut u32) -> u32 {
    *state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    *state
}

pub fn request(seed: u32, index: u32) -> Value {
    let text = format!("seed {seed} case {index} \"\\\n\0文件🚀");
    match index % 8 {
        0 => json!({"op":"init","root":text}),
        1 => json!({"op":"snapshot","root":text,"message":format!("message {text}")}),
        2 => json!({"op":"restore","root":text,"changeId":format!("revision {text}")}),
        3 => {
            json!({"op":"diff","root":text,"from":format!("from {text}"),"to":format!("to {text}")})
        }
        4 => {
            json!({"op":"workspaceAdd","root":text,"name":format!("name {text}"),"path":format!("path {text}")})
        }
        5 => json!({"op":"workspaceForget","root":text,"name":format!("name {text}")}),
        6 => json!({"op":"status","root":text}),
        _ => json!({"op":"opRestore","root":text,"operationId":format!("operation {text}")}),
    }
}

/// Each mutation is invalid by construction, so callers may safely prove
/// parser rejection before passing it to the dispatching ABI.
pub fn rejected(seed: u32, index: u32) -> Vec<u8> {
    let mut value = request(seed, index);
    match (index / 8) % 10 {
        0 => {
            value.as_object_mut().unwrap().remove("root");
        }
        1 => {
            value["root"] = json!(null);
        }
        2 => {
            value["root"] = json!(["string inside an array"]);
        }
        3 => {
            value["root"] = json!({"root":"nested"});
        }
        4 => {
            value["op"] = json!(false);
        }
        5 => {
            value["op"] = json!(format!("unknown-{seed}-{index}"));
        }
        6 => {
            let mut bytes = serde_json::to_vec(&value).unwrap();
            bytes.pop();
            return bytes;
        }
        7 => {
            let mut bytes = serde_json::to_vec(&value).unwrap();
            bytes.extend_from_slice(b"\0");
            return bytes;
        }
        8 => {
            let bytes = serde_json::to_string(&value).unwrap();
            return format!("{{\"root\":\"duplicate\",{}", &bytes[1..]).into_bytes();
        }
        _ => {
            value["root"] = json!(u64::from(seed) << 32 | u64::from(index));
        }
    }
    serde_json::to_vec(&value).unwrap()
}
