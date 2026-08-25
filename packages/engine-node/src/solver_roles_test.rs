//! Task 2b — the role solver's output for every state the benchmark scores.
//!
//! This lives in engine-node rather than engine-core because it needs
//! `data_loader::load_engine_data`, which is a private module of this crate;
//! engine-core cannot import it and cannot depend on engine-node. The solver
//! itself (`role_solver::solve`) is public engine-core API — no `EvalContext`,
//! no search, no timing.
//!
//! Emits, per team and per state, BOTH quantities gate 4 needs:
//!
//!   * the **max-weight assignment** — which slot a champion occupies at serve
//!     time (ties resolve to the first enumerated permutation, matching
//!     `solve`'s own order); this is the argmax arm.
//!   * the **marginal posterior** `role_probs[champion, role]` — the sum of the
//!     weights of every assignment placing that champion in that role; this is
//!     the gated arm, and the reason the model's role input is a distribution
//!     rather than a token.
//!
//!   cargo test -p engine-node --release solver_roles -- --ignored --nocapture

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use engine_core::pools::Role;
use engine_core::role_solver::{solve, ChampionMeta};

use crate::data_loader::load_engine_data;

const ROLES: [Role; 5] = [Role::Top, Role::Jungle, Role::Middle, Role::Adc, Role::Support];
const ROLE_NAMES: [&str; 5] = ["TOP", "JUNGLE", "MIDDLE", "ADC", "SUPPORT"];
/// The keys `prepare.py` writes under `meta_roles` — champion-meta's own
/// vocabulary, where the ADC role is spelled "BOTTOM". Indexing the JSON with
/// `ROLE_NAMES` reads 0.0 for every marksman's ADC share. Pinned against
/// roles.META_ROLE_NAMES by test_roles_unit.py.
const META_ROLE_NAMES: [&str; 5] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"];
/// A champion is credited with a role in its synthesised meta if that role
/// holds at least this share of its corpus games. Below it, the appearance is
/// noise (an off-role one-off) rather than a position the champion plays.
const SYNTH_ROLE_THRESHOLD: f64 = 0.15;

pub(crate) fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("engine-node lives at packages/engine-node")
        .to_path_buf()
}

// --- a minimal CSV reader; every field here is an alias, an integer or empty --

pub(crate) struct Csv {
    header: HashMap<String, usize>,
    pub(crate) rows: Vec<Vec<String>>,
}

impl Csv {
    pub(crate) fn read(path: &Path) -> Csv {
        let raw = fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("{} — run prepare.py first ({e})", path.display()));
        let mut lines = raw.lines();
        let header: HashMap<String, usize> = lines
            .next()
            .expect("empty csv")
            .split(',')
            .enumerate()
            .map(|(i, name)| (name.trim().to_string(), i))
            .collect();
        let rows = lines
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.split(',').map(|s| s.trim().to_string()).collect())
            .collect();
        Csv { header, rows }
    }

    pub(crate) fn get<'a>(&self, row: &'a [String], name: &str) -> &'a str {
        let i = *self
            .header
            .get(name)
            .unwrap_or_else(|| panic!("column {name:?} missing; have {:?}", self.header.keys()));
        row.get(i).map(String::as_str).unwrap_or("")
    }
}

// --- synthesised meta for champions champion-meta.json does not know ---------

/// champion-meta.json is a separate, stale compile (Task 0 refreshes cdragon,
/// not this). Locke is in 10.9% of corpus games and absent from it, and
/// `solve` panics on an unknown id by contract (`role_solver.rs:85-88`). So
/// synthesise a meta from what the corpus actually shows the champion playing.
fn synthesise_missing_meta(meta: &mut HashMap<String, ChampionMeta>) -> Vec<String> {
    let path = repo_root().join("data/training/role_percentages.json");
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} — run prepare.py first ({e})", path.display()));
    let doc: serde_json::Value = serde_json::from_str(&raw).expect("role_percentages.json parses");
    synthesise_from(&doc, meta)
}

fn synthesise_from(doc: &serde_json::Value, meta: &mut HashMap<String, ChampionMeta>) -> Vec<String> {
    let mut added = Vec::new();
    for (_riot_id, entry) in doc.as_object().expect("object at top level") {
        let alias = entry["alias"].as_str().expect("alias").to_string();
        if meta.contains_key(&alias) {
            continue;
        }
        let shares = &entry["meta_roles"];
        let mut ranked: Vec<(Role, f64)> = ROLES
            .iter()
            .zip(META_ROLE_NAMES)
            .map(|(r, name)| (*r, shares[name].as_f64().unwrap_or(0.0)))
            .filter(|(_, share)| *share >= SYNTH_ROLE_THRESHOLD)
            .collect();
        // Primary first — `position_factor` treats positions[0] specially.
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        if ranked.is_empty() {
            // A champion spread under the threshold in every role still needs a
            // primary, or every assignment would score NON_LISTED_FACTOR and the
            // posterior would be uniform for a champion that plainly is not.
            let best = ROLES
                .iter()
                .zip(META_ROLE_NAMES)
                .max_by(|a, b| {
                    shares[a.1]
                        .as_f64()
                        .unwrap_or(0.0)
                        .partial_cmp(&shares[b.1].as_f64().unwrap_or(0.0))
                        .unwrap()
                })
                .map(|(r, _)| *r)
                .unwrap();
            ranked.push((best, 0.0));
        }
        meta.insert(
            alias.clone(),
            ChampionMeta {
                id: alias.clone(),
                positions: ranked.iter().map(|(r, _)| *r).collect(),
                ..Default::default()
            },
        );
        added.push(alias);
    }
    added.sort();
    added
}

/// A champion in the vocab that neither champion-meta nor the train prior knows
/// (a ban-only or val/test-only pick). `solve` panics on an unknown id by
/// contract, so give it an empty position list: every role scores
/// NON_LISTED_FACTOR and its posterior is uniform — no preference, like UNKNOWN.
fn ensure_known(meta: &mut HashMap<String, ChampionMeta>, champs: &[&str]) -> usize {
    let mut added = 0;
    for c in champs {
        if !meta.contains_key(*c) {
            meta.insert(
                c.to_string(),
                ChampionMeta { id: c.to_string(), positions: vec![], ..Default::default() },
            );
            added += 1;
        }
    }
    added
}

#[test]
fn synthesised_meta_credits_the_adc_role_from_the_bottom_share() {
    let doc = serde_json::json!({
        "999": {"alias": "NewMarksman", "meta_roles":
            {"TOP": 0.0, "JUNGLE": 0.0, "MIDDLE": 0.1, "BOTTOM": 0.9, "SUPPORT": 0.0}}
    });
    let mut meta = HashMap::new();
    synthesise_from(&doc, &mut meta);
    assert_eq!(meta["NewMarksman"].positions, vec![Role::Adc]);
}

#[test]
fn unknown_champion_gets_an_empty_meta_and_a_uniform_posterior() {
    let mut meta = HashMap::new();
    assert_eq!(ensure_known(&mut meta, &["Nobody"]), 1);
    let roles = team_roles(&["Nobody"], &meta);
    for p in roles.posterior[0].1 {
        assert!((p - 0.2).abs() < 1e-9);
    }
}

pub(crate) fn load_meta_with_synthesis() -> (HashMap<String, ChampionMeta>, Vec<String>) {
    let root = repo_root();
    let (_meta, mut champion_meta) = load_engine_data(
        &root.join("data/compiled/champion-meta.json"),
        &root.join("data/compiled/matchup-data.json"),
    )
    .expect("compiled engine data loads");
    let added = synthesise_missing_meta(&mut champion_meta);
    (champion_meta, added)
}

// --- the solve itself --------------------------------------------------------

struct TeamRoles {
    /// champion alias -> the role it takes in the max-weight assignment
    argmax: Vec<(String, Role)>,
    /// champion alias -> marginal posterior over the 5 roles
    posterior: Vec<(String, [f64; 5])>,
}

/// One `solve` call yields both quantities: the argmax assignment decides slot
/// placement, the weight-sum per (champion, role) is the marginal posterior.
fn team_roles(champions: &[&str], meta: &HashMap<String, ChampionMeta>) -> TeamRoles {
    let weighted = solve(champions, meta);
    assert!(
        !weighted.is_empty(),
        "solve returned nothing for {champions:?} — 1..=5 champions required"
    );

    let mut posterior: Vec<[f64; 5]> = vec![[0.0; 5]; champions.len()];
    // `solve` normalises weights to sum to 1, so these sums are probabilities.
    for w in &weighted {
        let slots = [
            &w.assignment.top,
            &w.assignment.jungle,
            &w.assignment.middle,
            &w.assignment.adc,
            &w.assignment.support,
        ];
        for (r, occupant) in slots.iter().enumerate() {
            if occupant.is_empty() {
                continue;
            }
            // A champion may legitimately appear twice in one team's list only
            // if the draft repeated it, which cannot happen; index by position.
            if let Some(i) = champions.iter().position(|c| c == occupant) {
                posterior[i][r] += w.weight;
            }
        }
    }

    // Ties resolve to the FIRST enumerated permutation: `>` never displaces an
    // equal-weight earlier assignment.
    let mut best = &weighted[0];
    for w in &weighted[1..] {
        if w.weight > best.weight {
            best = w;
        }
    }
    let best_slots = [
        &best.assignment.top,
        &best.assignment.jungle,
        &best.assignment.middle,
        &best.assignment.adc,
        &best.assignment.support,
    ];
    let mut argmax = Vec::new();
    for (r, occupant) in best_slots.iter().enumerate() {
        if !occupant.is_empty() {
            argmax.push(((*occupant).clone(), ROLES[r]));
        }
    }

    TeamRoles {
        argmax,
        posterior: champions
            .iter()
            .enumerate()
            .map(|(i, c)| ((*c).to_string(), posterior[i]))
            .collect(),
    }
}

pub(crate) const SLOT_COLUMNS: [&str; 10] = [
    "b_TOP", "b_JUNGLE", "b_MIDDLE", "b_BOTTOM", "b_UTILITY",
    "r_TOP", "r_JUNGLE", "r_MIDDLE", "r_BOTTOM", "r_UTILITY",
];

fn emit(
    out: &mut String,
    match_id: &str,
    split: &str,
    fold: &str,
    state_kind: &str,
    side: &str,
    roles: &TeamRoles,
) {
    let argmax: HashMap<&str, Role> =
        roles.argmax.iter().map(|(c, r)| (c.as_str(), *r)).collect();
    for (champ, probs) in &roles.posterior {
        let r = argmax.get(champ.as_str()).expect("argmax covers every champion");
        out.push_str(&format!(
            "{match_id},{split},{fold},{state_kind},{side},{champ},{},{}\n",
            ROLE_NAMES[ROLES.iter().position(|x| x == r).unwrap()],
            probs
                .iter()
                .map(|p| format!("{p:.6}"))
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
}

#[test]
#[ignore]
fn emit_solver_roles_for_every_benchmarked_state() {
    let root = repo_root();
    let (mut meta, synthesised) = load_meta_with_synthesis();
    let mut unknown_added = 0usize;
    println!(
        "champion-meta: {} champions; synthesised {} absent from it: {:?}",
        meta.len() - synthesised.len(),
        synthesised.len(),
        synthesised
    );

    let mut out = String::from(
        "match_id,split,fold,state_kind,side,champion,argmax_role,\
         p_top,p_jungle,p_middle,p_adc,p_support\n",
    );

    // 1. Full drafts: main split val-A/val-B/test plus rolling-origin fold 1's val.
    let solver_states = Csv::read(&root.join("data/training/solver_states.csv"));
    for row in &solver_states.rows {
        let match_id = solver_states.get(row, "match_id");
        let split = solver_states.get(row, "split");
        let fold = solver_states.get(row, "fold");
        for (side, cols) in [("blue", &SLOT_COLUMNS[..5]), ("red", &SLOT_COLUMNS[5..])] {
            let champs: Vec<&str> = cols.iter().map(|c| solver_states.get(row, c)).collect();
            unknown_added += ensure_known(&mut meta, &champs);
            let roles = team_roles(&champs, &meta);
            emit(&mut out, match_id, split, fold, "full", side, &roles);
        }
    }
    println!("full drafts: {} states", solver_states.rows.len());

    // 2. The 4-6-masked replica — the SAME states Tasks 4 and 6 score, so the
    //    solver roles here are for exactly the states being gated.
    let masked = Csv::read(&root.join("data/training/masked_states.csv"));
    let mut masked_teams = 0usize;
    for row in &masked.rows {
        let match_id = masked.get(row, "match_id");
        for (side, cols) in [("blue", &SLOT_COLUMNS[..5]), ("red", &SLOT_COLUMNS[5..])] {
            let champs: Vec<&str> = cols
                .iter()
                .map(|c| masked.get(row, c))
                .filter(|s| !s.is_empty())
                .collect();
            if champs.is_empty() {
                continue; // a team with nothing revealed has no solver opinion
            }
            unknown_added += ensure_known(&mut meta, &champs);
            let roles = team_roles(&champs, &meta);
            emit(&mut out, match_id, "test", "0", "masked", side, &roles);
            masked_teams += 1;
        }
    }
    println!("masked replica: {} states, {} teams solved", masked.rows.len(), masked_teams);
    if unknown_added > 0 {
        println!("WARNING: {unknown_added} champions had no meta at all — uniform posterior");
    }

    let path = root.join("data/training/solver_roles.csv");
    fs::write(&path, &out).expect("write solver_roles.csv");
    println!("wrote {} ({} lines)", path.display(), out.lines().count() - 1);
}

// --- guards that run on every `cargo test` -----------------------------------

#[test]
fn locke_gets_a_synthesised_meta_and_solve_does_not_panic() {
    // The regression this exists for: Locke (805) is the corpus's #1 ban and
    // appears in 10.9% of games, and champion-meta.json has never heard of it.
    // `solve` panics by contract on an unknown id, so without synthesis every
    // gate-4 arm would abort on a tenth of the test split.
    let (meta, synthesised) = load_meta_with_synthesis();
    assert!(
        synthesised.contains(&"Locke".to_string()),
        "Locke should have been synthesised; synthesised = {synthesised:?}"
    );
    let locke = &meta["Locke"];
    assert!(!locke.positions.is_empty(), "a synthesised meta needs a primary role");

    let team = ["Locke", "Ahri", "Sejuani", "Jinx", "Thresh"];
    let roles = team_roles(&team, &meta);
    assert_eq!(roles.argmax.len(), 5);
    assert_eq!(roles.posterior.len(), 5);
}

#[test]
fn posterior_rows_are_probability_distributions() {
    let (meta, _) = load_meta_with_synthesis();
    let team = ["Gnar", "Sejuani", "Ahri", "Jinx", "Thresh"];
    let roles = team_roles(&team, &meta);
    for (champ, probs) in &roles.posterior {
        let total: f64 = probs.iter().sum();
        assert!((total - 1.0).abs() < 1e-9, "{champ} posterior sums to {total}");
        assert!(probs.iter().all(|p| *p >= 0.0));
    }
    // Each ROLE is also filled exactly once across the team, so the columns
    // sum to 1 as well — the assignment is a bijection, not 5 independent draws.
    for r in 0..5 {
        let col: f64 = roles.posterior.iter().map(|(_, p)| p[r]).sum();
        assert!((col - 1.0).abs() < 1e-9, "role {} column sums to {col}", ROLE_NAMES[r]);
    }
}

#[test]
fn argmax_assignment_is_a_bijection_onto_distinct_roles() {
    let (meta, _) = load_meta_with_synthesis();
    let team = ["Gnar", "Sejuani", "Ahri", "Jinx", "Thresh"];
    let roles = team_roles(&team, &meta);
    let mut seen: Vec<Role> = roles.argmax.iter().map(|(_, r)| *r).collect();
    seen.sort_by_key(|r| ROLES.iter().position(|x| x == r).unwrap());
    seen.dedup();
    assert_eq!(seen.len(), 5, "two champions were assigned the same role");
}

#[test]
fn solve_handles_a_partial_team_the_way_a_masked_state_needs() {
    // Masked states reveal 2-3 champions per team. The posterior must still be
    // a distribution over all 5 roles for each revealed champion.
    let (meta, _) = load_meta_with_synthesis();
    for team in [&["Ahri"][..], &["Ahri", "Jinx"][..], &["Ahri", "Jinx", "Thresh"][..]] {
        let roles = team_roles(team, &meta);
        assert_eq!(roles.posterior.len(), team.len());
        assert_eq!(roles.argmax.len(), team.len());
        for (_, probs) in &roles.posterior {
            assert!((probs.iter().sum::<f64>() - 1.0).abs() < 1e-9);
        }
    }
}

#[test]
fn a_champion_with_one_listed_position_concentrates_its_posterior_there() {
    // Guards the direction of the whole thing: if the posterior were uniform,
    // gate 4's "posterior arm" would be testing nothing.
    let (meta, _) = load_meta_with_synthesis();
    let team = ["Gnar", "Sejuani", "Ahri", "Jinx", "Thresh"];
    let roles = team_roles(&team, &meta);
    for (champ, probs) in &roles.posterior {
        let primary = meta[champ].positions.first().copied();
        if let Some(p) = primary {
            let i = ROLES.iter().position(|r| *r == p).unwrap();
            assert!(
                probs[i] > 0.5,
                "{champ} primary {:?} carries only {:.3} of the posterior",
                p,
                probs[i]
            );
        }
    }
}
