use engine_core::protocol_types::{EngineRequest, EngineResponse};
use serde_json::Value;

// JSON `0` deserializes into both i64 and f64 fields equivalently, but
// serde_json::Value::Number distinguishes Int from F64 internally — so a
// round-trip turns `0` into `0.0` for f64 fields. That's not a parity bug;
// it's the serializer choosing canonical float formatting. Compare numerically.
fn json_equiv(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(an), Value::Number(bn)) => an.as_f64() == bn.as_f64(),
        (Value::Array(av), Value::Array(bv)) => {
            av.len() == bv.len() && av.iter().zip(bv).all(|(x, y)| json_equiv(x, y))
        }
        (Value::Object(am), Value::Object(bm)) => {
            am.len() == bm.len()
                && am
                    .iter()
                    .all(|(k, v)| bm.get(k).is_some_and(|bv| json_equiv(v, bv)))
        }
        _ => a == b,
    }
}

#[test]
fn request_fixture_deserializes() {
    let raw = include_str!("../../engine-protocol/tests/fixtures/sample-request.json");
    let req: EngineRequest = serde_json::from_str(raw).expect("Rust must accept Zod-validated request");
    let reserialized = serde_json::to_string(&req).expect("must serialize");
    let original_value: Value = serde_json::from_str(raw).unwrap();
    let new_value: Value = serde_json::from_str(&reserialized).unwrap();
    assert!(
        json_equiv(&new_value, &original_value),
        "round-trip must be identity\n  left:  {}\n  right: {}",
        new_value, original_value
    );
}

#[test]
fn response_fixture_deserializes() {
    let raw = include_str!("../../engine-protocol/tests/fixtures/sample-response.json");
    let res: EngineResponse = serde_json::from_str(raw).expect("Rust must accept Zod-validated response");
    let reserialized = serde_json::to_string(&res).expect("must serialize");
    let original_value: Value = serde_json::from_str(raw).unwrap();
    let new_value: Value = serde_json::from_str(&reserialized).unwrap();
    assert!(
        json_equiv(&new_value, &original_value),
        "round-trip must be identity\n  left:  {}\n  right: {}",
        new_value, original_value
    );
}
