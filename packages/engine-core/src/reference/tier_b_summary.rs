//! What the rule read, out of the run: the `metrics` block of the run JSON (additive to `tier-b-run/1`)
//! and the text summary (design docs/designs/tier-b-review-tool-design.md § 5). Both read the in-memory
//! `Read` the runner computed; nothing here scores anything.
//!
//! `metrics` is absent when no position carries a label or an own pick (nothing was read), so a run
//! without labels serialises exactly as a slice 1 `tier-b-run/1` did.
//!
//! Every `[n; 4]` array in `metrics` is indexed by `ks` (`[1, 3, 5, 10]`, `SCORE_KS`).

use super::tier_b_review::{OwnPick, PositionScore, ReviewRun, RunHeader, SCORE_KS};
use super::tier_b_rule::{
    ArmRole, ArmScore, Axis, Edge, EdgeSide, LineState, Metrics, PositionInput, RBucket, Read,
    Receipt, RuleOutcome, Split, FLOOR_RATIOS,
};
use serde_json::{json, Value};

/// How much labelling the corpus carries.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LabelCounts {
    pub positions: usize,
    /// Positions with at least one label or own pick.
    pub labelled_positions: usize,
    /// Options labelled in the current fold, and those of them given blind.
    pub options: usize,
    pub blind_options: usize,
    /// Own picks in the current fold and in the blind fold.
    pub own_picks: usize,
    pub blind_picks: usize,
}

pub fn label_counts(positions: &[&PositionInput]) -> LabelCounts {
    let mut c = LabelCounts {
        positions: positions.len(),
        ..LabelCounts::default()
    };
    for s in positions {
        c.options += s.current.labels.len();
        c.blind_options += s.reveal.blind_labels;
        c.own_picks += usize::from(s.current.own_pick.is_some());
        c.blind_picks += usize::from(s.reveal.blind_pick);
        c.labelled_positions +=
            usize::from(!s.current.labels.is_empty() || s.current.own_pick.is_some());
    }
    c
}

fn ids(arm: &ArmScore, keep: impl Fn(&PositionScore) -> bool) -> Vec<&str> {
    arm.rows
        .iter()
        .filter(|r| r.score.as_ref().is_some_and(&keep))
        .map(|r| r.id.as_str())
        .collect()
}

fn metrics_json(m: &Metrics) -> Value {
    // The median rank is infinite when every own pick is absent from the ranking; JSON has no infinity,
    // so it reads null there, with `pick_median_rank_absent` true (`pick_absent` of `with_pick`).
    let rank = m.pick_median_rank.filter(|r| r.is_finite());
    json!({
        "positions": m.positions,
        "speaking": m.speaking,
        "non_speaking": m.positions - m.speaking,
        "never": m.never,
        "near": m.near,
        "unjudged": m.unjudged,
        "play": m.play,
        "no_play": m.no_play,
        "neither_play": m.neither_play,
        "pick": m.pick,
        "pick_off": m.pick_off,
        "with_pick": m.with_pick,
        "pick_off_eligible": m.pick_off_eligible,
        "never_1_by_class": {
            "in_pool": m.never_1_in_pool,
            "off_pool_base": m.never_1_base,
            "off_pool_graded": m.never_1_graded,
        },
        "top_in_pool": m.top_in_pool,
        "pick_median_rank": rank,
        "pick_median_rank_absent": m.pick_median_rank.is_some_and(f64::is_infinite),
        "pick_absent": m.pick_absent,
        "pick_median_regret": m.pick_median_regret,
        "opp_charge_lead": m.opp_charge_lead,
        "bad_line": m.bad_line,
        "judged_line": m.judged_line,
        "unjudged_line": m.unjudged_line,
    })
}

fn role_name(role: ArmRole) -> &'static str {
    match role {
        ArmRole::PoolOrRoster => "pool_or_roster",
        ArmRole::Roster => "roster",
        ArmRole::Floor => "floor",
    }
}

fn arm_json(arm: &ArmScore, unknown_r_kept: usize) -> Value {
    let by_line = |state: LineState| -> Vec<&str> {
        arm.rows
            .iter()
            .filter(|r| r.line == state)
            .map(|r| r.id.as_str())
            .collect()
    };
    json!({
        "id": arm.spec.id,
        "role": role_name(arm.spec.role),
        "p": arm.spec.p,
        "q": arm.spec.q,
        "readable": arm.readable(),
        "unknown_r_kept": unknown_r_kept,
        "metrics": metrics_json(&arm.all),
        // The positions behind the counts, by id, for the page's hover. `_1` / `_3` read k = 1 / 3.
        "positions": {
            "never_1": ids(arm, |s| s.never[0]),
            "never_3": ids(arm, |s| s.never[1]),
            "near_1": ids(arm, |s| s.near[0]),
            "near_3": ids(arm, |s| s.near[1]),
            "unjudged_1": ids(arm, |s| s.unjudged[0]),
            "unjudged_3": ids(arm, |s| s.unjudged[1]),
            "pick_3": ids(arm, |s| s.pick[1]),
            "pick_3_out": ids(arm, |s| {
                s.own != OwnPick::NoPick && !s.pick[1]
            }),
            "not_speaking": arm.rows.iter().filter(|r| r.score.is_none()).map(|r| r.id.as_str()).collect::<Vec<_>>(),
            "bad_line_1": by_line(LineState::Bad),
            "unjudged_line_1": by_line(LineState::Unjudged),
        },
    })
}

fn edge_json(e: &Edge) -> Value {
    json!({
        "axis": match e.axis { Axis::P => "P", Axis::Q => "Q" },
        "side": match e.side { EdgeSide::Bottom => "bottom", EdgeSide::Top => "top" },
        "value": e.value,
        "text": e.text(),
    })
}

fn receipt_json(r: &Receipt) -> Value {
    let split = |s: &Split| json!({"positions": s.positions, "from": metrics_json(&s.from), "to": metrics_json(&s.to)});
    json!({
        "reference": r.reference,
        "pick": r.pick,
        "from": metrics_json(&r.from),
        "to": metrics_json(&r.to),
        "leaves_top_3": r.leaves_top_3,
        "enters_top_3": r.enters_top_3,
        "unstable": split(&r.unstable),
        "stable": split(&r.stable),
    })
}

fn outcome_json(o: &RuleOutcome) -> Value {
    json!({
        "roster_arms": o.roster_arms,
        "readable": o.readable,
        "ties": o.ties,
        "pick": o.pick,
        "edge": o.edge.iter().map(edge_json).collect::<Vec<_>>(),
        "receipt": o.receipt.as_ref().map(receipt_json),
    })
}

/// The `metrics` block, or `None` when the run holds no label and no own pick.
pub fn metrics_json_of(run: &ReviewRun) -> Option<Value> {
    let inputs: Vec<&PositionInput> = run.positions.iter().map(|p| &p.scoring).collect();
    metrics_of(&run.run, &run.read, &inputs)
}

/// The same from its parts, so a constructed `Read` can be shown without running a search.
pub fn metrics_of(h: &RunHeader, read: &Read, inputs: &[&PositionInput]) -> Option<Value> {
    let counts = label_counts(inputs);
    if counts.labelled_positions == 0 {
        return None;
    }
    let unknown_r = |id: &str| -> usize {
        inputs
            .iter()
            .flat_map(|p| p.arms.iter())
            .filter(|a| a.id == id)
            .map(|a| a.unknown_r_kept)
            .sum()
    };
    let r_by_label: Vec<Value> = RBucket::ALL
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let c = read.r_by_label.counts[i];
            json!({"bucket": b.name(), "play": c[0], "maybe": c[1], "never": c[2]})
        })
        .collect();
    let reveal = &read.reveal_changes;
    Some(json!({
        "ks": SCORE_KS,
        "margin": h.margin,
        "reference": h.reference_arm,
        "labels": {
            "positions": counts.positions,
            "labelled_positions": counts.labelled_positions,
            "options": counts.options,
            "blind_options": counts.blind_options,
            "scored_only_options": counts.options.saturating_sub(counts.blind_options),
            "own_picks": counts.own_picks,
            "blind_picks": counts.blind_picks,
            // Read from the current fold because no blind label existed / no blind pick was given.
            "fallback_labels": read.fallbacks.labels,
            "fallback_picks": read.fallbacks.picks,
        },
        "arms": read.arms.iter().map(|a| arm_json(a, unknown_r(&a.spec.id))).collect::<Vec<_>>(),
        "rule": outcome_json(&read.rule),
        "sensitivity": {
            "margins": read.sensitivity.margins.iter()
                .map(|(m, p)| json!({"margin": m, "pick": p})).collect::<Vec<_>>(),
            "leave_out": read.sensitivity.leave_out.iter()
                .map(|(d, p)| json!({"draft": d, "pick": p})).collect::<Vec<_>>(),
        },
        "second_line": {
            "differs": read.second_line.differs,
            "outcome": outcome_json(&read.second_line.outcome),
        },
        "never_everywhere": read.never_everywhere,
        "r_by_label": r_by_label,
        "reveal_changes": {
            "blind_labels": reveal.blind_labels,
            "blind_picks": reveal.blind_picks,
            "labels": reveal.labels.iter().map(|(p, c)| json!({
                "position": p, "option": c.option,
                "blind": c.blind.name(), "current": c.current.name(),
            })).collect::<Vec<_>>(),
            "picks": reveal.picks.iter().map(|(p, c)| json!({
                "position": p, "blind": c.blind, "current": c.current,
            })).collect::<Vec<_>>(),
            "drafts_revealed": reveal.drafts_revealed,
            "reveals_without_change": reveal.reveals_without_change,
        },
        "worklist": {
            "unlabelled_rows": read.worklist.unlabelled_rows.iter()
                .map(|(p, rows)| json!({"position": p, "rows": rows})).collect::<Vec<_>>(),
            "lines_at": read.worklist.lines_at,
            "unjudged_lines": read.worklist.unjudged_lines.iter()
                .map(|l| json!({"position": l.position, "option": l.option, "line": l.line}))
                .collect::<Vec<_>>(),
        },
    }))
}

// ---- the text ---------------------------------------------------------------------------------------

fn count_at(m: &Metrics, j: usize) -> String {
    let mut s = String::new();
    if m.unjudged[j] > 0 {
        s.push('≥');
    }
    s.push_str(&m.never[j].to_string());
    if m.near[j] > 0 {
        s.push_str(&format!("(+{})", m.near[j]));
    }
    s
}

fn cell(m: &Metrics) -> String {
    format!("{}/{}/{}", count_at(m, 0), count_at(m, 1), m.pick[1])
}

fn row_text(label: &str, m: &Metrics) -> String {
    let mut s = format!("{label}  {}", cell(m));
    if m.speaking < m.positions {
        s.push_str(&format!(
            "  ({} of {} positions do not speak)",
            m.positions - m.speaking,
            m.positions
        ));
    }
    s
}

fn list(items: &[String]) -> String {
    if items.is_empty() {
        "none".to_string()
    } else {
        items.join(", ")
    }
}

fn arrow(a: usize, b: usize) -> String {
    format!("{a} → {b}")
}

fn receipt_text(r: &Receipt) -> Vec<String> {
    let (f, t) = (&r.from, &r.to);
    let mut out = vec![format!(
        "never@1 {} (in-pool {}, off-pool base {}, off-pool graded {}), near@1 {}, never@3 {}, pick@3 {}, pick_off@3 {} of {} → {} of {}, top in-pool {}",
        arrow(f.never[0], t.never[0]),
        arrow(f.never_1_in_pool, t.never_1_in_pool),
        arrow(f.never_1_base, t.never_1_base),
        arrow(f.never_1_graded, t.never_1_graded),
        arrow(f.near[0], t.near[0]),
        arrow(f.never[1], t.never[1]),
        arrow(f.pick[1], t.pick[1]),
        f.pick_off[1],
        f.pick_off_eligible,
        t.pick_off[1],
        t.pick_off_eligible,
        arrow(f.top_in_pool, t.top_in_pool),
    )];
    out.push(format!(
        "own pick leaves the top 3 at: {}",
        list(&r.leaves_top_3)
    ));
    out.push(format!(
        "own pick enters the top 3 at: {}",
        list(&r.enters_top_3)
    ));
    for (name, s) in [
        ("depth check did not hold", &r.unstable),
        ("the others", &r.stable),
    ] {
        out.push(format!(
            "{name} ({} positions): never@1 {}, never@3 {}, pick@3 {}",
            s.positions.len(),
            arrow(s.from.never[0], s.to.never[0]),
            arrow(s.from.never[1], s.to.never[1]),
            arrow(s.from.pick[1], s.to.pick[1]),
        ));
    }
    out
}

fn pick_text(p: &Option<String>) -> &str {
    p.as_deref().unwrap_or("none readable")
}

fn bad_line_text(arm: &ArmScore) -> String {
    let m = &arm.all;
    format!(
        "{}: {} bad of {} judged, {} unjudged",
        arm.spec.id, m.bad_line, m.judged_line, m.unjudged_line
    )
}

/// The text summary of a run (design § 5), for `summary.txt`. A run with no labels says so and nothing
/// more: there is nothing to read.
pub fn render_summary(run: &ReviewRun) -> String {
    let inputs: Vec<&PositionInput> = run.positions.iter().map(|p| &p.scoring).collect();
    summary_of(&run.run, &run.read, &inputs)
}

/// The same from its parts, so a constructed `Read` can be shown without running a search.
pub fn summary_of(h: &RunHeader, read: &Read, inputs: &[&PositionInput]) -> String {
    let counts = label_counts(inputs);
    let mut out = Vec::<String>::new();
    out.push(format!(
        "Tier B review summary: run {} (engine {}{}, data fm {} / meta {} / positions patch {})",
        h.id,
        h.engine.commit.as_deref().unwrap_or("unknown"),
        if h.engine.dirty == Some(true) {
            ", dirty"
        } else {
            ""
        },
        h.data.fm_version,
        h.data.meta_version,
        h.data.positions_patch,
    ));
    out.push(format!(
        "{} positions, {} arms, margin ε {}, reference arm {}",
        counts.positions,
        h.arms.len(),
        h.margin,
        h.reference_arm
    ));
    if counts.labelled_positions == 0 {
        out.push(String::new());
        out.push("No labels yet: nothing to read.".to_string());
        return out.join("\n") + "\n";
    }
    out.push(format!(
        "labels: {} options over {} of {} positions ({} blind, {} scored only), {} own picks ({} blind)",
        counts.options,
        counts.labelled_positions,
        counts.positions,
        counts.blind_options,
        counts.options.saturating_sub(counts.blind_options),
        counts.own_picks,
        counts.blind_picks,
    ));
    out.push(format!(
        "read from the current fold, no blind answer: {} labels, {} own picks",
        read.fallbacks.labels, read.fallbacks.picks
    ));

    // The P x Q table.
    out.push(String::new());
    out.push("P x Q: never@1 / never@3 / pick@3 (rows P, columns Q)".to_string());
    out.push(
        "  (+n) near ties, not read by the rule; ≥n unjudged, n is the lower bound; * the rule's pick; ^ the reference arm"
            .to_string(),
    );
    let roster: Vec<&ArmScore> = read
        .arms
        .iter()
        .filter(|a| a.spec.role == ArmRole::Roster)
        .collect();
    let axis = |f: fn(&ArmScore) -> Option<f64>| {
        let mut v: Vec<f64> = roster.iter().filter_map(|a| f(a)).collect();
        v.sort_by(f64::total_cmp);
        v.dedup();
        v
    };
    let (ps, qs) = (axis(|a| a.spec.p), axis(|a| a.spec.q));
    let grid_cell = |p: f64, q: f64| -> String {
        roster
            .iter()
            .find(|a| a.spec.p == Some(p) && a.spec.q == Some(q))
            .map_or_else(
                || "-".to_string(),
                |a| {
                    let mut s = cell(&a.all);
                    if read.rule.pick.as_deref() == Some(a.spec.id.as_str()) {
                        s.push('*');
                    }
                    if a.spec.id == h.reference_arm {
                        s.push('^');
                    }
                    if a.all.speaking < a.all.positions {
                        s.push('!');
                    }
                    s
                },
            )
    };
    let width = ps
        .iter()
        .flat_map(|p| qs.iter().map(|q| (*p, *q)))
        .map(|(p, q)| grid_cell(p, q).chars().count())
        .chain(qs.iter().map(|q| format!("Q={q}").len()))
        .max()
        .unwrap_or(0);
    let mut header = format!("{:<8}", "");
    for q in &qs {
        header.push_str(&format!("  {:<width$}", format!("Q={q}")));
    }
    out.push(header.trim_end().to_string());
    for p in &ps {
        let mut line = format!("{:<8}", format!("P={p}"));
        for q in &qs {
            line.push_str(&format!("  {:<width$}", grid_cell(*p, *q)));
        }
        out.push(line.trim_end().to_string());
    }
    if roster.iter().any(|a| a.all.speaking < a.all.positions) {
        out.push("  ! some positions do not speak at this arm (cut or failed search)".to_string());
    }
    if let Some(por) = read
        .arms
        .iter()
        .find(|a| a.spec.role == ArmRole::PoolOrRoster)
    {
        out.push(row_text(
            &format!("{} (not selectable)", por.spec.id),
            &por.all,
        ));
    }

    // A `≥` cell is a lower bound: the count lies between `never` and `never + unjudged` (design
    // Definitions). The upper end is printed here, once per arm that has any unjudged option.
    let unjudged_arms: Vec<&ArmScore> = read
        .arms
        .iter()
        .filter(|a| {
            a.spec.role != ArmRole::Floor && (a.all.unjudged[0] > 0 || a.all.unjudged[1] > 0)
        })
        .collect();
    if !unjudged_arms.is_empty() {
        out.push(String::new());
        out.push("Upper bounds for the ≥ cells (never + unjudged, at k = 1 / k = 3):".to_string());
        for a in unjudged_arms {
            out.push(format!(
                "  {}  ≤{} / ≤{}",
                a.spec.id,
                a.all.never[0] + a.all.unjudged[0],
                a.all.never[1] + a.all.unjudged[1]
            ));
        }
    }

    // The floor rows.
    out.push(String::new());
    out.push(
        "Floor rows (the reference ranking with options holding an off-pool placement below r removed; root-only, no re-search; never selectable)"
            .to_string(),
    );
    for (row, ratio) in read
        .arms
        .iter()
        .filter(|a| a.spec.role == ArmRole::Floor)
        .zip(FLOOR_RATIOS)
    {
        let unknown: usize = inputs
            .iter()
            .flat_map(|p| p.arms.iter())
            .filter(|a| a.id == row.spec.id)
            .map(|a| a.unknown_r_kept)
            .sum();
        out.push(format!(
            "  {}  r < {ratio}  {}  non-speaking {} of {}, unknown r kept {}",
            row.spec.id,
            cell(&row.all),
            row.all.positions - row.all.speaking,
            row.all.positions,
            unknown
        ));
    }

    // The rule.
    out.push(String::new());
    let rule = &read.rule;
    if rule.readable == 0 {
        out.push(format!(
            "The rule: 0 of {} arms readable, so it names no pick. The worklist below says what is left to judge.",
            rule.roster_arms
        ));
    } else {
        out.push(format!(
            "The rule: {} of {} arms readable. Pick: {}{}",
            rule.readable,
            rule.roster_arms,
            pick_text(&rule.pick),
            if rule.ties.len() > 1 {
                format!(" (tied on the three keys: {})", rule.ties.join(", "))
            } else {
                String::new()
            }
        ));
        for e in &rule.edge {
            out.push(format!("  {}", e.text()));
        }
    }
    if let Some(r) = &rule.receipt {
        out.push(format!("Receipt, {} → {}:", r.reference, r.pick));
        out.extend(receipt_text(r).into_iter().map(|l| format!("  {l}")));
    }
    out.push("Sensitivity (the pick at other margins, and with each draft left out):".to_string());
    for (m, p) in &read.sensitivity.margins {
        out.push(format!("  ε {m}: {}", pick_text(p)));
    }
    for (d, p) in &read.sensitivity.leave_out {
        out.push(format!("  without {d}: {}", pick_text(p)));
    }
    let second = &read.second_line;
    out.push(format!(
        "Second line (the rule on the current fold): {} of {} arms readable, pick {}{}",
        second.outcome.readable,
        second.outcome.roster_arms,
        pick_text(&second.outcome.pick),
        if second.differs {
            "  ** DIFFERS from the blind read **"
        } else {
            " (same as the blind read)"
        }
    ));

    out.push(String::new());
    out.push("bad_line@1 (bad of judged; an unjudged line is not a good one):".to_string());
    let find = |id: &str| read.arms.iter().find(|a| a.spec.id == id);
    match (find(&h.reference_arm), rule.pick.as_deref().and_then(find)) {
        (Some(r), Some(p)) if r.spec.id == p.spec.id => {
            out.push(format!("  reference = pick, {}", bad_line_text(r)));
        }
        (r, p) => {
            for (name, arm) in [("reference", r), ("pick", p)] {
                if let Some(a) = arm {
                    out.push(format!("  {name}, {}", bad_line_text(a)));
                }
            }
        }
    }
    out.push(format!(
        "never_everywhere (a clear never at #1 at every readable arm): {}",
        if rule.readable == 0 {
            "none (no readable arm)".to_string()
        } else {
            list(&read.never_everywhere)
        }
    ));
    out.push("r_by_label (options with one off-pool placement; play / maybe / never):".to_string());
    for (i, b) in RBucket::ALL.iter().enumerate() {
        let c = read.r_by_label.counts[i];
        out.push(format!("  {:<10} {} / {} / {}", b.name(), c[0], c[1], c[2]));
    }
    let rc = &read.reveal_changes;
    out.push(format!(
        "reveal_changes: {} of {} blind labels and {} of {} blind picks changed after the reveal; drafts revealed: {}; reveals with no change: {}",
        rc.labels.len(),
        rc.blind_labels,
        rc.picks.len(),
        rc.blind_picks,
        list(&rc.drafts_revealed),
        list(&rc.reveals_without_change),
    ));

    // The worklist.
    out.push(String::new());
    out.push("Worklist".to_string());
    let rows: usize = read
        .worklist
        .unlabelled_rows
        .iter()
        .map(|(_, r)| r.len())
        .sum();
    out.push(format!(
        "  unlabelled rows: {rows} over {} positions",
        read.worklist.unlabelled_rows.len()
    ));
    for (p, rows) in &read.worklist.unlabelled_rows {
        out.push(format!("    {p}: {}", rows.len()));
        out.extend(rows.iter().map(|r| format!("      {r}")));
    }
    out.push(format!(
        "  #1 lines at {} with no line verdict: {}",
        read.worklist.lines_at.as_deref().unwrap_or("-"),
        read.worklist.unjudged_lines.len()
    ));
    for l in &read.worklist.unjudged_lines {
        out.push(format!("    {}: {} — {}", l.position, l.option, l.line));
    }
    out.join("\n") + "\n"
}
