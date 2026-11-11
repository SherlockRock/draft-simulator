// Runs the page's own scripts (the inlined logic and the template's glue) against a small fake DOM, so the
// things the template does with the logic are tested too: when rows appear, in what order, what a row says,
// and what happens when localStorage is unusable.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { assemblePageData, buildPageHtml, loadNames } from "./build-review-page.mjs";
import { blindRows, makeStorage, rowView, shuffleRows, cardRows, newState, setPick, restoreState } from "./review-logic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const RUN = JSON.parse(fs.readFileSync(path.join(HERE, "testdata/tiny-run.json"), "utf8"));
const NAMES = loadNames(REPO);
const TEMPLATE = fs.readFileSync(path.join(HERE, "page-template.html"), "utf8");
const LOGIC = fs.readFileSync(path.join(HERE, "review-logic.mjs"), "utf8");
const A = "2026-10-04-supp-pinch-slot-17-dme";
const B = "2026-09-29-supp-pinch-slot-19-kittens";

class FakeElement {
  constructor(tag, doc) {
    this.tag = tag;
    this.doc = doc;
    this.children = [];
    this.parent = null;
    this.className = "";
    this.dataset = {};
    this.attrs = {};
    this._text = "";
    this.hidden = false;
    this.id = "";
    this.handlers = {};
    this.value = "";
    this.checked = false;
    this.classList = {
      contains: (c) => this.className.split(/\s+/).includes(c),
      toggle: (c, on) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        if (on) set.add(c);
        else set.delete(c);
        this.className = [...set].join(" ");
      },
    };
  }
  get textContent() {
    return this.tag === "#text" || this.children.length === 0 ? this._text : this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  set innerHTML(v) {
    this.children = [];
    this._text = "";
  }
  appendChild(c) {
    if (this._text && this.children.length === 0 && this.tag !== "#text") {
      // text set before a child is added stays in front, as in a real DOM
      const t = this.doc.createTextNode(this._text);
      t.parent = this;
      this.children.push(t);
      this._text = "";
    }
    c.parent = this;
    this.children.push(c);
    return c;
  }
  replaceWith(n) {
    const i = this.parent.children.indexOf(this);
    n.parent = this.parent;
    this.parent.children[i] = n;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k];
  }
  addEventListener(type, fn) {
    (this.handlers[type] ||= []).push(fn);
  }
  focus() {
    this.doc.activeElement = this;
  }
  closest(sel) {
    const cls = sel.slice(1);
    for (let n = this; n; n = n.parent) if (n.classList.contains(cls)) return n;
    return null;
  }
}
class HTMLInputElement extends FakeElement {}
class HTMLTextAreaElement extends FakeElement {}

function walk(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const c of node.children) walk(c, pred, out);
  return out;
}

function makeDoc(dataJson) {
  const doc = { activeElement: null, handlers: {} };
  doc.createElement = (tag) => (tag === "input" ? new HTMLInputElement(tag, doc) : new FakeElement(tag, doc));
  doc.createTextNode = (t) => {
    const n = new FakeElement("#text", doc);
    n._text = t;
    return n;
  };
  const fixed = {};
  for (const id of ["runline", "count-rows", "count-cards", "unfinished", "storage-notice", "load-errors", "root", "copy", "download", "armwrap", "arm", "export-msg", "export-box"]) {
    fixed[id] = doc.createElement("div");
    fixed[id].id = id;
  }
  fixed["page-data"] = doc.createElement("script");
  fixed["page-data"].textContent = dataJson;
  doc.getElementById = (id) => fixed[id];
  doc.body = doc.createElement("body");
  doc.addEventListener = (type, fn) => (doc.handlers[type] ||= []).push(fn);
  doc.querySelector = (sel) => {
    const m = sel.match(/^\.o\[data-card="(.*)"\]\[data-idx="(\d+)"\]$/);
    assert.ok(m, "unsupported selector " + sel);
    return walk(fixed.root, (n) => n.classList.contains("o") && n.dataset.card === m[1] && n.dataset.idx === m[2])[0] || null;
  };
  doc.root = fixed.root;
  doc.fixed = fixed;
  return doc;
}

function loadPage({ run = RUN, localStorage } = {}) {
  const data = assemblePageData(structuredClone(run), { names: NAMES, icons: () => "AAAA" });
  const html = buildPageHtml(data, { template: TEMPLATE, logicSource: LOGIC });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2, "the inlined logic and the page script");
  const dataJson = html.match(/<script id="page-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  const doc = makeDoc(dataJson);
  const ctx = vm.createContext({
    document: doc,
    Element: FakeElement,
    HTMLInputElement,
    HTMLTextAreaElement,
    CSS: { escape: (s) => s },
    performance: { now: () => 0 },
    console,
    Date,
  });
  Object.defineProperty(ctx, "localStorage", { get: () => localStorage() });
  for (const s of scripts) vm.runInContext(s, ctx);
  return { doc, data, ctx };
}

function memoryStorage() {
  const m = new Map();
  return { m, api: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) } };
}
const cardEl = (doc, id) => walk(doc.root, (n) => n.id === "c-" + id)[0];
const rowsOf = (doc, id) => walk(cardEl(doc, id), (n) => n.classList.contains("o")).sort((a, b) => Number(a.dataset.idx) - Number(b.dataset.idx));
const button = (doc, id, text) => walk(cardEl(doc, id), (n) => n.tag === "button" && n.textContent === text)[0];
const TAG = { in: "in pool", off: "off pool" };

test("before the pick answered a card shows no option row and no stage 2; after it, the blind rows in the seeded shuffle", () => {
  const mem = memoryStorage();
  const { doc, data } = loadPage({ localStorage: () => mem.api });
  for (const draft of data.drafts) {
    for (const card of draft.cards) {
      if (Object.keys(card.seed.labels).length > 0) continue; // a re-read card shows the rows it holds labels for
      assert.equal(rowsOf(doc, card.id).length, 0, card.id);
      assert.equal(cardEl(doc, card.id).textContent.includes("Options"), false, "no stage 2 heading before the pick");
    }
  }
  button(doc, B, "No view").onclick();
  const card = data.drafts[0].cards.find((c) => c.id === B);
  const expected = shuffleRows(blindRows(card), B).map((o) => o.id);
  const rows = rowsOf(doc, B);
  assert.equal(rows.length, expected.length);
  const shown = rows.map((r) => r.dataset.idx);
  assert.deepEqual(shown, expected.map((_, i) => String(i)));
  const words = rows.map((r) => walk(r, (n) => n.classList.contains("words"))[0].textContent);
  const want = shuffleRows(blindRows(card), B).map((o) => {
    const v = rowView(o, NAMES);
    return v.text + (v.tag ? TAG[v.tag] : "");
  });
  assert.deepEqual(words, want, "rows are in shuffle order and say what rowView says");
  assert.notDeepEqual(words, [...blindRows(card)].map((o) => rowView(o, NAMES).text + TAG[rowView(o, NAMES).tag]), "not the catalog order");
});

test("a row's text holds the side, the names and the tag and no digit; the key digits are the only numbers beside it", () => {
  const mem = memoryStorage();
  const { doc } = loadPage({ localStorage: () => mem.api });
  walk(doc.root, (n) => n.tag === "input" && n.attrs["aria-label"]?.includes(A)).forEach((inp, i) => (inp.value = ["Ziggs", "Syndra"][i]));
  button(doc, A, "Lock my pick").onclick();
  const rows = rowsOf(doc, A);
  assert.equal(rows.length, 4);
  for (const r of rows) {
    const who = r.children[0].textContent;
    assert.equal(/\d/.test(who), false, `row text has a digit: ${who}`);
    const keys = walk(r, (n) => n.tag === "button").map((b) => b.textContent);
    assert.deepEqual(keys, ["1play", "2maybe", "3never"]);
  }
});

test("keys 1/2/3 label the focused row and move to the next; the change is stored", () => {
  const mem = memoryStorage();
  const { doc, data } = loadPage({ localStorage: () => mem.api });
  button(doc, B, "No view").onclick();
  const first = rowsOf(doc, B)[0];
  first.focus();
  let prevented = false;
  for (const h of doc.handlers.keydown) h({ key: "3", target: first, ctrlKey: false, metaKey: false, altKey: false, preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  assert.equal(doc.activeElement.dataset.idx, "1");
  assert.equal(rowsOf(doc, B)[0].classList.contains("labelled"), true);
  const stored = JSON.parse(mem.m.get("tier-b-review/" + data.run.id));
  assert.equal(stored.rev, 2);
  assert.equal(Object.values(stored.positions[B].labels)[0].current, "never");
});

test("an unusable localStorage (the global itself throws) does not stop the page; the header says so", () => {
  const { doc } = loadPage({
    localStorage: () => {
      throw new Error("blocked");
    },
  });
  assert.equal(doc.fixed["storage-notice"].hidden, false);
  button(doc, B, "No view").onclick();
  assert.equal(rowsOf(doc, B).length > 0, true, "the sitting goes on in memory");
  const mem = memoryStorage();
  const ok = loadPage({ localStorage: () => mem.api });
  assert.equal(ok.doc.fixed["storage-notice"].hidden, true);
  const full = loadPage({ localStorage: () => ({ ...mem.api, setItem: () => { throw new Error("quota"); } }) });
  assert.equal(full.doc.fixed["storage-notice"].hidden, false);
});

test("the run's load_errors are a header notice", () => {
  const mem = memoryStorage();
  const none = loadPage({ localStorage: () => mem.api });
  assert.equal(none.doc.fixed["load-errors"].hidden, true);
  const run = structuredClone(RUN);
  run.load_errors = ["fixtures/tier-b/x.json: verdicts[0].would_pick: unknown champion"];
  const { doc } = loadPage({ run, localStorage: () => mem.api });
  assert.equal(doc.fixed["load-errors"].hidden, false);
  assert.match(doc.fixed["load-errors"].textContent, /1 fixture failed to load.*verdicts\[0\]\.would_pick/);
});

// ---- the same guarantees on the logic functions, directly ----

test("cardRows is empty until stage 1 is answered and then is exactly the shuffled blind rows", () => {
  const data = assemblePageData(structuredClone(RUN), { names: NAMES, icons: () => "AAAA" });
  const draft = data.drafts[0];
  const card = draft.cards.find((c) => c.id === B);
  const state = newState(data);
  assert.deepEqual(cardRows(draft, card, state), []);
  setPick(state, draft, B, null, "2026-11-10T10:00:00Z");
  assert.deepEqual(cardRows(draft, card, state).map((o) => o.id), shuffleRows(blindRows(card), B).map((o) => o.id));
});

test("makeStorage guards every access and reports availability", () => {
  const calls = [];
  const bad = (name) => () => {
    calls.push(name);
    throw new Error(name);
  };
  const broken = makeStorage(() => ({ getItem: bad("get"), setItem: bad("set"), removeItem: bad("remove") }), "k");
  assert.equal(broken.available(), false);
  assert.equal(broken.read(), null);
  assert.doesNotThrow(() => broken.write("x"));
  const readOnly = makeStorage(() => ({ getItem: () => "v", setItem: bad("set"), removeItem: () => {} }), "k");
  assert.equal(readOnly.available(), false, "a failed probe write");
  const mem = memoryStorage();
  const good = makeStorage(() => mem.api, "k");
  good.write("hello");
  assert.equal(good.read(), "hello");
  assert.equal(good.available(), true);
  assert.equal(mem.m.has("k/probe"), false, "the probe cleans up");
  const later = makeStorage(() => ({ ...mem.api, setItem: (k) => { if (k === "k") throw new Error("quota"); mem.api.setItem(k, "1"); } }), "k");
  assert.equal(later.available(), true);
  later.write("y");
  assert.equal(later.available(), false, "a later failure flips it");
});

test("restoreState ignores stored records of the wrong shape and keeps the seed for them", () => {
  const data = assemblePageData(structuredClone(RUN), { names: NAMES, icons: () => "AAAA" });
  const draft = data.drafts[0];
  const rowId = blindRows(draft.cards.find((c) => c.id === B))[0].id;
  const E = "2026-10-07-synth-dme-adc-pinch-slot-19";
  const seedE = newState(data).positions[E];
  const junk = {
    v: 1,
    run: data.run.id,
    rev: "many",
    positions: {
      [B]: { labels: { [rowId]: { current: "play", mode: "weird", t: 5 } }, pick: { current: ["a", "b", "c"], mode: null, t: null }, span: { blind: { first: 1 } }, revealedAt: 7 },
      [E]: { labels: [], pick: "Ahri", span: [], revealedAt: {} },
      [A]: 12,
    },
  };
  const back = restoreState(data, JSON.stringify(junk));
  assert.deepEqual(back.positions[B], newState(data).positions[B]);
  assert.deepEqual(back.positions[E], seedE);
  assert.equal(back.rev, 0);
  for (const bad of ["[]", "null", "12", '{"v":1}', JSON.stringify({ v: 1, run: data.run.id, positions: [] })]) {
    assert.deepEqual(restoreState(data, bad), newState(data), bad);
  }
});

test("a scored pick alone reveals the draft", () => {
  const data = assemblePageData(structuredClone(RUN), { names: NAMES, icons: () => "AAAA" });
  const draft = data.drafts[0];
  const state = newState(data);
  state.positions[B].pick = { blind: "Ashe", current: "Jinx", mode: "scored", t: "2026-11-10T10:00:00Z" };
  assert.equal(cardRows(draft, draft.cards.find((c) => c.id === B), state).length > 0, true);
  assert.equal(draftState(draft, state), "revealed");
});

import { draftRevealState as draftState } from "./review-logic.mjs";

// ---- task 6: the reveal and the export in the page ----

const C = "2026-10-04-supp-pinch-slot-19-kittens";
const D = "2026-10-04-top-pinch-slot-19-kittens";
const SUPP_CARDS = [A, B, C];
const anyButton = (doc, text) => walk(doc.root, (n) => n.tag === "button" && n.textContent === text)[0];
function labelCardViaDom(doc, id, labelIndex = 0) {
  button(doc, id, "No view").onclick();
  const n = rowsOf(doc, id).length;
  for (let i = 0; i < n; i++) walk(rowsOf(doc, id)[i], (x) => x.tag === "button")[labelIndex].onclick();
}
function revealSupp(doc) {
  for (const id of SUPP_CARDS) labelCardViaDom(doc, id);
  const b = anyButton(doc, "Reveal the Support draft");
  assert.equal(b.disabled, false, "enabled once every blind row of the draft is labelled");
  b.onclick();
}
const textOf = (doc, id) => cardEl(doc, id).textContent;

test("the reveal button stays disabled until every card of the draft is labelled; the reveal is per draft", () => {
  const mem = memoryStorage();
  const { doc } = loadPage({ localStorage: () => mem.api });
  assert.equal(anyButton(doc, "Reveal the Support draft").disabled, true);
  labelCardViaDom(doc, A);
  labelCardViaDom(doc, B);
  assert.equal(anyButton(doc, "Reveal the Support draft").disabled, true, "one card still open");
  assert.equal(anyButton(doc, "Reveal the Top draft").disabled, true);
  assert.equal(doc.fixed.copy.disabled, false, "something to export after the first change");
});

test("after the reveal the cards show rank, value, gain, line and the near-tie mark, the draft only", () => {
  const mem = memoryStorage();
  const { doc, data } = loadPage({ localStorage: () => mem.api });
  revealSupp(doc);
  for (const id of SUPP_CARDS) {
    const t = textOf(doc, id);
    assert.match(t, /3\. Revealed/);
    assert.match(t, /#1/);
    assert.match(t, /value 0\.\d{4}/);
    assert.match(t, /gain [-\d.]+ logit \([-\d.]+ pp\)/);
    assert.match(t, /near tie with #1/);
    assert.match(t, /My pick: no view/);
    assert.match(t, /Pool menu at the reference arm/);
    assert.match(t, /Earlier verdicts and the review/);
    assert.equal(t.includes("2. Options (shuffled, no scores)"), false, "the shuffled blind list is replaced");
  }
  assert.equal(textOf(doc, D).includes("3. Revealed"), false, "the top draft is still blind");
  assert.equal(doc.fixed.armwrap.hidden, false);
  assert.match(doc.fixed["count-rows"].textContent, /later/);
  // rows are in rank order
  const ranks = rowsOf(doc, A).map((r) => {
    const badge = walk(r, (n) => n.classList.contains("bdg") && /^#\d+$/.test(n.textContent))[0];
    return badge ? Number(badge.textContent.slice(1)) : 99;
  });
  assert.ok(ranks.length > 2 && ranks[0] === 1);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  // a pair card's ranks-6-10 row is offered for a label
  assert.match(textOf(doc, A), /ranks 6-10: label now/);
  const n = data.drafts.find((d) => d.id === "supp").cards.length;
  assert.equal(n, 3);
});

test("a label changed after the reveal is stored as scored; keys 1/2/3 work on the revealed rows and walk the labelled rows only", () => {
  const mem = memoryStorage();
  const { doc, data } = loadPage({ localStorage: () => mem.api });
  revealSupp(doc);
  const first = rowsOf(doc, B)[0];
  assert.ok(first.dataset.idx === "0");
  first.focus();
  let prevented = false;
  for (const h of doc.handlers.keydown) h({ key: "3", target: first, ctrlKey: false, metaKey: false, altKey: false, preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  const stored = JSON.parse(mem.m.get("tier-b-review/" + data.run.id));
  const recs = Object.values(stored.positions[B].labels);
  assert.equal(recs.filter((r) => r.mode === "scored" && r.current === "never").length, 1);
  assert.equal(recs.filter((r) => r.mode === "blind").length, recs.length - 1, "the others stay blind labels");
});

test("the line verdict is on the card after the reveal, as ok/bad buttons, and lands in scored", () => {
  const mem = memoryStorage();
  const { doc, data } = loadPage({ localStorage: () => mem.api });
  revealSupp(doc);
  assert.match(textOf(doc, A), /Line of the reference #1/);
  assert.match(textOf(doc, A), /line: /);
  button(doc, A, "bad").onclick();
  const bad = button(doc, A, "bad");
  assert.equal(bad.attrs["aria-pressed"], "true");
  const stored = JSON.parse(mem.m.get("tier-b-review/" + data.run.id));
  assert.equal(stored.positions[A].line.ok, false);
  assert.equal(typeof stored.positions[A].line.line, "string");
});

test("Copy verdicts puts the whole export in front of the user when the clipboard is unavailable, and it parses", () => {
  const mem = memoryStorage();
  const { doc, data } = loadPage({ localStorage: () => mem.api });
  revealSupp(doc);
  for (const h of doc.fixed.copy.handlers.click) h();
  const box = doc.fixed["export-box"];
  assert.equal(box.hidden, false);
  const x = JSON.parse(box.value);
  assert.equal(x.schema, "tier-b-verdicts/1");
  assert.equal(x.run, data.run.id);
  assert.equal(x.positions[A].revealed, true);
  assert.equal(typeof x.positions[A].scored.started, "string");
  assert.equal(x.data.fm_version, data.run.data.fm_version);
  assert.match(doc.fixed["export-msg"].textContent, /blocked copying/);
});

test("the arm selector redraws the revealed cards at the chosen arm", () => {
  const mem = memoryStorage();
  const { doc, data } = loadPage({ localStorage: () => mem.api });
  revealSupp(doc);
  const sel = doc.fixed.arm;
  assert.equal(sel.children.length, data.run.arms.length);
  assert.match(textOf(doc, A), /\(reference\)/);
  sel.value = "0";
  for (const h of sel.handlers.change) h();
  assert.match(textOf(doc, A), /pool or roster/);
  assert.equal(textOf(doc, A).includes("(reference)"), false);
});

test("a card with no own pick in a revealed draft offers the pick form, recorded as scored", () => {
  const mem = memoryStorage();
  const { doc, data } = loadPage({ localStorage: () => mem.api });
  // answer every card's stage 1 and label, except that the pick of B is dropped from the stored state afterwards
  revealSupp(doc);
  const stored = JSON.parse(mem.m.get("tier-b-review/" + data.run.id));
  delete stored.positions[B].pick;
  mem.m.set("tier-b-review/" + data.run.id, JSON.stringify(stored));
  const again = loadPage({ localStorage: () => mem.api });
  assert.match(textOf(again.doc, B), /No own pick was recorded/);
  assert.match(textOf(again.doc, B), /recorded as scored/);
  walk(cardEl(again.doc, B), (n) => n.tag === "input").forEach((inp) => (inp.value = "Ashe"));
  button(again.doc, B, "Record my pick").onclick();
  const after = JSON.parse(mem.m.get("tier-b-review/" + data.run.id));
  assert.equal(after.positions[B].pick.mode, "scored");
  assert.equal(after.positions[B].pick.current, "Ashe");
});

test("a note box is on the card once its options are, and a note is stored", () => {
  const mem = memoryStorage();
  const { doc, data } = loadPage({ localStorage: () => mem.api });
  assert.equal(walk(cardEl(doc, B), (n) => n.tag === "textarea").length, 0, "nothing before the pick");
  button(doc, B, "No view").onclick();
  const ta = walk(cardEl(doc, B), (n) => n.tag === "textarea")[0];
  ta.value = "Galio support is not this team.";
  ta.handlers.change[0]();
  const stored = JSON.parse(mem.m.get("tier-b-review/" + data.run.id));
  assert.equal(stored.positions[B].note.text, "Galio support is not this team.");
});

// ---- task 6 fix round ----

const inTree = (n) => {
  for (let cur = n; cur.parent; cur = cur.parent) if (!cur.parent.children.includes(cur)) return false;
  return true;
};

test("typing a note and then pressing a label button does not swallow the click: the note's change leaves the card in place", () => {
  const mem = memoryStorage();
  const { doc, data } = loadPage({ localStorage: () => mem.api });
  button(doc, B, "No view").onclick();
  const ta = walk(cardEl(doc, B), (n) => n.tag === "textarea")[0];
  const labelBtn = walk(rowsOf(doc, B)[0], (x) => x.tag === "button")[1]; // the button about to be pressed
  ta.value = "typed, then blurred by the click";
  ta.handlers.change[0](); // the blur
  assert.equal(inTree(labelBtn), true, "the button is still the one on the page");
  assert.equal(inTree(ta), true);
  labelBtn.onclick();
  const stored = JSON.parse(mem.m.get("tier-b-review/" + data.run.id));
  assert.equal(stored.positions[B].note.text, "typed, then blurred by the click");
  assert.equal(Object.values(stored.positions[B].labels)[0].current, "maybe");
});

test("the earlier-verdicts block shows each earlier entry, not a count", () => {
  const mem = memoryStorage();
  const { doc } = loadPage({ localStorage: () => mem.api });
  const E = "2026-10-07-synth-dme-adc-pinch-slot-19";
  const t = cardEl(doc, E).textContent;
  assert.match(t, /Old report: off-pool verdict/);
  assert.match(t, /blind · finished 2026-11-09T14:12:41Z · \d+ labels?/);
  assert.match(t, /scored · finished /);
});

// ---- branch-review fixes ----

test("M1: with unfinished-only ticked, a draft's cards stay visible after its reveal while ranks 6-10 rows are unlabelled", () => {
  const mem = memoryStorage();
  const { doc, data } = loadPage({ localStorage: () => mem.api });
  for (const id of SUPP_CARDS) labelCardViaDom(doc, id);
  doc.fixed.unfinished.checked = true;
  anyButton(doc, "Reveal the Support draft").onclick();
  const supp = data.drafts.find((d) => d.id === "supp");
  for (const card of supp.cards) {
    const later = card.options.filter((o) => o.row === "later").length;
    assert.equal(cardEl(doc, card.id).hidden, later === 0, `${card.id} (${later} later rows)`);
  }
  assert.ok(supp.cards.some((c) => c.options.some((o) => o.row === "later")));
});

test("M6: after the reveal a changed pick is not called given blind", () => {
  const mem = memoryStorage();
  const { doc } = loadPage({ localStorage: () => mem.api });
  revealSupp(doc);
  assert.match(textOf(doc, B), /given blind; a change now is recorded as scored/);
  walk(cardEl(doc, B), (n) => n.tag === "input").forEach((inp) => (inp.value = "Ashe"));
  button(doc, B, "Record my pick").onclick();
  const t = textOf(doc, B);
  assert.match(t, /changed after the options were shown \(scored\); given blind: no view/);
  assert.equal(t.includes("given blind; a change now"), false);
});

test("M5: a re-read page shows the earlier line verdict as pressed and the earlier note in the box", () => {
  const base = assemblePageData(structuredClone(RUN), { names: NAMES, icons: () => "AAAA" });
  const E = "2026-10-07-synth-dme-adc-pinch-slot-19";
  const synthCard = base.drafts.flatMap((d) => d.cards).find((c) => c.id === E);
  const refIdx = base.run.arms.findIndex((a) => a.id === base.run.reference_arm);
  const entry = synthCard.readings.find((r) => r.arm === refIdx).ranked.find((e) => e[1] === 1);
  const optionId = synthCard.options[entry[0]].id;
  const lineStr = synthCard.blobs[entry[9]].line.map((t) => t.join("+")).join(" > ");
  const run = structuredClone(RUN);
  const p = run.positions.find((q) => q.id === E);
  const last = p.verdicts[p.verdicts.length - 1];
  last.line = { option: optionId, line: lineStr, ok: false };
  last.note = "an earlier note";
  const mem = memoryStorage();
  const { doc } = loadPage({ run, localStorage: () => mem.api });
  assert.equal(button(doc, E, "bad").attrs["aria-pressed"], "true");
  assert.equal(button(doc, E, "ok").attrs["aria-pressed"], "false");
  assert.equal(walk(cardEl(doc, E), (n) => n.tag === "textarea")[0].value, "an earlier note");
});
