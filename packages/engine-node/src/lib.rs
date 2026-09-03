//! engine-node: napi-rs FFI wrapper around engine-core. Phase 9 lands the binding surface.

mod data_loader;
mod error;
mod projection;

#[cfg(test)]
mod solver_roles_test;

#[cfg(test)]
mod evaluator_scores_test;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use engine_core::cancellation::CancelHandle;
use engine_core::engine::Engine as CoreEngine;
use engine_core::protocol_types as proto;
use engine_core::role_solver::ChampionMeta;
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
    /// Optional FM weights (design §4). Omitted or unreadable → legacy compStrength.
    pub fm_weights_path: Option<String>,
}

#[napi]
pub struct Engine {
    inner: Arc<CoreEngine>,
    champion_meta: Arc<HashMap<String, ChampionMeta>>,
    fm_status: String,
}

#[napi]
impl Engine {
    #[napi(factory)]
    pub fn create(options: CreateEngineOptions) -> napi::Result<Self> {
        let champion_meta_path = PathBuf::from(&options.champion_meta_path);
        let (mut meta, champion_meta) = data_loader::load_engine_data(
            &champion_meta_path,
            std::path::Path::new(&options.matchup_data_path),
        )
        .map_err(error::map_load_error)?;
        let fm = options
            .fm_weights_path
            .as_deref()
            .and_then(|p| data_loader::load_fm_weights(std::path::Path::new(p)));
        let fm_status = match &fm {
            Some(w) => {
                let not_in_table: Vec<&str> = champion_meta
                    .keys()
                    .filter(|k| w.champion(k).is_none())
                    .map(String::as_str)
                    .collect();
                if !not_in_table.is_empty() {
                    eprintln!(
                        "fm: {} champion-meta entries not in the FM table (score clamp(winRate) as candidates): {:?}",
                        not_in_table.len(),
                        not_in_table
                    );
                }
                format!(
                    "loaded version={} patches={} champions={}",
                    w.version,
                    w.patches.join(","),
                    w.len()
                )
            }
            None => "absent — legacy compStrength".to_string(),
        };
        meta.fm = fm;
        let champion_meta_for_engine = champion_meta.clone();
        let core = CoreEngine::new(meta, champion_meta_for_engine);
        Ok(Self {
            inner: Arc::new(core),
            champion_meta: Arc::new(champion_meta),
            fm_status,
        })
    }

    #[napi]
    pub fn fm_status(&self) -> String {
        self.fm_status.clone()
    }

    #[napi]
    pub async fn compute(
        &self,
        request_json: String,
        token: &CancelToken,
    ) -> napi::Result<String> {
        let proto_request: proto::EngineRequest = serde_json::from_str(&request_json)
            .map_err(|e| error::invalid_input(vec![], format!("request parse failed: {}", e)))?;

        let champion_meta = (*self.champion_meta).clone();
        let core_request = projection::request_to_core(&proto_request, champion_meta)
            .map_err(error::map_engine_error)?;

        let token_handle = token.inner.clone();
        let engine = self.inner.clone();
        let core_response = tokio::task::spawn_blocking(move || {
            engine.compute(core_request, &token_handle)
        })
        .await
        .map_err(|e| error::internal(format!("join error: {}", e)))?
        .map_err(error::map_engine_error)?;

        let proto_response = projection::core_to_response(core_response);
        serde_json::to_string(&proto_response)
            .map_err(|e| error::internal(format!("response serialize: {}", e)))
    }
}
