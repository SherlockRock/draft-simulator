//! engine-core: pure Rust draft engine. No napi, no I/O, no Node types.

pub mod cancellation;
pub mod draft_state;
pub mod evaluator;
pub mod iterative_deepening;
pub mod pair_filter;
pub mod pools;
pub mod protocol_types;
pub mod role_solver;
pub mod search;
pub mod transposition;

#[cfg(test)]
mod smoke {
    #[test]
    fn crate_compiles() {
        assert_eq!(2 + 2, 4);
    }
}
