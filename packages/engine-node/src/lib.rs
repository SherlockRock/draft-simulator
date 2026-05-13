//! engine-node: napi-rs FFI wrapper around engine-core. Phase 9 lands the binding surface.

mod data_loader;
mod error;
mod mcts_dispatch;
mod mcts_wire;
mod projection;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use engine_core::cancellation::CancelHandle;
use engine_core::engine::Engine as CoreEngine;
use engine_core::mcts_spike::SpikeFixture;
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
}

#[napi]
pub struct Engine {
    inner: Arc<CoreEngine>,
    champion_meta: Arc<HashMap<String, ChampionMeta>>,
    /// Path to champion-meta.json captured at construction so the lazy MCTS
    /// fixture loader can find the sibling `winrates.json` without a second
    /// option flowing through `CreateEngineOptions`.
    champion_meta_path: PathBuf,
    /// Lazily-built spike fixture. Loaded on first MCTS dispatch and reused
    /// across requests. Wrapped in `Arc` so the spike `Mcts<'_>` can borrow
    /// it through a clone without needing the Engine to outlive the search.
    spike_fixture: Arc<OnceLock<Arc<SpikeFixture>>>,
}

#[napi]
impl Engine {
    #[napi(factory)]
    pub fn create(options: CreateEngineOptions) -> napi::Result<Self> {
        let champion_meta_path = PathBuf::from(&options.champion_meta_path);
        let (meta, champion_meta) = data_loader::load_engine_data(
            &champion_meta_path,
            std::path::Path::new(&options.matchup_data_path),
        )
        .map_err(error::map_load_error)?;
        let champion_meta_for_engine = champion_meta.clone();
        let core = CoreEngine::new(meta, champion_meta_for_engine);
        Ok(Self {
            inner: Arc::new(core),
            champion_meta: Arc::new(champion_meta),
            champion_meta_path,
            spike_fixture: Arc::new(OnceLock::new()),
        })
    }

    /// Lazily resolve (or load) the MCTS spike fixture. Idempotent across
    /// calls; first hit on the MCTS path pays the load cost.
    fn get_or_load_spike_fixture(&self) -> napi::Result<Arc<SpikeFixture>> {
        if let Some(f) = self.spike_fixture.get() {
            return Ok(f.clone());
        }
        let fixture = mcts_dispatch::load_spike_fixture(&self.champion_meta_path)?;
        // get_or_init avoids the racy `set` path; whichever caller wins gets
        // their fixture cached, the loser's load is dropped.
        let cell = self.spike_fixture.clone();
        Ok(cell.get_or_init(|| Arc::new(fixture)).clone())
    }

    #[napi]
    pub async fn compute(
        &self,
        request_json: String,
        token: &CancelToken,
    ) -> napi::Result<String> {
        let proto_request: proto::EngineRequest = serde_json::from_str(&request_json)
            .map_err(|e| error::invalid_input(vec![], format!("request parse failed: {}", e)))?;

        // v5 phase 4: optional dev-only MCTS dispatch. Routed only when the
        // request explicitly asks for it; default (`None`) and `"ab"` both
        // route through the production αβ engine.
        if matches!(
            proto_request.algorithm,
            Some(proto::EngineRequestAlgorithm::Mcts)
        ) {
            let fixture = self.get_or_load_spike_fixture()?;
            let token_handle = token.inner.clone();
            let proto_response = tokio::task::spawn_blocking(move || {
                mcts_dispatch::compute_mcts(&proto_request, fixture, &token_handle)
            })
            .await
            .map_err(|e| error::internal(format!("join error: {}", e)))??;
            return serde_json::to_string(&proto_response)
                .map_err(|e| error::internal(format!("response serialize: {}", e)));
        }

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
