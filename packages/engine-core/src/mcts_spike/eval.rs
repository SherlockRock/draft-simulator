//! v5 phase 2: absolute_quality scorer.
//!
//! Hybrid scorer per `docs/spikes/v5-metrics.md`:
//!   Q = 0.7 * comp_oracle + 0.3 * normalized_winrate_diff
//!
//! Independent from `score_pick.composite` — uses champion-meta's
//! damageProfile, scalingProfile, ccProfile, and tags.archetype features
//! that the engines don't optimize against. Avoids the v3/v4 problem of
//! "we measured how well two implementations of the same scoring agreed."
//!
//! Components are public so calibration tests can pin specific axes; the
//! load-bearing entry point is `absolute_quality(state, recommendation,
//! fixture)`.

use crate::coverage::coverage_score;
use crate::draft_state::{DraftState, Side};
use crate::role_solver::ChampionMeta;
use std::collections::{HashMap, HashSet};

/// 0.7 weighting for the comp-construction oracle, 0.3 for winrate-sum.
/// Locked at phase 0; do not adjust without re-running calibration.
pub const ORACLE_WEIGHT: f64 = 0.7;
pub const WINRATE_WEIGHT: f64 = 0.3;

/// Hard CC types — single-pick presence flips the cc_quality indicator on.
/// Curated from observed `cc_types` values in the production champion-meta:
/// stun, knockup, root, taunt, charm, fear, suppression, sleep, knockback,
/// pull, slow (slow excluded — too soft).
const HARD_CC_TYPES: &[&str] = &[
    "stun",
    "knockup",
    "root",
    "taunt",
    "charm",
    "fear",
    "suppression",
    "sleep",
    "knockback",
    "pull",
    "silence",
    "polymorph",
    "ground",
];

/// Archetype categorization used by `archetype_coverage`. A pick with any
/// matching tag covers the corresponding category. Categories computed
/// independently — a single champion can cover multiple.
fn archetype_categories() -> [(&'static str, &'static [&'static str]); 3] {
    [
        (
            "frontline",
            &[
                "frontline",
                "juggernaut",
                "tank",
                "vanguard",
                "warden",
                "drain_tank",
            ],
        ),
        (
            "threat",
            &[
                "assassin",
                "burst_damage",
                "sustained_damage",
                "marksman",
                "mage_burst",
                "ad_threat",
                "ap_threat",
            ],
        ),
        (
            "utility",
            &[
                "enchanter",
                "peel",
                "engage",
                "disengage",
                "catcher",
                "roamer",
            ],
        ),
    ]
}

fn clip01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

/// Damage balance: 1 - 2 * |physical_share - 0.5|.
/// `physical_share = sum(physical) / sum(physical+magic+true)` over picks.
/// Empty picks → 0.5 (perfectly neutral, treated as balanced).
pub fn damage_balance(picks: &[String], meta: &HashMap<String, ChampionMeta>) -> f64 {
    if picks.is_empty() {
        return 0.5;
    }
    let mut phys = 0.0f64;
    let mut magic = 0.0f64;
    let mut true_dmg = 0.0f64;
    for c in picks {
        let Some(m) = meta.get(c) else { continue };
        phys += m.damage_profile.physical;
        magic += m.damage_profile.magic;
        true_dmg += m.damage_profile.r#true;
    }
    let total = phys + magic + true_dmg;
    if total <= 0.0 {
        return 0.5;
    }
    let phys_share = phys / total;
    clip01(1.0 - 2.0 * (phys_share - 0.5).abs())
}

/// CC quality: 0.5 * has_hard_cc + 0.5 * mean(engage + peel) clamped.
/// `has_hard_cc` = any pick has a cc_type in `HARD_CC_TYPES`. Empty picks
/// → 0 (no CC means no cc_quality).
pub fn cc_quality(picks: &[String], meta: &HashMap<String, ChampionMeta>) -> f64 {
    if picks.is_empty() {
        return 0.0;
    }
    let hard_set: HashSet<&str> = HARD_CC_TYPES.iter().copied().collect();
    let mut has_hard = false;
    let mut engage_sum = 0.0f64;
    let mut peel_sum = 0.0f64;
    let mut counted = 0usize;
    for c in picks {
        let Some(m) = meta.get(c) else { continue };
        if m.cc_profile.has_cc {
            for t in &m.cc_profile.cc_types {
                if hard_set.contains(t.as_str()) {
                    has_hard = true;
                    break;
                }
            }
        }
        engage_sum += m.cc_profile.engage_quality;
        peel_sum += m.cc_profile.peel_quality;
        counted += 1;
    }
    let qual_mean = if counted == 0 {
        0.0
    } else {
        (engage_sum + peel_sum) / (counted as f64)
    };
    let hard = if has_hard { 1.0 } else { 0.0 };
    clip01(0.5 * hard + 0.5 * qual_mean)
}

/// Scaling balance: 1 - stddev([team_mean_early, team_mean_mid,
/// team_mean_late]). Rewards teams with similar presence across all 3 game
/// phases. Empty picks → 0.5 (no signal, neutral). Stddev of 3 values in
/// [0,1] tops out around ~0.47 (when one phase is 1.0 and the others 0.0),
/// so the score lower-bound is ~0.53 — clamp anyway.
pub fn scaling_balance(picks: &[String], meta: &HashMap<String, ChampionMeta>) -> f64 {
    if picks.is_empty() {
        return 0.5;
    }
    let mut early = 0.0f64;
    let mut mid = 0.0f64;
    let mut late = 0.0f64;
    let mut counted = 0usize;
    for c in picks {
        let Some(m) = meta.get(c) else { continue };
        early += m.scaling_profile.early;
        mid += m.scaling_profile.mid;
        late += m.scaling_profile.late;
        counted += 1;
    }
    if counted == 0 {
        return 0.5;
    }
    let n = counted as f64;
    let me = early / n;
    let mm = mid / n;
    let ml = late / n;
    let mean = (me + mm + ml) / 3.0;
    let var = ((me - mean).powi(2) + (mm - mean).powi(2) + (ml - mean).powi(2)) / 3.0;
    clip01(1.0 - var.sqrt())
}

/// Archetype coverage: fraction of {frontline, threat, utility} categories
/// the team covers. Empty picks → 0.0.
pub fn archetype_coverage(picks: &[String], meta: &HashMap<String, ChampionMeta>) -> f64 {
    let categories = archetype_categories();
    let mut covered = 0usize;
    for (_, tags) in &categories {
        let tag_set: HashSet<&str> = tags.iter().copied().collect();
        let mut hit = false;
        for c in picks {
            let Some(m) = meta.get(c) else { continue };
            for t in &m.tags.archetype {
                if tag_set.contains(t.as_str()) {
                    hit = true;
                    break;
                }
            }
            if hit {
                break;
            }
        }
        if hit {
            covered += 1;
        }
    }
    (covered as f64) / (categories.len() as f64)
}

/// Existing per-side coverage (geometric mean of per-role max position
/// factors). Range `[0.01, 1.0]`; clamp to [0,1] for component blending.
pub fn role_coverage(picks: &[String], meta: &HashMap<String, ChampionMeta>) -> f64 {
    clip01(coverage_score(picks, meta))
}

/// 5-component oracle, equal-weighted mean.
pub fn comp_oracle(picks: &[String], meta: &HashMap<String, ChampionMeta>) -> f64 {
    (damage_balance(picks, meta)
        + cc_quality(picks, meta)
        + scaling_balance(picks, meta)
        + archetype_coverage(picks, meta)
        + role_coverage(picks, meta))
        / 5.0
}

/// Normalized winrate-diff: clip01((sum(our_wr) - sum(opp_wr) + 5) / 10).
/// Per-pick winrates default to 0.5 for missing entries (mirrors
/// `terminal_eval`). The +5/10 normalization maps worst-case `[-5, +5]` to
/// `[0, 1]`.
pub fn normalized_winrate_diff(
    our_picks: &[String],
    opp_picks: &[String],
    winrates: &HashMap<String, f64>,
) -> f64 {
    let our_wr: f64 = our_picks
        .iter()
        .map(|c| winrates.get(c).copied().unwrap_or(0.5))
        .sum();
    let opp_wr: f64 = opp_picks
        .iter()
        .map(|c| winrates.get(c).copied().unwrap_or(0.5))
        .sum();
    clip01((our_wr - opp_wr + 5.0) / 10.0)
}

/// Recommendation shape: 1 champion (singleton) or 2 (pair). Pair turns
/// land both halves on the picking side at adjacent slots.
#[derive(Clone, Debug)]
pub struct Recommendation {
    pub champion_ids: Vec<String>,
    pub side: Side,
}

impl Recommendation {
    pub fn singleton(champion: String, side: Side) -> Self {
        Self { champion_ids: vec![champion], side }
    }

    pub fn pair(first: String, second: String, side: Side) -> Self {
        Self { champion_ids: vec![first, second], side }
    }
}

/// Apply `recommendation` to `state` and score the projected partial comp.
/// `Q = 0.7 * comp_oracle + 0.3 * normalized_winrate_diff`, where the
/// oracle is over the picking side's projected picks and the winrate diff
/// is `our - opp` from the picking side's perspective.
pub fn absolute_quality(
    state: &DraftState,
    recommendation: &Recommendation,
    meta: &HashMap<String, ChampionMeta>,
    winrates: &HashMap<String, f64>,
) -> f64 {
    let mut our_picks = match recommendation.side {
        Side::Blue => state.blue_picks.clone(),
        Side::Red => state.red_picks.clone(),
    };
    let opp_picks = match recommendation.side {
        Side::Blue => state.red_picks.clone(),
        Side::Red => state.blue_picks.clone(),
    };
    our_picks.extend(recommendation.champion_ids.iter().cloned());

    let oracle = comp_oracle(&our_picks, meta);
    let wr_diff = normalized_winrate_diff(&our_picks, &opp_picks, winrates);
    ORACLE_WEIGHT * oracle + WINRATE_WEIGHT * wr_diff
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pools::Role;
    use crate::role_solver::{
        CcProfile, ChampionMeta, ChampionTags, DamageProfile, ScalingProfile,
    };

    fn fake_meta() -> HashMap<String, ChampionMeta> {
        let mut m = HashMap::new();
        // Frontline tank with peel CC, mid-late scaling.
        m.insert(
            "TankFrontline".into(),
            ChampionMeta {
                id: "TankFrontline".into(),
                positions: vec![Role::Top],
                damage_profile: DamageProfile {
                    physical: 0.7,
                    magic: 0.2,
                    r#true: 0.1,
                },
                scaling_profile: ScalingProfile { early: 0.3, mid: 0.6, late: 0.8 },
                cc_profile: CcProfile {
                    has_cc: true,
                    cc_types: vec!["stun".into()],
                    engage_quality: 0.6,
                    peel_quality: 0.4,
                },
                tags: ChampionTags {
                    archetype: vec!["frontline".into(), "tank".into()],
                    synergy: vec!["frontline".into()],
                },
            },
        );
        // ADC marksman, late-game, low CC.
        m.insert(
            "AdcMarksman".into(),
            ChampionMeta {
                id: "AdcMarksman".into(),
                positions: vec![Role::Adc],
                damage_profile: DamageProfile {
                    physical: 0.95,
                    magic: 0.0,
                    r#true: 0.05,
                },
                scaling_profile: ScalingProfile { early: 0.2, mid: 0.7, late: 0.95 },
                cc_profile: CcProfile {
                    has_cc: false,
                    cc_types: vec![],
                    engage_quality: 0.0,
                    peel_quality: 0.0,
                },
                tags: ChampionTags {
                    archetype: vec!["marksman".into(), "sustained_damage".into()],
                    synergy: vec!["ad_threat".into()],
                },
            },
        );
        // Enchanter support, peel.
        m.insert(
            "Enchanter".into(),
            ChampionMeta {
                id: "Enchanter".into(),
                positions: vec![Role::Support],
                damage_profile: DamageProfile {
                    physical: 0.0,
                    magic: 0.95,
                    r#true: 0.05,
                },
                scaling_profile: ScalingProfile { early: 0.4, mid: 0.6, late: 0.7 },
                cc_profile: CcProfile {
                    has_cc: true,
                    cc_types: vec!["root".into()],
                    engage_quality: 0.1,
                    peel_quality: 0.85,
                },
                tags: ChampionTags {
                    archetype: vec!["enchanter".into(), "peel".into()],
                    synergy: vec!["frontline".into()],
                },
            },
        );
        // AP burst mage, mid-late.
        m.insert(
            "BurstMage".into(),
            ChampionMeta {
                id: "BurstMage".into(),
                positions: vec![Role::Middle],
                damage_profile: DamageProfile {
                    physical: 0.05,
                    magic: 0.9,
                    r#true: 0.05,
                },
                scaling_profile: ScalingProfile { early: 0.3, mid: 0.8, late: 0.85 },
                cc_profile: CcProfile {
                    has_cc: true,
                    cc_types: vec!["stun".into()],
                    engage_quality: 0.3,
                    peel_quality: 0.2,
                },
                tags: ChampionTags {
                    archetype: vec!["mage_burst".into(), "burst_damage".into()],
                    synergy: vec!["ap_threat".into()],
                },
            },
        );
        // AD assassin, no CC.
        m.insert(
            "Assassin".into(),
            ChampionMeta {
                id: "Assassin".into(),
                positions: vec![Role::Jungle],
                damage_profile: DamageProfile {
                    physical: 0.95,
                    magic: 0.05,
                    r#true: 0.0,
                },
                scaling_profile: ScalingProfile { early: 0.7, mid: 0.7, late: 0.5 },
                cc_profile: CcProfile {
                    has_cc: false,
                    cc_types: vec![],
                    engage_quality: 0.0,
                    peel_quality: 0.0,
                },
                tags: ChampionTags {
                    archetype: vec!["assassin".into(), "ad_threat".into()],
                    synergy: vec!["ad_threat".into()],
                },
            },
        );
    m
    }

    #[test]
    fn damage_balance_matches_50_50() {
        let m = fake_meta();
        // Tank (70% phys) + Mage (90% magic) ≈ 41% physical → ~0.83 score.
        let picks = vec!["TankFrontline".into(), "BurstMage".into()];
        let s = damage_balance(&picks, &m);
        assert!(s >= 0.7 && s <= 1.0, "expected ~balanced, got {}", s);
    }

    #[test]
    fn damage_balance_penalizes_skewed() {
        let m = fake_meta();
        // 3 AD champs → ~95% phys → score should drop.
        let picks = vec![
            "AdcMarksman".into(),
            "Assassin".into(),
            "TankFrontline".into(),
        ];
        let s = damage_balance(&picks, &m);
        assert!(s < 0.5, "expected skewed-AD penalty, got {}", s);
    }

    #[test]
    fn cc_quality_zero_for_no_cc() {
        let m = fake_meta();
        let picks = vec!["AdcMarksman".into(), "Assassin".into()];
        let s = cc_quality(&picks, &m);
        assert!(s < 0.05, "expected ~0 cc_quality with no CC champs, got {}", s);
    }

    #[test]
    fn cc_quality_high_with_hard_cc_and_peel() {
        let m = fake_meta();
        let picks = vec!["TankFrontline".into(), "Enchanter".into()];
        let s = cc_quality(&picks, &m);
        // hard_cc=1, mean(engage+peel) = mean(0.6+0.4, 0.1+0.85) / count =
        // mean(1.0, 0.95) = 0.975 / 2 = ~0.49 wait — mean(engage+peel) per
        // pick averaged: (1.0+0.95)/2 = 0.975. Score = 0.5 + 0.5*0.975 ≈ 0.99.
        // After clip: ~0.99 (or 1.0 if rounded).
        assert!(s > 0.7, "expected high cc_quality, got {}", s);
    }

    #[test]
    fn archetype_coverage_full_team() {
        let m = fake_meta();
        // Frontline + Threat (marksman) + Utility (enchanter) → 3/3.
        let picks = vec![
            "TankFrontline".into(),
            "AdcMarksman".into(),
            "Enchanter".into(),
        ];
        let s = archetype_coverage(&picks, &m);
        assert!((s - 1.0).abs() < 1e-9, "expected 1.0, got {}", s);
    }

    #[test]
    fn archetype_coverage_partial() {
        let m = fake_meta();
        // Threat-only team — assassin + marksman + burst mage all in
        // "threat" category → 1/3 covered.
        let picks = vec![
            "Assassin".into(),
            "AdcMarksman".into(),
            "BurstMage".into(),
        ];
        let s = archetype_coverage(&picks, &m);
        assert!((s - 1.0 / 3.0).abs() < 1e-9, "expected 0.333, got {}", s);
    }

    #[test]
    fn absolute_quality_full_team_over_threat_team() {
        let m = fake_meta();
        let mut wr = HashMap::new();
        for k in m.keys() {
            wr.insert(k.clone(), 0.5);
        }
        let state = DraftState::default();

        // Full-archetype team (recommendation = the third pick to complete).
        let mut blue_full_state = state.clone();
        blue_full_state.blue_picks =
            vec!["TankFrontline".into(), "AdcMarksman".into()];
        let rec_enchanter =
            Recommendation::singleton("Enchanter".into(), Side::Blue);
        let q_full = absolute_quality(&blue_full_state, &rec_enchanter, &m, &wr);

        // Threat-only team.
        let mut blue_threat_state = state.clone();
        blue_threat_state.blue_picks =
            vec!["Assassin".into(), "AdcMarksman".into()];
        let rec_mage = Recommendation::singleton("BurstMage".into(), Side::Blue);
        let q_threat = absolute_quality(&blue_threat_state, &rec_mage, &m, &wr);

        assert!(
            q_full > q_threat,
            "balanced team should outscore threat-only: full={} threat={}",
            q_full,
            q_threat
        );
    }

    #[test]
    fn winrate_diff_signals_directionally() {
        let mut wr = HashMap::new();
        wr.insert("Strong".into(), 0.6);
        wr.insert("Weak".into(), 0.4);
        let our_strong = vec!["Strong".into(), "Strong".into()];
        let opp_weak = vec!["Weak".into(), "Weak".into()];
        let s_strong_us = normalized_winrate_diff(&our_strong, &opp_weak, &wr);
        let s_weak_us = normalized_winrate_diff(&opp_weak, &our_strong, &wr);
        assert!(s_strong_us > 0.5, "we have stronger picks; got {}", s_strong_us);
        assert!(s_weak_us < 0.5, "we have weaker picks; got {}", s_weak_us);
        // Symmetry check: should sum to 1.0 (clip01 of (a) + clip01 of (-a) = 1).
        assert!(
            (s_strong_us + s_weak_us - 1.0).abs() < 1e-9,
            "complement check failed"
        );
    }
}
