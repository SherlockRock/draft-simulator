use crate::pools::Role;
use crate::role_solver::{position_factor, ChampionMeta};
use std::collections::HashMap;

pub const ROLES: [Role; 5] = [
    Role::Top,
    Role::Jungle,
    Role::Middle,
    Role::Adc,
    Role::Support,
];

/// Every role starts at 0.01 — a floor ABOVE the factor's ε / max_share (at
/// most 0.0026 on the 16.19 table), so a never-played role reads 0.01 here as
/// it did under the category factors; a listed secondary reads its share ratio
/// (0.19 / 0.28 / 0.46 at the 16.19 quartiles, against a flat 0.4 before —
/// champion-role-shares design § 6), and coverage is a per-role MAX, so a flex
/// champion covers two roles at once (Pantheon alone: TOP 1.0 and SUPPORT 0.96).
///
/// Per-role maximum `position_factor` across all picks. Index order
/// matches `ROLES`: TOP, JG, MID, ADC, SUP. A pick missing from `meta`
/// contributes nothing (treated as not-listed across all roles).
pub fn per_role_max_factors(
    picks: &[String],
    meta: &HashMap<String, ChampionMeta>,
) -> [f64; 5] {
    let mut maxes = [0.01f64; 5];
    for (idx, role) in ROLES.iter().enumerate() {
        for pick in picks {
            if let Some(m) = meta.get(pick) {
                let f = position_factor(*role, m);
                if f > maxes[idx] {
                    maxes[idx] = f;
                }
            }
        }
    }
    maxes
}

/// Geometric mean (5th root) of the product of per-role max factors.
/// Always in `[0.01, 1.0]`. 1.0 = every role primary-covered. Used as
/// the magnitude-friendly form of role coverage; preserves ordering of
/// raw product but stays at composite scale.
pub fn coverage_score(
    picks: &[String],
    meta: &HashMap<String, ChampionMeta>,
) -> f64 {
    let factors = per_role_max_factors(picks, meta);
    let product: f64 = factors.iter().product();
    product.powf(1.0 / 5.0)
}

/// Returns the gain in `coverage_score` from adding `candidate` to
/// `picks`. The `.max(0.0)` clamp is defensive against floating-point
/// imprecision (the underlying math is monotone non-decreasing — adding
/// a pick can only raise per-role maxes — so the true value is always
/// `>= 0`, but f64 ops can produce tiny negatives like `-1e-17`).
///
/// Used as the pick-side / ban-side coverage signal. For picks the
/// caller passes our team's picks; for bans the caller passes
/// opponent's picks — see `evaluator::role_coverage_for`.
pub fn coverage_marginal_gain(
    picks: &[String],
    candidate: &str,
    meta: &HashMap<String, ChampionMeta>,
) -> f64 {
    let base = coverage_score(picks, meta);
    let mut with = picks.to_vec();
    with.push(candidate.to_string());
    let post = coverage_score(&with, meta);
    (post - base).max(0.0)
}

/// Returns roles whose max position factor over current picks is
/// strictly below `threshold`. Order matches `ROLES`.
///
/// Threshold guidance:
/// - `0.9`: a role is "missing" unless some champion plays it within 10% of
///   its own best role (its share ratio ≥ 0.9 — the continuous analogue of
///   "has it as primary"; recommended for Pick2 pair seeding, so a secondary
///   fallback does not stop us forcing a specialist into the search). The
///   step stays: Ekko JUNGLE 0.909 counts, Quinn TOP 0.890 does not.
/// - `0.4`: a role is "missing" only if no champion plays it at 40% of its
///   best (no caller today)
pub fn missing_roles(
    picks: &[String],
    meta: &HashMap<String, ChampionMeta>,
    threshold: f64,
) -> Vec<Role> {
    let factors = per_role_max_factors(picks, meta);
    ROLES
        .iter()
        .zip(factors.iter())
        .filter(|(_, &f)| f < threshold)
        .map(|(r, _)| *r)
        .collect()
}
