//! engine-node: napi-rs FFI wrapper around engine-core. Phase 9 lands the binding surface.
use napi_derive::napi;

#[napi]
pub fn engine_version() -> String {
    "0.1.0".to_string()
}
