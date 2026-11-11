import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { assemblePageData, buildPageHtml, iconReader, jsonForScript, loadNames, stripExport } from "./build-review-page.mjs";
import { blindRows, draftRevealState, newState } from "./review-logic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const RUN = JSON.parse(fs.readFileSync(path.join(HERE, "testdata/tiny-run.json"), "utf8"));
const NAMES = loadNames(REPO);
const A = "2026-10-04-supp-pinch-slot-17-dme";

function assemble(icons, run = RUN) {
  return assemblePageData(structuredClone(run), { names: NAMES, icons });
}
function cardOf(data, id) {
  return data.drafts.flatMap((d) => d.cards).find((c) => c.id === id);
}

test("name mapping: MonkeyKing reads Wukong, and the page carries the whole roster for the datalist", () => {
  assert.equal(NAMES.MonkeyKing, "Wukong");
  assert.equal(NAMES.KSante, "K'Sante");
  const data = assemble(() => "AAAA");
  assert.equal(data.names.MonkeyKing, "Wukong");
  assert.ok(Object.keys(data.names).length > 150);
});

test("icon fallback: a champion without an icon is listed and left out; unused icons are not carried", () => {
  const data = assemble((id) => (id === "Zyra" || id === "Syndra" ? undefined : "AAAA"));
  assert.ok(data.missingIcons.includes("Zyra"));
  assert.ok(data.missingIcons.includes("Syndra"));
  assert.equal(data.icons.Zyra, undefined);
  assert.equal(data.icons.Galio, "AAAA");
  const fromObject = assemble({ Galio: "BBBB", Garen: "on no card of this run" });
  assert.equal(fromObject.icons.Galio, "BBBB");
  assert.equal(fromObject.icons.Garen, undefined);
  assert.ok(fromObject.missingIcons.length > 10);
  // the real reader returns nothing for a file that is not there
  assert.equal(iconReader(REPO)("NoSuchChampion"), undefined);
  assert.ok(iconReader(REPO)("MonkeyKing").length > 100);
});

test("rows: blind = row and (reach <= 5 or margin); later = the other rows; a non-row is in neither", () => {
  const card = cardOf(assemble(() => "AAAA"), A);
  const kind = (prefix) => card.options.find((o) => o.id.startsWith(prefix)).row;
  assert.equal(kind("Syndra+Ziggs"), "blind");
  assert.equal(kind("Renata+Ziggs"), "blind");
  assert.equal(kind("Kaisa+KSante"), "blind", "reach 6 but in a margin set");
  assert.equal(kind("Amumu+Zilean"), "blind");
  assert.equal(kind("KSante+Leona"), "later", "reach 6, no margin");
  assert.equal(kind("Alistar+Zyra"), "later", "reach 10, no margin");
  assert.equal(kind("Bard+Lulu"), null);
  assert.equal(kind("Fill1+Gap1"), null);
  assert.equal(blindRows(card).length, 4);
});

test("a null reach with a margin flag is still blind; a null reach without one is later", () => {
  const run = structuredClone(RUN);
  const options = run.positions.find((p) => p.id === A).options;
  const id = Object.keys(options).find((k) => k.startsWith("KSante+Leona"));
  options[id].reach = null;
  options[id].margin = true;
  assert.equal(cardOf(assemble(() => "AAAA", run), A).options.find((o) => o.id === id).row, "blind");
  options[id].margin = false;
  assert.equal(cardOf(assemble(() => "AAAA", run), A).options.find((o) => o.id === id).row, "later");
});

test("option ids are taken verbatim from the run, in the run's order, never rebuilt", () => {
  const data = assemble(() => "AAAA");
  const card = cardOf(data, A);
  assert.deepEqual(card.options.map((o) => o.id), Object.keys(RUN.positions.find((p) => p.id === A).options));
  assert.ok(card.options.some((o) => o.id.startsWith("Kaisa+KSante|")), "byte order, not localeCompare");
});

test("pruning: line, ends and line_steps are kept for each arm's top K only, de-duplicated", () => {
  const data = assemble(() => "AAAA");
  const card = cardOf(data, A);
  const k = RUN.run.k;
  const arm1 = card.readings.find((r) => RUN.run.arms[r.arm].id === "roster:0.1:0.05");
  assert.equal(arm1.ranked.length, 13, "every catalog option the arm ranked stays");
  for (const e of arm1.ranked) {
    const [, rank, , , , , , , , blob] = e;
    if (rank <= k) assert.ok(blob >= 0, `rank ${rank} keeps its line`);
    else assert.equal(blob, -1, `rank ${rank} drops its line`);
  }
  const kept = arm1.ranked.filter((e) => e[9] >= 0).length;
  assert.equal(kept, 10);
  assert.ok(card.blobs.length < 3 * kept, "identical lines share one blob");
  const withBan = card.blobs.find((b) => b.line_steps.some((s) => s.kind === "ban"));
  assert.ok(withBan, "a ban step survives, so the reveal can read it as a ban");
  assert.deepEqual(withBan.line_steps.find((s) => s.kind === "ban").placements, []);
  assert.ok(Array.isArray(withBan.line) && Array.isArray(withBan.line_side) && withBan.ends.kind);
});

test("a ranked entry is [optionIndex, rank, value, gainLogit, gainPp, ...] indexed into the catalog; the arm is an index into run.arms", () => {
  const data = assemble(() => "AAAA");
  const card = cardOf(data, A);
  const raw = RUN.positions.find((p) => p.id === A);
  const arm = card.readings[1];
  assert.equal(data.run.arms[arm.arm].id, "roster:0.1:0.05");
  const [oi, rank, value, gl, gp, cls] = arm.ranked[2];
  assert.equal(card.options[oi].id, raw.readings[1].ranked[2].option);
  assert.equal(rank, 3);
  assert.equal(value, raw.readings[1].ranked[2].value);
  assert.ok(Math.abs(gl - raw.readings[1].ranked[2].gain_logit) < 1e-6);
  assert.ok(Math.abs(gp - raw.readings[1].ranked[2].gain_pp) < 1e-4);
  assert.equal(data.classes[cls], "off-pool graded");
  assert.equal(card.options[arm.best_in_pool.option].id, raw.readings[1].best_in_pool.option);
  assert.equal(card.readings[2].best_in_pool, null, "no in-pool action ranked: null, gains stay null-safe");
});

test("drafts group by the run's draft, in order of first appearance; cards sort by slot, then id", () => {
  const data = assemble(() => "AAAA");
  assert.deepEqual(data.drafts.map((d) => d.id), ["supp", "top", "synth-dme-adc"]);
  assert.deepEqual(data.drafts[0].title, "Support draft");
  assert.equal(data.drafts[2].title, "synth-dme-adc", "an unnamed draft is its own group, titled by its id");
  assert.deepEqual(data.drafts[0].cards.map((c) => c.id), [
    A, "2026-09-29-supp-pinch-slot-19-kittens", "2026-10-04-supp-pinch-slot-19-kittens",
  ]);
});

test("the pool is the mover's, as authored; the board, open roles and the fixtures' history ride along", () => {
  const card = cardOf(assemble(() => "AAAA"), A);
  assert.deepEqual(card.pool, RUN.positions.find((p) => p.id === A).pools.blue);
  assert.deepEqual(card.open_roles, [["support", "adc"]]);
  assert.equal(card.board.length, 6);
  assert.deepEqual(card.seed, { labels: {}, would_pick: {}, verdicts: [] });
  assert.equal(card.menu.support[1].best, null);
  assert.equal(card.reference_ranking.length, 13);
  assert.deepEqual(card.reference_ranking[0].slice(0, 2), [["Syndra", "Ziggs"], 1]);
});

test("the page: data round-trips through the script tag, </script> in a note cannot close it, the export line is stripped", () => {
  const run = structuredClone(RUN);
  run.positions[1].notes = "</script><script>alert(1)</script><!-- x";
  const data = assemble(() => "AAAA", run);
  const template = fs.readFileSync(path.join(HERE, "page-template.html"), "utf8");
  const logicSource = fs.readFileSync(path.join(HERE, "review-logic.mjs"), "utf8");
  const html = buildPageHtml(data, { template, logicSource });
  const m = html.match(/<script id="page-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m);
  assert.deepEqual(JSON.parse(m[1]), JSON.parse(JSON.stringify(data)));
  assert.equal(html.split("</script>").length - 1, 3, "data, logic and page scripts: three closing tags only");
  assert.equal(/^export\b/m.test(html), false);
  assert.equal(html.includes("@@DATA@@") || html.includes("@@LOGIC@@"), false);
  assert.equal(html.includes("fonts.googleapis"), false, "no Google Fonts link");
  assert.equal(/<(?:link|script)[^>]+(?:src|href)=/i.test(html), false, "nothing is loaded from outside the file");
  // the inlined logic runs on its own and defines what the page calls
  const logic = stripExport(logicSource);
  const ctx = vm.createContext({});
  vm.runInContext(logic + ";globalThis.api={shuffleRows,blindRows,draftRevealState,setLabel,setPick,restoreState,newState};", ctx);
  assert.deepEqual(Object.keys(ctx.api).sort(), ["blindRows", "draftRevealState", "newState", "restoreState", "setLabel", "setPick", "shuffleRows"]);
  assert.throws(() => stripExport("const a = 1;\nexport const b = 2;\n"), /one final export line/);
  assert.equal(jsonForScript({ a: "</script>" }).includes("<"), false);
});

test("the pinned run contract (the Task 3 snapshot) assembles: seeded labels, own pick and a scored entry keep the draft revealed", () => {
  const snap = fs.readFileSync(path.join(REPO, "packages/engine-core/tests/snapshots/tier_b_review__run_on_the_labelled_position.snap"), "utf8");
  const run = JSON.parse(snap.slice(snap.indexOf("\n---\n", 4) + 5));
  const data = assemble(() => "AAAA", run);
  assert.equal(data.drafts.length, 1);
  const card = data.drafts[0].cards[0];
  assert.equal(card.kind, "pair");
  assert.equal(card.options.length, Object.keys(run.positions[0].options).length);
  const state = newState(data);
  assert.equal(draftRevealState(data.drafts[0], state), "revealed", "the snapshot's verdicts hold a scored entry");
  assert.deepEqual(state.positions[card.id].pick, { blind: ["Galio", "MonkeyKing"], current: ["Galio", "MonkeyKing"], mode: null, t: null });
  const galio = "Galio+MonkeyKing|top=Rumble,jungle=MonkeyKing,mid=Galio";
  assert.deepEqual(state.positions[card.id].labels[galio], { blind: "play", current: "play", mode: null, t: null });
  assert.deepEqual(state.positions[card.id].labels["Ahri+LeeSin|top=Rumble,jungle=LeeSin,mid=Ahri"], { current: "play", mode: null, t: null });
  for (const o of card.options) assert.ok(o.row === null || o.row === "blind" || o.row === "later");
});
