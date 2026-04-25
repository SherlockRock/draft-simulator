use rayon::ThreadPoolBuilder;
use std::cmp::min;
use std::sync::Once;
use std::thread::available_parallelism;

pub fn ensure_rayon_pool() {
    static INIT: Once = Once::new();

    INIT.call_once(|| {
        let configured_threads = std::env::var("RAYON_NUM_THREADS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|threads| *threads > 0)
            .unwrap_or_else(|| {
                let cores = available_parallelism().map(|n| n.get()).unwrap_or(1);
                min(cores.saturating_sub(1), 4).max(1)
            });
        let _ = ThreadPoolBuilder::new()
            .num_threads(configured_threads)
            .build_global();
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn ensure_rayon_pool_is_idempotent() {
        super::ensure_rayon_pool();
        super::ensure_rayon_pool();
    }
}
