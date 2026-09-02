use engine_core::fm::{FmParseError, FmPerspective, FmWeights, RANK};

/// Deterministic synthetic weights: 4 champions, rank 16, values from an LCG so
/// every pairwise term is non-zero (a zero synergy row would let a missing
/// self-exclusion pass).
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 33) as f64 / (1u64 << 31) as f64) * 0.6 - 0.3
    }
    fn vec16(&mut self) -> String {
        (0..RANK).map(|_| format!("{:.6}", self.next())).collect::<Vec<_>>().join(",")
    }
    fn champ(&mut self, name: &str) -> String {
        let lin = self.next();
        let (s, a, b) = (self.vec16(), self.vec16(), self.vec16());
        format!(
            r#""{name}":{{"linear_expected":{lin:.6},"linear":[0.1,0.2,0.3,0.4,0.5],"synergy":[{s}],"counter_a":[{a}],"counter_b":[{b}]}}"#
        )
    }
}

fn weights_json(scale: f64) -> String {
    let mut g = Lcg(12345);
    let body = ["A", "B", "C", "D"].iter().map(|n| g.champ(n)).collect::<Vec<_>>().join(",");
    format!(
        r#"{{"version":"fm-test","format":1,"rank":16,"scale":{scale},"clamp":[0,1],
            "linear_roles":["TOP","JUNGLE","MIDDLE","BOTTOM","UTILITY"],
            "trained_on":{{"patches":["16.15","16.16"]}},"champions":{{{body}}}}}"#
    )
}

fn w() -> FmWeights { FmWeights::from_json_str(&weights_json(0.7)).unwrap() }
fn s(v: &[&str]) -> Vec<String> { v.iter().map(|x| x.to_string()).collect() }

#[test]
fn parses_and_validates() {
    let fm = w();
    assert_eq!(fm.len(), 4);
    assert_eq!(fm.version, "fm-test");
    assert_eq!(fm.patches, vec!["16.15", "16.16"]);
    assert!((fm.scale - 0.7).abs() < 1e-12);
    assert!(fm.champion("A").is_some() && fm.champion("Zed").is_none());
    let bad_rank = weights_json(0.7).replace(r#""rank":16"#, r#""rank":8"#);
    assert!(matches!(FmWeights::from_json_str(&bad_rank), Err(FmParseError::Rank(8))));
    let bad_scale = weights_json(0.0);
    assert!(matches!(FmWeights::from_json_str(&bad_scale), Err(FmParseError::Scale(_))));
    assert!(matches!(FmWeights::from_json_str("{not json"), Err(FmParseError::Json(_))));
}

#[test]
fn rejects_a_format_other_than_1() {
    // Item 5: format is checked BEFORE rank, so a wrong-format file with a
    // correct rank still fails on format, not on some later field.
    let bad_format = weights_json(0.7).replace(r#""format":1"#, r#""format":2"#);
    assert!(matches!(FmWeights::from_json_str(&bad_format), Err(FmParseError::Format(2))));

    // A missing "format" key defaults to 0 (serde(default)) and is rejected too.
    let no_format = weights_json(0.7).replace(r#""format":1,"#, "");
    assert!(matches!(FmWeights::from_json_str(&no_format), Err(FmParseError::Format(0))));
}

#[test]
fn allocation_sums_difference_to_the_structural_logit_and_marginal_is_the_delta() {
    let fm = w();
    let logit = |blue: &[String], red: &[String]| {
        let pb = fm.perspective(blue, red);
        let pr = fm.perspective(red, blue);
        blue.iter().map(|c| fm.allocation(fm.champion(c).unwrap(), &pb, true)).sum::<f64>()
            - red.iter().map(|c| fm.allocation(fm.champion(c).unwrap(), &pr, true)).sum::<f64>()
    };
    let blue = s(&["A", "B"]);
    let red = s(&["C"]);
    let before = logit(&blue, &red);
    let after = logit(&s(&["A", "B", "D"]), &red);
    let m = fm.marginal(fm.champion("D").unwrap(), &fm.perspective(&blue, &red), false);
    assert!((after - before - m).abs() < 1e-12, "{after} - {before} != {m}");
    // red's perspective: same function, sides swapped, sign flipped
    let after_r = logit(&blue, &s(&["C", "D"]));
    let m_r = fm.marginal(fm.champion("D").unwrap(), &fm.perspective(&red, &blue), false);
    assert!((before - after_r - m_r).abs() < 1e-12);
}

#[test]
fn self_exclusion_holds_on_a_non_empty_team() {
    // design §5: the empty-team case passes trivially — that is where the bug hid.
    let fm = w();
    let team = s(&["A", "B"]);
    let opp = s(&["C"]);
    let d = fm.champion("D").unwrap();
    let as_candidate = fm.marginal(d, &fm.perspective(&team, &opp), false);
    let as_member = fm.marginal(d, &fm.perspective(&s(&["A", "B", "D"]), &opp), true);
    assert!((as_candidate - as_member).abs() < 1e-12);
    let norm2: f64 = d.synergy.iter().map(|x| x * x).sum();
    assert!(norm2 > 1e-4, "fixture must have a non-trivial synergy row");
}

#[test]
fn unknown_teammates_and_opponents_contribute_nothing() {
    let fm = w();
    let p1 = fm.perspective(&s(&["A"]), &s(&["C"]));
    let p2 = fm.perspective(&s(&["A", "NewChampion"]), &s(&["C", "OtherNew"]));
    assert_eq!(p1, p2);
    assert_eq!(fm.perspective(&[], &[]), FmPerspective::default());
}

#[test]
fn comp_strength_maps_scales_clamps_and_counts() {
    let fm = FmWeights::from_json_str(&weights_json(50.0)).unwrap(); // absurd scale forces clamping
    let p = fm.perspective(&s(&["A", "B"]), &s(&["C"]));
    let d = fm.champion("D").unwrap();
    let v = fm.comp_strength(d, &p, false);
    assert!(v == 0.0 || v == 1.0, "scale 50 must saturate: {v}");
    let (scored, clamped) = fm.clamp_stats();
    assert_eq!((scored, clamped), (1, 1));
    fm.reset_clamp_stats();
    assert_eq!(fm.clamp_stats(), (0, 0));

    let fm = w();
    let v = fm.comp_strength(d, &p, false);
    let want = 0.5 + 0.7 * fm.marginal(d, &p, false);
    assert!((v - want).abs() < 1e-12);
    assert_eq!(fm.clamp_stats(), (1, 0));
}

use engine_core::draft_state::{ActionType, DraftState, Phase, Side};
use engine_core::evaluator::{score_pick, EvalContext, MetaData, PhaseWeightTable, PhaseWeights};
use engine_core::pools::{Penalties, Role, RolePoolMap, TeamPool};
use std::collections::HashMap;
use std::sync::Arc;

fn flat_weights() -> PhaseWeightTable {
    let w = PhaseWeights { info: 0.0, comp: 1.0, coverage: 0.0 };
    PhaseWeightTable { ban1: w, pick1: w, ban2: w, pick2: w }
}

fn empty_pool() -> TeamPool {
    TeamPool {
        display: RolePoolMap { top: vec![], jungle: vec![], middle: vec![], adc: vec![], support: vec![] },
        search: vec![],
    }
}

/// Fixture context (design §5): comp = 1, info = 0, coverage = 0, no pool penalty.
fn fm_ctx(fm: Option<Arc<FmWeights>>, our: &[&str], opp: &[&str]) -> EvalContext {
    let mut win_rates = HashMap::new();
    win_rates.insert("Unlisted".to_string(), 0.61);
    win_rates.insert("Bottomed".to_string(), -0.2);
    EvalContext {
        side: Side::Blue,
        phase: Phase::Pick1,
        our_pool: empty_pool(),
        opp_pool: empty_pool(),
        our_picks: s(our),
        opp_picks: s(opp),
        penalties: Penalties { out_of_role: 0.0, out_of_pool: 0.0 },
        champion_meta: HashMap::new(),
        meta: MetaData { win_rates, fm, ..Default::default() },
        phase_weights_blue: flat_weights(),
        phase_weights_red: flat_weights(),
        synergy_multiplier: 1.0,
        counter_multiplier: 1.0,
        flex_retention_weight: 1.0,
        reveal_cost_weight: 1.0,
        fm: None,
    }
}

#[test]
fn candidate_uses_marginal_and_team_member_uses_allocation() {
    // The SAME champion, A, scored twice: as a candidate (team = {B}) and as a
    // member (team = {A, B}). Same teammates either way, so the only difference
    // is the mode — marginal vs allocation — which halves the pairwise terms.
    let fm = Arc::new(w());
    let state = DraftState::default();
    let a = fm.champion("A").unwrap();

    let as_candidate_ctx = fm_ctx(Some(fm.clone()), &["B"], &["C"]);
    let p_cand = fm.perspective(&s(&["B"]), &s(&["C"]));
    let cand = score_pick("A", Role::Top, &state, &as_candidate_ctx, ActionType::Pick).compStrength;
    assert!((cand - (0.5 + fm.scale * fm.marginal(a, &p_cand, false))).abs() < 1e-12);

    let as_member_ctx = fm_ctx(Some(fm.clone()), &["A", "B"], &["C"]);
    let p_mem = fm.perspective(&s(&["A", "B"]), &s(&["C"]));
    let member = score_pick("A", Role::Top, &state, &as_member_ctx, ActionType::Pick).compStrength;
    assert!((member - (0.5 + fm.scale * fm.allocation(a, &p_mem, true))).abs() < 1e-12);

    // pairwise terms are non-zero in the fixture, so halving them is visible
    assert!((cand - member).abs() > 1e-9, "candidate {cand} vs member {member} must differ");
    // and the halving is exactly what separates them: member − 0.5 = scale × (lin + ½(m − lin))
    let lin = a.linear_expected;
    let m = fm.marginal(a, &p_cand, false);
    assert!(((member - 0.5) / fm.scale - (lin + 0.5 * (m - lin))).abs() < 1e-12);
}

#[test]
fn ban_candidates_go_through_marginal_too() {
    let fm = Arc::new(w());
    let state = DraftState::default();
    let ctx = fm_ctx(Some(fm), &["A"], &["C"]);
    let pick = score_pick("D", Role::Top, &state, &ctx, ActionType::Pick).compStrength;
    let ban = score_pick("D", Role::Top, &state, &ctx, ActionType::Ban).compStrength;
    assert_eq!(pick, ban);
}

#[test]
fn missing_candidate_falls_back_to_the_clamped_win_rate_only() {
    let fm = Arc::new(w());
    let state = DraftState::default();
    let ctx = fm_ctx(Some(fm), &["A"], &["C"]);
    assert_eq!(score_pick("Unlisted", Role::Top, &state, &ctx, ActionType::Pick).compStrength, 0.61);
    assert_eq!(score_pick("Bottomed", Role::Top, &state, &ctx, ActionType::Pick).compStrength, 0.0);
    assert_eq!(score_pick("NoWinRateEither", Role::Top, &state, &ctx, ActionType::Pick).compStrength, 0.5);
}

#[test]
fn precomputed_perspective_matches_on_demand() {
    let fm = Arc::new(w());
    let mut state = DraftState::default();
    state.blue_picks = s(&["A", "B"]);
    state.red_picks = s(&["C"]);
    let base = fm_ctx(Some(fm), &[], &[]);
    let hot = base.for_perspective(Side::Blue, &state, Phase::Pick1); // fills ctx.fm
    assert!(hot.fm.is_some());
    let mut cold = hot.clone();
    cold.fm = None;
    for c in ["D", "A"] {
        let h = score_pick(c, Role::Top, &state, &hot, ActionType::Pick).compStrength;
        let k = score_pick(c, Role::Top, &state, &cold, ActionType::Pick).compStrength;
        assert_eq!(h, k, "{c}");
    }
}

#[test]
#[should_panic(expected = "opposing team")]
fn scoring_an_opponents_champion_is_a_broken_invariant() {
    let fm = Arc::new(w());
    let ctx = fm_ctx(Some(fm), &["A"], &["C"]);
    let _ = score_pick("C", Role::Top, &DraftState::default(), &ctx, ActionType::Pick);
}

#[test]
#[should_panic(expected = "opposing team")]
fn scoring_a_missing_champion_on_the_opposing_team_is_still_a_broken_invariant() {
    // Item 3: the opposing-team assert must run even when the champion is not
    // in the FM export — previously it sat after the `fm.champion(..)` early
    // return, so a missing opponent's champion silently skipped the invariant.
    let fm = Arc::new(w());
    let ctx = fm_ctx(Some(fm), &["A"], &["NotInExport"]);
    let _ = score_pick("NotInExport", Role::Top, &DraftState::default(), &ctx, ActionType::Pick);
}

#[test]
fn without_weights_the_legacy_path_is_unchanged() {
    let state = DraftState::default();
    let ctx = fm_ctx(None, &["A"], &["C"]);
    assert_eq!(score_pick("Unlisted", Role::Top, &state, &ctx, ActionType::Pick).compStrength, 0.61);
    assert_eq!(score_pick("A", Role::Top, &state, &ctx, ActionType::Pick).compStrength, 0.5);
}
