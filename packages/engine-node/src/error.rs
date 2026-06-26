use crate::data_loader::EngineLoadError;
use engine_core::engine::EngineError;

pub fn map_load_error(e: EngineLoadError) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

pub fn map_engine_error(e: EngineError) -> napi::Error {
    let (code, msg, path): (&str, String, Vec<String>) = match e {
        EngineError::Cancelled => ("engine.cancelled", "compute cancelled".to_string(), vec![]),
        EngineError::Timeout(d) => (
            "engine.timeout",
            format!("timed out at depth {}", d),
            vec![],
        ),
        EngineError::InvalidInput { path } => (
            "engine.invalid_input",
            "invalid input".to_string(),
            path,
        ),
        EngineError::Internal(m) => ("engine.internal", m, vec![]),
    };
    let payload = serde_json::json!({ "code": code, "message": msg, "path": path });
    napi::Error::new(napi::Status::GenericFailure, payload.to_string())
}

pub fn invalid_input(path: Vec<&str>, message: impl Into<String>) -> napi::Error {
    let payload = serde_json::json!({
        "code": "engine.invalid_input",
        "message": message.into(),
        "path": path,
    });
    napi::Error::new(napi::Status::InvalidArg, payload.to_string())
}

pub fn internal(message: impl Into<String>) -> napi::Error {
    let empty: Vec<String> = Vec::new();
    let payload = serde_json::json!({
        "code": "engine.internal",
        "message": message.into(),
        "path": empty,
    });
    napi::Error::new(napi::Status::GenericFailure, payload.to_string())
}
