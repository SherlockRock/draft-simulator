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
