//! engine-core: pure Rust draft engine. No napi, no I/O, no Node types.

#[cfg(test)]
mod smoke {
    #[test]
    fn crate_compiles() {
        assert_eq!(2 + 2, 4);
    }
}
