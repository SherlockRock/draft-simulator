//! engine-node: napi-rs FFI wrapper around engine-core. Phase 9 lands the binding surface.

mod data_loader;
mod error;

use std::sync::Arc;

use engine_core::cancellation::CancelHandle;
use engine_core::engine::{Engine as CoreEngine, EngineError};
use napi_derive::napi;

#[napi]
pub fn engine_version() -> String {
    "0.1.0".to_string()
}

#[napi]
pub struct CancelToken {
    inner: CancelHandle,
}

#[napi]
impl CancelToken {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self {
            inner: CancelHandle::new(),
        }
    }

    #[napi]
    pub fn cancel(&self) {
        self.inner.cancel();
    }

    #[napi]
    pub fn is_cancelled(&self) -> bool {
        self.inner.is_cancelled()
    }
}

#[napi(object)]
pub struct CreateEngineOptions {
    pub champion_meta_path: String,
    pub matchup_data_path: String,
}

#[napi]
pub struct Engine {
    inner: Arc<CoreEngine>,
}

#[napi]
impl Engine {
    #[napi(factory)]
    pub fn create(options: CreateEngineOptions) -> napi::Result<Self> {
        let (meta, champion_meta) = data_loader::load_engine_data(
            std::path::Path::new(&options.champion_meta_path),
            std::path::Path::new(&options.matchup_data_path),
        )
        .map_err(error::map_load_error)?;
        let core = CoreEngine::new(meta, champion_meta);
        Ok(Self {
            inner: Arc::new(core),
        })
    }

    #[napi]
    pub async fn compute(
        &self,
        _request_json: String,
        _token: &CancelToken,
    ) -> napi::Result<String> {
        Err(error::map_engine_error(EngineError::Internal(
            "compute not yet implemented".to_string(),
        )))
    }
}
