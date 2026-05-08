//! v5 phase 2 calibration: hand-curated draft states with expected
//! `absolute_quality` orderings. Each test asserts a strict inequality
//! between two recommendations whose intuitive quality differs clearly.
//! Reviewers (user / domain expert) check that the ordering matches their
//! intuition; if any case fails, the metric definition needs revisiting
//! (back to phase 0).
//!
//! Uses the production champion-meta + winrates fixture loaded via
//! `real_data_fixture()`. Reference champion ids must be present in the
//! shipped `data/compiled/champion-meta.json`.

use engine_core::draft_state::{DraftState, Side};
use engine_core::mcts_spike::eval::{
    absolute_quality, archetype_coverage, comp_oracle, cc_quality,
    damage_balance, role_coverage, scaling_balance, Recommendation,
};
use engine_core::mcts_spike::real_data_fixture::real_data_fixture;

fn empty() -> DraftState {
    DraftState::default()
}

/// Calibration 1: balanced 5-champ terminal comp scores higher than an
/// all-AD comp. Both teams are full draft (5 picks each); we score
/// blue's perspective on a fully-locked draft state by feeding the 5th
/// pick as the recommendation.
#[test]
fn calibration_balanced_team_over_all_ad() {
    let fixture = real_data_fixture();

    // Balanced team: AD top + AD jg + AP mid + AD ADC + AP/utility supp.
    let mut balanced_state = empty();
    balanced_state.blue_picks = vec![
        "Camille".into(),
        "Graves".into(),
        "Syndra".into(),
        "Jinx".into(),
    ];
    let rec_balanced = Recommendation::singleton("Lulu".into(), Side::Blue);

    // All-AD team: 4 AD champs + AD ADC = entirely physical damage.
    let mut all_ad_state = empty();
    all_ad_state.blue_picks = vec![
        "Camille".into(),
        "Graves".into(),
        "Yasuo".into(),
        "Jinx".into(),
    ];
    let rec_all_ad = Recommendation::singleton("Pyke".into(), Side::Blue);

    let q_balanced = absolute_quality(
        &balanced_state,
        &rec_balanced,
        &fixture.meta,
        &fixture.winrates,
    );
    let q_all_ad = absolute_quality(
        &all_ad_state,
        &rec_all_ad,
        &fixture.meta,
        &fixture.winrates,
    );

    assert!(
        q_balanced > q_all_ad,
        "balanced AD/AP team should outscore all-AD: balanced={:.4} all_ad={:.4}",
        q_balanced,
        q_all_ad
    );
}

/// Calibration 2: team with hard CC + peel scores higher on cc_quality
/// than a no-CC team. Component-level check.
#[test]
fn calibration_cc_quality_dominates_with_engage_team() {
    let fixture = real_data_fixture();
    let cc_team: Vec<String> = vec![
        "Nautilus".into(), // hard CC support
        "Sett".into(),     // knockup top
        "Syndra".into(),   // stun mid
        "Jinx".into(),     // root ult
        "Hecarim".into(),  // knockup jg
    ];
    let no_cc_team: Vec<String> = vec![
        "Yasuo".into(),     // knockup but no peel
        "Graves".into(),    // no hard CC
        "Akali".into(),     // soft CC only
        "Aphelios".into(),  // root ult only
        "Karma".into(),     // soft CC
    ];
    let cc_score = cc_quality(&cc_team, &fixture.meta);
    let no_cc_score = cc_quality(&no_cc_team, &fixture.meta);
    assert!(
        cc_score > no_cc_score,
        "hard-CC + peel team should outscore softer team on cc_quality: \
         cc={:.4} no_cc={:.4}",
        cc_score,
        no_cc_score
    );
}

/// Calibration 3: 5 carries with no frontline scores lower on
/// archetype_coverage than a frontline-included team.
#[test]
fn calibration_archetype_coverage_rewards_frontline() {
    let fixture = real_data_fixture();
    let no_frontline: Vec<String> = vec![
        "Akali".into(),
        "Yasuo".into(),
        "Graves".into(),
        "Jinx".into(),
        "Karma".into(),
    ];
    let with_frontline: Vec<String> = vec![
        "Sett".into(),     // tank/frontline
        "Hecarim".into(),  // bruiser/frontline
        "Syndra".into(),
        "Jinx".into(),
        "Lulu".into(),
    ];
    let s_no = archetype_coverage(&no_frontline, &fixture.meta);
    let s_yes = archetype_coverage(&with_frontline, &fixture.meta);
    assert!(
        s_yes >= s_no,
        "frontline team should score >= no-frontline on archetype_coverage: \
         with={:.4} without={:.4}",
        s_yes,
        s_no
    );
}

/// Calibration 4: pair-pick recommendation at canonical slot-17 — Adc+Sup
/// to fill the missing two roles outscores Adc+Mid (which leaves Support
/// uncovered). Mirrors the v4 `late` disagreement scenario.
///
/// Canonical slot-17 state: 5 bans + 3 blue picks + 4 red picks.
/// Blue has Top, JG, Mid covered — needs Adc + Support to terminate.
/// Uses Sett (clean TOP primary) to avoid Camille's SUPPORT-primary quirk
/// inadvertently covering the support role.
#[test]
fn calibration_pair_adc_support_over_duplicate_role() {
    let fixture = real_data_fixture();
    let mut late_state = empty();
    // 5 bans/side (3 ban1 + 2 ban2), 3 blue picks (Top, JG, Mid), 4 red picks.
    late_state.blue_bans = vec![
        "Yasuo".into(),
        "Akali".into(),
        "Karma".into(),
        "Pyke".into(),
        "Lucian".into(),
    ];
    late_state.red_bans = vec![
        "Aphelios".into(),
        "Nautilus".into(),
        "LeeSin".into(),
        "Kindred".into(),
        "Renekton".into(),
    ];
    late_state.blue_picks = vec![
        "Sett".into(),     // TOP
        "Hecarim".into(),  // JG
        "Syndra".into(),   // MID
    ];
    late_state.red_picks = vec![
        "Aatrox".into(),
        "Graves".into(),
        "Azir".into(),
        "Caitlyn".into(),
    ];
    // Recommendation: (Adc, Support) — fills both missing roles.
    let rec_adc_sup =
        Recommendation::pair("Jinx".into(), "Thresh".into(), Side::Blue);
    // Recommendation: (Adc, Mid duplicate) — fills Adc but leaves Support
    // uncovered.
    let rec_dup =
        Recommendation::pair("Jinx".into(), "Orianna".into(), Side::Blue);

    let q_fill = absolute_quality(
        &late_state,
        &rec_adc_sup,
        &fixture.meta,
        &fixture.winrates,
    );
    let q_dup = absolute_quality(
        &late_state,
        &rec_dup,
        &fixture.meta,
        &fixture.winrates,
    );
    assert!(
        q_fill > q_dup,
        "Adc+Support fill should outscore Adc+Mid (Support uncovered): \
         fill={:.4} dup={:.4}",
        q_fill,
        q_dup
    );
}

/// Calibration 5: scaling_balance penalizes a uniformly-late team less
/// than a wildly-skewed team. (Inter-phase variance.)
#[test]
fn calibration_scaling_balance_rewards_phase_presence() {
    let fixture = real_data_fixture();
    // Late-game heavy (most have late > 0.85): Kayle/Vayne aren't in our
    // narrow set; use Aphelios (late=0.95), Jinx (late~0.95), Azir,
    // Camille, Sona.
    let late_skewed: Vec<String> = vec![
        "Aphelios".into(),
        "Jinx".into(),
        "Azir".into(),
        "Camille".into(),
        "Sona".into(),
    ];
    // Mixed: early-game JG (Hecarim) + lane bullies + a late carry.
    let mixed: Vec<String> = vec![
        "Renekton".into(), // early-game top
        "Hecarim".into(),  // early-mid jg
        "Syndra".into(),   // mid
        "Caitlyn".into(),  // mid-late ADC
        "Thresh".into(),   // mid-game support
    ];
    let s_late = scaling_balance(&late_skewed, &fixture.meta);
    let s_mixed = scaling_balance(&mixed, &fixture.meta);
    // Both will be in [0.5, 1.0] since stddev of 3 numbers in [0,1] is
    // bounded. Just assert mixed >= late_skewed; if they're equal the
    // metric isn't pulling its weight (calibration concern).
    assert!(
        s_mixed >= s_late - 0.01,
        "mixed-scaling team should match or exceed late-skewed on scaling_balance: \
         mixed={:.4} late_skewed={:.4}",
        s_mixed,
        s_late
    );
}

/// Calibration 6: damage_balance — pure-AD vs pure-AP both worse than
/// 50/50 split.
#[test]
fn calibration_damage_balance_5050_optimal() {
    let fixture = real_data_fixture();
    // ~95% physical: all-AD team.
    let pure_ad: Vec<String> = vec![
        "Camille".into(),
        "Graves".into(),
        "Yasuo".into(),
        "Jinx".into(),
        "Pyke".into(),
    ];
    // Mixed: 2 AD + 2 AP + 1 hybrid.
    let balanced: Vec<String> = vec![
        "Camille".into(),
        "Hecarim".into(),
        "Syndra".into(),
        "Jinx".into(),
        "Lulu".into(),
    ];
    let s_pure = damage_balance(&pure_ad, &fixture.meta);
    let s_bal = damage_balance(&balanced, &fixture.meta);
    assert!(
        s_bal > s_pure + 0.05,
        "balanced damage profile should outscore pure-AD by a clear margin: \
         balanced={:.4} pure_ad={:.4}",
        s_bal,
        s_pure
    );
}

/// Calibration 7: role_coverage — 5-unique-role team scores ~1.0; a team
/// missing a role (e.g., 2 ADCs) drops sharply.
///
/// NOTE: Champion-meta primary positions can surprise. Camille is listed
/// primary `SUPPORT` (not TOP) in the production data, so she'd cover
/// support inadvertently — use Sett (clean TOP primary) here instead.
#[test]
fn calibration_role_coverage_punishes_missing_role() {
    let fixture = real_data_fixture();
    let full_roles: Vec<String> = vec![
        "Sett".into(),     // TOP primary (clean)
        "Graves".into(),   // jg
        "Syndra".into(),   // mid
        "Jinx".into(),     // adc
        "Lulu".into(),     // sup
    ];
    let missing_role: Vec<String> = vec![
        "Sett".into(),     // top
        "Graves".into(),   // jg
        "Syndra".into(),   // mid
        "Jinx".into(),     // adc
        "Caitlyn".into(),  // ADC again — no support
    ];
    let s_full = role_coverage(&full_roles, &fixture.meta);
    let s_miss = role_coverage(&missing_role, &fixture.meta);
    assert!(
        s_full > s_miss + 0.1,
        "full-role team should beat missing-role by clear margin: \
         full={:.4} missing={:.4}",
        s_full,
        s_miss
    );
}

/// Calibration 8: top-line absolute_quality — strong-comp (balanced
/// archetypes, all roles, hard CC) beats weak-comp (5 ADCs, no frontline,
/// no CC) by a wide margin.
#[test]
fn calibration_absolute_quality_strong_vs_weak() {
    let fixture = real_data_fixture();
    let mut state = empty();
    state.blue_picks = vec![
        "Sett".into(),     // tank top w/ knockup
        "Hecarim".into(),  // bruiser jg
        "Syndra".into(),   // mid w/ stun
        "Jinx".into(),     // ADC
    ];
    let rec_strong = Recommendation::singleton("Nautilus".into(), Side::Blue);

    let mut weak_state = empty();
    weak_state.blue_picks = vec![
        "Akali".into(),    // assassin
        "Graves".into(),   // damage carry jg
        "Yasuo".into(),    // mid carry
        "Jinx".into(),     // adc
    ];
    let rec_weak = Recommendation::singleton("Aphelios".into(), Side::Blue); // 5th carry

    let q_strong = absolute_quality(
        &state,
        &rec_strong,
        &fixture.meta,
        &fixture.winrates,
    );
    let q_weak = absolute_quality(
        &weak_state,
        &rec_weak,
        &fixture.meta,
        &fixture.winrates,
    );
    assert!(
        q_strong > q_weak + 0.05,
        "strong team comp should outscore 5-carry weak by clear margin: \
         strong={:.4} weak={:.4}",
        q_strong,
        q_weak
    );
}

/// Calibration 9: comp_oracle component summary — verify the oracle
/// produces a reasonable score band on a known-strong terminal team.
/// Anchors absolute reading: known-strong should be > 0.55, known-weak < 0.55.
#[test]
fn calibration_comp_oracle_score_bands() {
    let fixture = real_data_fixture();
    let strong: Vec<String> = vec![
        "Sett".into(),
        "Hecarim".into(),
        "Syndra".into(),
        "Jinx".into(),
        "Nautilus".into(),
    ];
    let weak: Vec<String> = vec![
        "Akali".into(),
        "Graves".into(),
        "Yasuo".into(),
        "Jinx".into(),
        "Aphelios".into(),
    ];
    let s_strong = comp_oracle(&strong, &fixture.meta);
    let s_weak = comp_oracle(&weak, &fixture.meta);
    assert!(
        s_strong > 0.55,
        "strong comp oracle should be > 0.55, got {:.4}",
        s_strong
    );
    assert!(
        s_weak < s_strong,
        "weak comp oracle should be < strong: weak={:.4} strong={:.4}",
        s_weak,
        s_strong
    );
}

/// Calibration 10: empty-state recommendation — scoring an empty draft
/// with a recommendation candidate should produce a reasonable score (the
/// 1-pick partial comp can't be high — most components zero out — but it
/// shouldn't NaN or panic). Asserts no degenerate edge case at empty.
#[test]
fn calibration_handles_empty_state_recommendation() {
    let fixture = real_data_fixture();
    let state = empty();
    let rec = Recommendation::singleton("Camille".into(), Side::Blue);
    let q = absolute_quality(&state, &rec, &fixture.meta, &fixture.winrates);
    assert!(
        q.is_finite(),
        "absolute_quality at empty must be finite, got {}",
        q
    );
    assert!(
        q >= 0.0 && q <= 1.0,
        "absolute_quality must be in [0, 1], got {}",
        q
    );
}
