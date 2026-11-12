#!/usr/bin/env node
// Builds the Tier B review page: one self-contained HTML file from one `tier-b-run/1` JSON.
//
//   node scripts/tier-b/build-review-page.mjs <run.json> <out.html>
//
// Names come from frontend/src/data/champions.json, icons from frontend/src/assets/<id>Square.webp (read only).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BLIND_REACH } from "./review-logic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const DRAFT_TITLES = { supp: "Support draft", top: "Top draft", ad: "ADC draft", mid: "Mid draft" };

function round(x, places) {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}

function plainCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Blind rows: a top-5 reach in some roster arm, or in a roster arm's margin set at 3. The rest of the rows
// (ranks 6-10 only) come after the reveal. `reach` is a number or null; `margin` is read, never re-derived.
function rowKind(option) {
  if (!option.row) return null;
  const blind = (option.reach !== null && option.reach <= BLIND_REACH) || option.margin === true;
  return blind ? "blind" : "later";
}

function titleOf(draft) {
  return DRAFT_TITLES[draft] || draft;
}

function addLineChampions(into, entry) {
  for (const step of entry.line || []) for (const c of step) into.add(c);
  for (const s of entry.line_side || []) into.add(s.champion);
  for (const s of entry.line_steps || []) for (const c of s.champions) into.add(c);
}

// One position as the page holds it. `blobs` holds the parts of a ranked entry that only an arm's top K needs
// (leaf flags and lines), de-duplicated across arms; a ranked entry is the array
//   [optionIndex, rank, value, gainLogit, gainPp, classIndex, dOff, dGrade, moverWinPct, blobIndex | -1]
// whose first five fields are the plan's. The scores are in the file (the reveal needs them) and are not on any
// stage 1 or stage 2 render path.
function assembleCard(p, run, classes, armIds, used) {
  const optionIds = Object.keys(p.options);
  const index = new Map(optionIds.map((id, i) => [id, i]));
  const at = (id) => {
    const i = index.get(id);
    if (i === undefined) throw new Error(`${p.id}: option ${id} is in a reading but not in the catalog`);
    return i;
  };
  const options = optionIds.map((id) => {
    const o = p.options[id];
    for (const c of o.action) used.add(c);
    for (const s of o.side) used.add(s.champion);
    return { id, action: o.action, side: o.side, row: rowKind(o) };
  });
  const blobs = [];
  const blobIndex = new Map();
  const blobOf = (entry) => {
    const blob = { ends: entry.ends, line: entry.line, line_side: entry.line_side, line_steps: entry.line_steps };
    const key = JSON.stringify(blob);
    let i = blobIndex.get(key);
    if (i === undefined) {
      i = blobs.length;
      blobs.push(blob);
      blobIndex.set(key, i);
      addLineChampions(used, entry);
    }
    return i;
  };
  const readings = p.readings.map((r) => ({
    arm: armIds.indexOf(r.arm),
    depth: r.depth,
    partial: r.partial,
    error: r.error,
    best_in_pool: r.best_in_pool
      ? { option: at(r.best_in_pool.option), rank: r.best_in_pool.rank, value: round(r.best_in_pool.value, 6) }
      : null,
    ranked: r.ranked.map((e) => [
      at(e.option),
      e.rank,
      round(e.value, 6),
      e.gain_logit === null ? null : round(e.gain_logit, 6),
      e.gain_pp === null ? null : round(e.gain_pp, 4),
      classes.indexOf(e.class),
      e.d_off,
      e.d_grade,
      round(e.mover_win_pct, 3),
      e.rank <= run.run.k ? blobOf(e) : -1,
    ]),
  }));
  for (const b of p.board) used.add(b.champion);
  const pool = p.pools[p.mover.toLowerCase()];
  for (const list of Array.isArray(pool) ? [pool] : Object.values(pool)) for (const c of list) used.add(c);
  for (const c of p.actual_next || []) used.add(c);
  const menu = {};
  for (const [role, items] of Object.entries(p.menu)) {
    menu[role] = items.map((m) => ({ champion: m.champion, status: m.status, best: m.best }));
    for (const m of items) used.add(m.champion);
  }
  return {
    id: p.id,
    draft: p.draft,
    category: p.category,
    notes: p.notes,
    mover: p.mover,
    slot: p.slot,
    kind: p.kind,
    open_roles: p.open_roles,
    board: p.board,
    pool,
    exclusions: p.exclusions,
    actual_next: p.actual_next,
    depth_check: p.depth_check,
    review: p.review,
    legacy: p.legacy,
    warnings: p.warnings,
    loader_notes: p.loader_notes,
    base: p.base,
    seed: { labels: p.labels, would_pick: p.would_pick, verdicts: p.verdicts },
    options,
    readings,
    blobs,
    reference_ranking: p.reference_ranking.map((e) => [e.action, e.rank, round(e.value, 6)]),
    menu,
  };
}

// run -> the page's data. `names` maps champion id to display name. `icons` is an object id -> base64 webp, or a
// function id -> base64 | undefined, asked only for champions the page shows; a missing one is listed in
// `missingIcons` and the page draws initials.
function assemblePageData(run, { names, icons }) {
  const armIds = run.run.arms.map((a) => a.id);
  const classes = [...new Set(run.positions.flatMap((p) => p.readings.flatMap((r) => r.ranked.map((e) => e.class))))].sort(plainCompare);
  const used = new Set();
  const cards = run.positions.map((p) => assembleCard(p, run, classes, armIds, used));
  const drafts = [];
  for (const card of cards) {
    let draft = drafts.find((d) => d.id === card.draft);
    if (!draft) {
      draft = { id: card.draft, title: titleOf(card.draft), cards: [] };
      drafts.push(draft);
    }
    draft.cards.push(card);
  }
  for (const d of drafts) d.cards.sort((a, b) => a.slot - b.slot || plainCompare(a.id, b.id));
  const getIcon = typeof icons === "function" ? icons : (id) => icons[id];
  const iconMap = {};
  const missingIcons = [];
  const missingNames = [];
  for (const c of [...used].sort(plainCompare)) {
    const icon = getIcon(c);
    if (icon) iconMap[c] = icon;
    else missingIcons.push(c);
    if (!Object.prototype.hasOwnProperty.call(names, c)) missingNames.push(c);
  }
  return {
    schema: run.schema,
    run: {
      id: run.run.id,
      engine: run.run.engine,
      data: run.run.data,
      k: run.run.k,
      margin: run.run.margin,
      reference_arm: run.run.reference_arm,
      arms: run.run.arms,
      search: run.run.search,
    },
    classes,
    names,
    icons: iconMap,
    missingIcons,
    missingNames,
    load_errors: run.load_errors || [],
    // The results tab reads this; absent from a run with no labels. Corpus-wide aggregates: the page names an
    // unrevealed draft's positions on none of it (`positionVisible`).
    metrics: run.metrics || null,
    drafts,
  };
}

function stripExport(source) {
  const stripped = source.replace(/^export \{[^}]*\};?\s*$/m, "");
  if (/^export\b/m.test(stripped) || /^import\b/m.test(stripped)) {
    throw new Error("review-logic.mjs must hold plain declarations and one final export line");
  }
  return stripped;
}

// `<` is escaped so no string in the data can close the script element or open a comment.
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function buildPageHtml(data, { template, logicSource }) {
  const logic = stripExport(logicSource);
  for (const token of ["@@LOGIC@@", "@@DATA@@"]) {
    if (logic.includes(token)) throw new Error(`review-logic.mjs contains the template token ${token}`);
  }
  return template.replace("/*@@LOGIC@@*/", () => logic).replace("@@DATA@@", () => jsonForScript(data));
}

function loadNames(repo) {
  const file = JSON.parse(fs.readFileSync(path.join(repo, "frontend/src/data/champions.json"), "utf8"));
  const names = {};
  for (const c of file.champions) names[c.id] = c.name;
  return names;
}

function iconReader(repo) {
  return (id) => {
    const file = path.join(repo, "frontend/src/assets", `${id}Square.webp`);
    return fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : undefined;
  };
}

function main(argv) {
  const [runPath, outPath] = argv;
  if (!runPath || !outPath) {
    console.error("usage: build-review-page.mjs <run.json> <out.html>");
    process.exit(2);
  }
  const run = JSON.parse(fs.readFileSync(runPath, "utf8"));
  if (run.schema !== "tier-b-run/1") {
    console.error(`unsupported run schema ${run.schema}; this builder reads tier-b-run/1`);
    process.exit(2);
  }
  const data = assemblePageData(run, { names: loadNames(REPO), icons: iconReader(REPO) });
  for (const c of data.missingIcons) console.warn(`warning: no icon for ${c}; the page draws initials`);
  for (const c of data.missingNames) console.warn(`warning: no display name for ${c}; the page shows the id`);
  const template = fs.readFileSync(path.join(HERE, "page-template.html"), "utf8");
  const logicSource = fs.readFileSync(path.join(HERE, "review-logic.mjs"), "utf8");
  const html = buildPageHtml(data, { template, logicSource });
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, html);
  const blind = data.drafts.flatMap((d) => d.cards).reduce((n, c) => n + c.options.filter((o) => o.row === "blind").length, 0);
  const later = data.drafts.flatMap((d) => d.cards).reduce((n, c) => n + c.options.filter((o) => o.row === "later").length, 0);
  const cardCount = data.drafts.reduce((n, d) => n + d.cards.length, 0);
  console.log(
    `wrote ${outPath}: ${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB, ${cardCount} cards, ${blind} blind + ${later} later rows, ${Object.keys(data.icons).length} icons`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}

export { assemblePageData, buildPageHtml, stripExport, jsonForScript, loadNames, iconReader };
