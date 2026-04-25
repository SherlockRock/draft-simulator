//! engine-core: pure Rust draft engine. No napi, no I/O, no Node types.

pub mod draft_state;
pub mod pools;
pub mod protocol_types;
pub mod role_solver;

#[cfg(test)]
mod smoke {
    #[test]
    fn crate_compiles() {
        assert_eq!(2 + 2, 4);
    }
}
