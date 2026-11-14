// Pure logic of the Tier B review page (design: docs/designs/tier-b-review-tool-design.md, section 3).
//
// This file is inlined into the generated page, so it holds plain declarations only, no import,
// and exactly one export statement on the last line, which the builder strips.
//
// Page state (`newState`, `restoreState`), one object per run:
//   { v: 1, run: <run id>, rev: <counter, rises with every change>,
//     positions: { <position id>: {
//       pick:   absent = not answered | { blind?, current, mode, t },     value: id | [id, id] | null ("no view")
//       labels: { <option id>: { blind?, current, mode, t, via? } },
//       span:   { blind?: { first, last }, scored?: { first, last } },    wall-clock bounds of the changes made here
//       revealedAt: null | <time>                                         set by `revealDraft` or the seed
//       note:   absent | { text, mode, t }                                the card's free-text note
//       line:   absent | { option, line, ok, t }                          the line verdict on the reference #1 (scored only)
//     } } }
// `mode` and `t` are those of the last change (`t` null for a value seeded from the run). `blind` is the
// value last written in blind mode and never moves afterwards, `current` is the last value in any mode:
// the two folds of the fixture (design section 1). A seeded value has no `t`, so no span.

const LABELS = ["play", "maybe", "never"];
// The blind pass holds the rows an arm puts in its top 5 and the rows in a margin set at 3 (design T3).
// The run says which options are rows (`row`) and what each reached; the split is applied once, at assembly.
const BLIND_REACH = 5;
const STATE_VERSION = 1;

// ---- the shuffle -------------------------------------------------------------------------------

// cyrb53: a 53-bit string hash. No random source anywhere: the order of a card never changes.
function hash53(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function rowId(row) {
  return typeof row === "string" ? row : row.id;
}

// Seeded by the position id: each row sorts by a hash of (position id, row id). The result does not depend
// on the order the rows arrive in (so not on the engine's rank), is the same on every load, and a row added
// by a later run does not move the others. Ties (none expected) break on the id, by plain code-unit order.
function shuffleRows(rows, positionId) {
  const keyed = rows.map((row) => ({ row, id: rowId(row), key: hash53(positionId + "\u0000" + rowId(row)) }));
  keyed.sort((a, b) => a.key - b.key || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return keyed.map((k) => k.row);
}

function blindRows(card) {
  return card.options.filter((o) => o.row === "blind");
}

function laterRows(card) {
  return card.options.filter((o) => o.row === "later");
}

// ---- state -------------------------------------------------------------------------------------

function blankPosition() {
  return { labels: {}, span: {}, revealedAt: null };
}

// The state a run starts from: whatever the fixtures already hold (the run's `labels`, `would_pick`, and a
// `scored` entry in `verdicts`, which keeps a draft revealed).
function newState(data) {
  const state = { v: STATE_VERSION, run: data.run.id, rev: 0, positions: {} };
  for (const draft of data.drafts) {
    for (const card of draft.cards) {
      const ps = blankPosition();
      for (const [optionId, l] of Object.entries(card.seed.labels)) {
        const rec = { current: l.current === undefined ? l.blind : l.current, mode: null, t: null };
        if (l.blind !== undefined) rec.blind = l.blind;
        ps.labels[optionId] = rec;
      }
      const wp = card.seed.would_pick;
      if (wp.blind !== undefined || wp.current !== undefined) {
        // The runner writes a single-root pick as a one-element array; the page holds it as the plain id.
        const pick = { current: plainPick(wp.current === undefined ? wp.blind : wp.current), mode: null, t: null };
        if (wp.blind !== undefined) pick.blind = plainPick(wp.blind);
        ps.pick = pick;
      }
      const scored = card.seed.verdicts.find((v) => v.mode === "scored");
      if (scored) ps.revealedAt = scored.started;
      state.positions[card.id] = ps;
    }
  }
  return state;
}

// Stored text back to a state for this run, or the seed. Anything that does not fit this run's catalog is dropped.
function restoreState(data, text) {
  const seed = newState(data);
  if (!text) return seed;
  let stored;
  try {
    stored = JSON.parse(text);
  } catch (e) {
    return seed;
  }
  if (!isPlain(stored) || stored.v !== STATE_VERSION || stored.run !== data.run.id || !isPlain(stored.positions)) {
    return seed;
  }
  seed.rev = Number.isInteger(stored.rev) && stored.rev >= 0 ? stored.rev : 0;
  for (const draft of data.drafts) {
    for (const card of draft.cards) {
      const sp = stored.positions[card.id];
      if (!isPlain(sp)) continue;
      // Start from the seed; a stored record that does not fit is dropped and the seed's stands.
      const ps = seed.positions[card.id];
      const known = new Set(card.options.map((o) => o.id));
      if (isPlain(sp.labels)) {
        for (const [optionId, rec] of Object.entries(sp.labels)) {
          if (known.has(optionId) && validRecord(rec, (v) => LABELS.includes(v))) ps.labels[optionId] = cleanRecord(rec);
        }
      }
      if (isPlain(sp.pick)) {
        // A state stored by an earlier page may hold a one-element array: read it as the id.
        const rec = { ...sp.pick };
        if (rec.current !== undefined) rec.current = plainPick(rec.current);
        if (rec.blind !== undefined) rec.blind = plainPick(rec.blind);
        if (validRecord(rec, validPickValue)) ps.pick = cleanRecord(rec);
      }
      if (isPlain(sp.span)) {
        const span = {};
        for (const mode of ["blind", "scored"]) {
          const s = sp.span[mode];
          if (isPlain(s) && isUtc(s.first) && isUtc(s.last)) span[mode] = { first: s.first, last: s.last };
        }
        ps.span = span;
      }
      if (isUtc(sp.revealedAt)) ps.revealedAt = sp.revealedAt;
      if (isPlain(sp.note) && typeof sp.note.text === "string" && (sp.note.mode === "blind" || sp.note.mode === "scored") && isUtc(sp.note.t)) {
        ps.note = { text: sp.note.text, mode: sp.note.mode, t: sp.note.t };
      }
      const ln = sp.line;
      if (isPlain(ln) && known.has(ln.option) && typeof ln.line === "string" && typeof ln.ok === "boolean" && isUtc(ln.t)) {
        ps.line = { option: ln.option, line: ln.line, ok: ln.ok, t: ln.t };
      }
    }
  }
  return seed;
}

// ISO-8601 UTC with a Z, with or without a fraction: what the Rust loader accepts.
function isUtc(text) {
  return typeof text === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(text);
}

// A one-element array is its id; anything else is as it was.
function plainPick(v) {
  return Array.isArray(v) && v.length === 1 && typeof v[0] === "string" ? v[0] : v;
}

function isPlain(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function validPickValue(v) {
  return v === null || typeof v === "string" || (Array.isArray(v) && v.length === 2 && v.every((c) => typeof c === "string"));
}

// A stored label or pick record: `current` (and `blind`, when there) valid, `mode` null / blind / scored,
// `t` a string or null.
function validRecord(rec, validValue) {
  if (!isPlain(rec) || rec.current === undefined || !validValue(rec.current)) return false;
  if (rec.blind !== undefined && !validValue(rec.blind)) return false;
  if (rec.mode !== null && rec.mode !== "blind" && rec.mode !== "scored") return false;
  return rec.t === null || typeof rec.t === "string";
}

function cleanRecord(rec) {
  const out = { current: rec.current, mode: rec.mode, t: rec.t };
  if (rec.blind !== undefined) out.blind = rec.blind;
  if (rec.via === "own-pick") out.via = rec.via;
  return out;
}

function positionState(state, cardId) {
  const ps = state.positions[cardId];
  if (!ps) throw new Error("unknown position " + cardId);
  return ps;
}

function currentLabel(state, cardId, optionId) {
  const rec = positionState(state, cardId).labels[optionId];
  return rec ? rec.current : undefined;
}

function isPositionRevealed(ps) {
  if (ps.revealedAt) return true;
  if (ps.pick && ps.pick.mode === "scored") return true;
  return Object.values(ps.labels).some((l) => l.mode === "scored");
}

function rowsLabelled(card, ps) {
  return blindRows(card).every((o) => ps.labels[o.id] !== undefined);
}

// blind: some blind row of the draft is unlabelled; ready: none is; revealed: a `scored` entry exists on any
// card of the draft (design section 3: the reveal is per draft, and a revealed draft stays revealed).
function draftRevealState(draft, state) {
  if (draft.cards.some((c) => isPositionRevealed(positionState(state, c.id)))) return "revealed";
  return draft.cards.every((c) => rowsLabelled(c, positionState(state, c.id))) ? "ready" : "blind";
}

// A holdout draft of a run that was not opened (design section 5): the page never shows it revealed, whatever the
// seeded or restored state says. Sealed overrides rendering and visibility, NOT `labelMode`: a holdout fixture
// that holds a `scored` entry keeps recording `scored` labels, because apply and the loader refuse a `blind`
// entry after a `scored` one. So nothing below changes `draftRevealState`; the places that SHOW a reveal ask
// `draftShown` instead. `draft.sealed` is set by the builder from the run (`holdout_open === true` opens it).
function draftSealed(draft) {
  return draft.sealed === true;
}

// Whether the page shows the draft revealed: revealed in the state and not sealed.
function draftShown(draft, state) {
  return !draftSealed(draft) && draftRevealState(draft, state) === "revealed";
}

// A label written now is `scored` once its draft is revealed, a new row included.
function labelMode(draft, state) {
  return draftRevealState(draft, state) === "revealed" ? "scored" : "blind";
}

// Wall-clock bounds of the changes made here, never a sum of durations. `last` never moves backwards.
function touch(state, ps, mode, now) {
  const span = ps.span[mode];
  ps.span[mode] = span ? { first: span.first, last: now > span.last ? now : span.last } : { first: now, last: now };
  state.rev += 1;
}

function writeLabel(ps, mode, optionId, value, now, via) {
  const old = ps.labels[optionId];
  if (old && old.current === value) return false;
  const rec = old ? { ...old } : {};
  rec.current = value;
  rec.mode = mode;
  rec.t = now;
  if (mode === "blind") rec.blind = value;
  if (via) rec.via = via;
  else delete rec.via;
  ps.labels[optionId] = rec;
  return true;
}

// One label change. Returns false (and records nothing) when the value is already the current one.
function setLabel(state, draft, cardId, optionId, value, now) {
  if (!LABELS.includes(value)) throw new Error("not a label: " + value);
  const card = draft.cards.find((c) => c.id === cardId);
  if (!card) throw new Error("card " + cardId + " is not in draft " + draft.id);
  if (!card.options.some((o) => o.id === optionId)) throw new Error("unknown option " + optionId + " on " + cardId);
  const mode = labelMode(draft, state);
  const ps = positionState(state, cardId);
  if (!writeLabel(ps, mode, optionId, value, now)) return false;
  touch(state, ps, mode, now);
  return true;
}

function asIds(value) {
  return Array.isArray(value) ? value : [value];
}

// Two picks are equal as sets (the order written is not the order stored), and "no view" only equals itself.
function samePick(a, b) {
  if (a === null || b === null) return a === b;
  const x = asIds(a);
  const y = asIds(b);
  return x.length === y.length && x.every((c) => y.includes(c));
}

function sameAction(action, pick) {
  return pick !== null && samePick(action, pick);
}

function pickAnswered(ps) {
  return ps.pick !== undefined;
}

// The own pick. In blind mode it is given once, before any engine row has been shown, and cannot be taken back:
// a pick revised after seeing the rows would not be a blind pick. After the reveal it may change and is `scored`.
// When the pick is a blind row the row is pre-set to `play` unless it already holds a label (design section 3);
// the label is marked `via: "own-pick"`.
function setPick(state, draft, cardId, value, now) {
  const card = draft.cards.find((c) => c.id === cardId);
  if (!card) throw new Error("card " + cardId + " is not in draft " + draft.id);
  const mode = labelMode(draft, state);
  const ps = positionState(state, cardId);
  if (ps.pick && samePick(ps.pick.current, value)) return false;
  if (mode === "blind" && ps.pick && ps.pick.blind !== undefined) {
    throw new Error("the own pick on " + cardId + " was given blind and is locked until the reveal");
  }
  const rec = ps.pick ? { ...ps.pick } : {};
  rec.current = value;
  rec.mode = mode;
  rec.t = now;
  if (mode === "blind") rec.blind = value;
  ps.pick = rec;
  if (mode === "blind" && value !== null) {
    const row = blindRows(card).find((o) => sameAction(o.action, value));
    if (row && ps.labels[row.id] === undefined) writeLabel(ps, mode, row.id, "play", now, "own-pick");
  }
  touch(state, ps, mode, now);
  return true;
}

// Stage 2 stays closed until stage 1 is answered ("no view" is an answer), so no engine row is on screen when
// the pick is given. A card that already holds labels (a re-read) or a revealed draft shows its rows.
function stageTwoOpen(draft, card, state) {
  const ps = positionState(state, card.id);
  return pickAnswered(ps) || Object.keys(ps.labels).length > 0 || draftShown(draft, state);
}

// The rows a card shows, as the page draws them: none until stage 1 is answered, then the card's blind rows in
// their seeded shuffle. The only way rows reach the screen.
function cardRows(draft, card, state) {
  return stageTwoOpen(draft, card, state) ? shuffleRows(blindRows(card), card.id) : [];
}

// What one row shows, built from the side, the names and the pool tag only: no rank, score, reach or grade.
function rowView(option, names) {
  const parts = sideParts(option);
  return {
    id: option.id,
    icons: parts.length ? parts.filter((p) => p.acting).map((p) => p.champion) : option.action,
    text: sideText(option, names),
    tag: poolTag(option),
  };
}

// localStorage behind a wrapper: every access (the global itself included, so `getBackend` is a function) is in
// try/catch, and `available()` turns false at the first failure, for the header notice.
function makeStorage(getBackend, key) {
  let ok = true;
  const attempt = (f, fallback) => {
    try {
      return f(getBackend());
    } catch (e) {
      ok = false;
      return fallback;
    }
  };
  attempt((b) => {
    b.setItem(key + "/probe", "1");
    b.removeItem(key + "/probe");
  });
  return {
    read: () => attempt((b) => b.getItem(key), null),
    write: (text) => {
      attempt((b) => b.setItem(key, text));
    },
    available: () => ok,
  };
}

function cardDone(card, state) {
  const ps = positionState(state, card.id);
  return pickAnswered(ps) && rowsLabelled(card, ps);
}

// For the "unfinished cards only" filter: a card is settled when it is done and, once its draft is revealed,
// every ranks 6-10 row it holds has a label too. Revealing therefore never hides a card that still has rows to label.
function cardSettled(draft, card, state) {
  if (!cardDone(card, state)) return false;
  if (!draftShown(draft, state)) return true;
  const ps = positionState(state, card.id);
  return laterRows(card).every((o) => ps.labels[o.id] !== undefined);
}

function progress(data, state) {
  let blindDone = 0;
  let blindTotal = 0;
  let cardsDone = 0;
  let cardsTotal = 0;
  for (const draft of data.drafts) {
    for (const card of draft.cards) {
      const ps = positionState(state, card.id);
      const rows = blindRows(card);
      blindTotal += rows.length;
      blindDone += rows.filter((o) => ps.labels[o.id] !== undefined).length;
      cardsTotal += 1;
      if (cardDone(card, state)) cardsDone += 1;
    }
  }
  return { blindDone, blindTotal, cardsDone, cardsTotal };
}

// ---- names and picks ---------------------------------------------------------------------------

function dn(names, id) {
  return names[id] || id;
}

function nameKey(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Display names and ids both resolve, ignoring case and punctuation ("kai'sa", "Lee Sin", "MonkeyKing", "wukong").
function buildNameIndex(names) {
  const index = {};
  for (const id of Object.keys(names)) index[nameKey(id)] = id;
  for (const [id, name] of Object.entries(names)) index[nameKey(name)] = id;
  return index;
}

function parseNameInput(text, nameIndex) {
  const key = nameKey(text);
  return key && Object.prototype.hasOwnProperty.call(nameIndex, key) ? nameIndex[key] : null;
}

// Why these champions cannot be the own pick at this card, or null.
function pickProblem(card, ids, names) {
  const want = card.kind === "pair" ? 2 : 1;
  if (ids.length !== want || ids.some((c) => !c)) {
    return want === 2 ? "Name two champions." : "Name one champion.";
  }
  if (want === 2 && ids[0] === ids[1]) return "A pair needs two different champions.";
  for (const c of ids) {
    if (!Object.prototype.hasOwnProperty.call(names, c)) return c + " is not a champion.";
    const onBoard = card.board.find((b) => b.champion === c);
    if (onBoard) return dn(names, c) + " is already " + (onBoard.kind === "ban" ? "banned" : "picked") + " on this board.";
  }
  return null;
}

function pickText(value, names) {
  if (value === null) return "no view";
  return asIds(value).map((c) => dn(names, c)).join(" + ");
}

// ---- a row's side, in words --------------------------------------------------------------------

// The action's champions first, in the action's own order, then the mover's other picks. A locked pick that
// the arrangement places outside its pool listing is stated as moved, in the same neutral words as any other.
function orderedSide(option) {
  const acting = (c) => option.action.includes(c.champion);
  const own = option.side.filter(acting).sort((a, b) => option.action.indexOf(a.champion) - option.action.indexOf(b.champion));
  const rest = option.side.filter((c) => !acting(c));
  return [...own, ...rest];
}

function sideParts(option) {
  return orderedSide(option).map((c) => ({
    champion: c.champion,
    role: c.role,
    moved: c.locked && !c.in_pool,
    acting: option.action.includes(c.champion),
  }));
}

function sideText(option, names) {
  const parts = sideParts(option);
  if (parts.length === 0) return option.action.map((c) => dn(names, c)).join(" + ");
  return parts.map((p) => dn(names, p.champion) + " " + (p.moved ? "moved to " : "") + p.role).join(" · ");
}

// "in" when every pick of the side is in the mover's pool for the role it plays, "off" otherwise, null when the
// run holds no side for the option (a list-form side). A fact about the reader's own pool; no grade, no r.
function poolTag(option) {
  if (option.side.length === 0) return null;
  return option.side.every((c) => c.in_pool) ? "in" : "off";
}

// ---- the reveal (design section 3, stage 3) ----------------------------------------------------

// One call: the reveal dates itself. Every card of the draft gets `revealedAt` and opens `span.scored` at `now`,
// and `rev` rises once, so a reveal that changes nothing still exports a dated `scored` object on every card.
// A draft that is not ready (a blind row unlabelled) throws; one that is already revealed is a no-op.
function revealDraft(state, draft, now) {
  if (draftSealed(draft)) throw new Error("the " + draft.id + " draft is sealed: it is opened by --open-holdout, not on the page");
  const rs = draftRevealState(draft, state);
  if (rs === "revealed") return false;
  if (rs !== "ready") throw new Error("the " + draft.id + " draft still has blind rows to label");
  for (const card of draft.cards) {
    const ps = positionState(state, card.id);
    ps.revealedAt = now;
    const span = ps.span.scored;
    ps.span.scored = span ? { first: span.first, last: now > span.last ? now : span.last } : { first: now, last: now };
  }
  state.rev += 1;
  return true;
}

// What the fixture's entries already say, as the page's current state on a re-read: the last note written, and
// the last line verdict for an (option, line). Not exported again unless changed here.
function seededNote(card) {
  let note = "";
  for (const e of card.seed.verdicts) if (typeof e.note === "string") note = e.note;
  return note;
}

function seededLineVerdict(card, optionId, line) {
  let ok;
  for (const e of card.seed.verdicts) if (e.line && e.line.option === optionId && e.line.line === line) ok = e.line.ok;
  return ok;
}

function currentNote(card, ps) {
  return ps.note ? ps.note.text : seededNote(card);
}

// The line verdict now standing for the reference #1's line: this page's, else the fixture's, else undefined.
function currentLineVerdict(card, ps, top) {
  if (ps.line && ps.line.option === top.option.id && ps.line.line === top.line) return ps.line.ok;
  return seededLineVerdict(card, top.option.id, top.line);
}

// The card's note: free text, recorded in the mode it was written in (it dates that mode's span).
function setNote(state, draft, cardId, text, now) {
  const card = draft.cards.find((c) => c.id === cardId);
  if (!card) throw new Error("card " + cardId + " is not in draft " + draft.id);
  const ps = positionState(state, cardId);
  const next = text.trim();
  if (currentNote(card, ps) === next) return false;
  const mode = labelMode(draft, state);
  ps.note = { text: next, mode, t: now };
  touch(state, ps, mode, now);
  return true;
}

// The line, as the run lists it: each turn's champion ids joined by "+", turns joined by " > ". Never re-sorted.
function lineText(blob) {
  return blob.line.map((turn) => turn.join("+")).join(" > ");
}

function stepText(step, names) {
  const who = step.champions.map((c) => dn(names, c)).join(" + ");
  if (step.kind === "ban") return step.side + " bans " + who;
  const roles = step.placements.map((p) => p.role).join(", ");
  return step.side + " picks " + who + (roles ? " (" + roles + ")" : "");
}

function referenceArmIndex(data) {
  return data.run.arms.findIndex((a) => a.id === data.run.reference_arm);
}

// The reference arm's #1 for a card: its option, its line text (null when the line is empty, as at slot 19),
// its steps. The first rank-1 entry when several tie. null when the arm has no usable reading.
function referenceTop(data, card) {
  const reading = card.readings.find((r) => r.arm === referenceArmIndex(data));
  if (!reading || reading.partial || reading.error) return null;
  const entry = reading.ranked.find((e) => e[1] === 1);
  if (!entry) return null;
  const blob = entry[9] >= 0 ? card.blobs[entry[9]] : null;
  const line = blob && blob.line.length > 0 ? lineText(blob) : null;
  return { option: card.options[entry[0]], line, steps: blob ? blob.line_steps : [] };
}

// The line verdict: after the reveal only, on the reference #1's line, never where there is no line.
function setLineVerdict(state, data, draft, cardId, ok, now) {
  const card = draft.cards.find((c) => c.id === cardId);
  if (!card) throw new Error("card " + cardId + " is not in draft " + draft.id);
  if (typeof ok !== "boolean") throw new Error("a line verdict is ok or bad");
  if (!draftShown(draft, state)) throw new Error("the line is shown, and judged, only after the reveal");
  const top = referenceTop(data, card);
  if (!top || top.line === null) throw new Error("there is no line to judge on " + cardId);
  const ps = positionState(state, cardId);
  if (currentLineVerdict(card, ps, top) === ok) return false;
  ps.line = { option: top.option.id, line: top.line, ok, t: now };
  touch(state, ps, "scored", now);
  return true;
}

function armLabel(arm, referenceId) {
  const base = arm.rule === "roster" ? "P " + arm.p + "  Q " + arm.q + (arm.w === undefined ? "" : "  w " + arm.w) : "pool or roster";
  return base + (arm.id === referenceId ? "  (reference)" : "");
}

function fixed(x, places) {
  return x === null || x === undefined ? "n/a" : x.toFixed(places);
}

// Leaf flags in words: how the line ended and what each side's leaf was charged.
function endsText(ends) {
  const side = (name, feasible, off, grade) => name + " " + (feasible ? "" : "infeasible, ") + off + " off pool, grade " + grade;
  return (ends.kind === "Complete" ? "complete draft" : "cut at the horizon") + " · " +
    side("Blue", ends.blue_feasible, ends.blue_off_pool, ends.blue_grade) + " · " +
    side("Red", ends.red_feasible, ends.red_off_pool, ends.red_grade);
}

// The whole side with what the engine charged for it: grade and r of every pick placed off its pool.
function revealSideText(option, names) {
  if (option.side.length === 0) return option.action.map((c) => dn(names, c)).join(" + ");
  return orderedSide(option)
    .map((c) => {
      const moved = c.locked && !c.in_pool ? "moved to " : "";
      const cost = c.in_pool ? "" : " [off pool, grade " + c.grade + ", r " + fixed(c.r, 2) + "]";
      return dn(names, c.champion) + " " + moved + c.role + cost;
    })
    .join(" · ");
}

// The card's rows at one arm after the reveal: every row of the catalog (blind and later), the best in-pool
// option always, and the arm's top K; ranked first, in rank order, then the rest. Only a row takes a label.
function revealRows(data, card, armIdx) {
  const reading = card.readings.find((r) => r.arm === armIdx);
  if (!reading) return { rows: [], note: "No reading at this arm.", topValue: null };
  if (reading.error) return { rows: [], note: "The search failed at this arm: " + reading.error, topValue: null };
  if (reading.partial) return { rows: [], note: "The search was cut at this arm; the position is left out here.", topValue: null };
  const byOption = new Map(reading.ranked.map((e) => [e[0], e]));
  const top = reading.ranked.find((e) => e[1] === 1);
  const topValue = top ? top[2] : null;
  const bestIn = reading.best_in_pool ? reading.best_in_pool.option : null;
  const picked = [];
  card.options.forEach((o, i) => {
    const e = byOption.get(i);
    if (o.row !== null || (e && e[1] <= data.run.k) || i === bestIn) picked.push({ o, i, e });
  });
  picked.sort((a, b) => {
    if (a.e && b.e) return a.e[1] - b.e[1] || (a.o.id < b.o.id ? -1 : a.o.id > b.o.id ? 1 : 0);
    if (a.e) return -1;
    if (b.e) return 1;
    return a.o.id < b.o.id ? -1 : a.o.id > b.o.id ? 1 : 0;
  });
  // A near tie is read against #1: every row within the margin of it, #1 included only when another row is.
  const within = (e) => Boolean(e) && topValue !== null && Math.abs(topValue - e[2]) <= data.run.margin + 1e-9;
  const alone = picked.filter(({ e }) => within(e)).length < 2;
  const rows = picked.map(({ o, i, e }) => {
    const blob = e && e[9] >= 0 ? card.blobs[e[9]] : null;
    return {
      id: o.id,
      option: o,
      controls: o.row !== null,
      rowKind: o.row,
      rank: e ? e[1] : null,
      value: e ? e[2] : null,
      gainLogit: e ? e[3] : null,
      gainPp: e ? e[4] : null,
      cls: e ? data.classes[e[5]] : null,
      dOff: e ? e[6] : null,
      dGrade: e ? e[7] : null,
      nearTie: !alone && within(e),
      bestInPool: i === bestIn,
      ends: blob && blob.ends ? endsText(blob.ends) : null,
      line: blob && blob.line.length > 0 ? lineText(blob) : null,
      steps: blob ? blob.line_steps.map((s) => stepText(s, data.names)) : [],
      sideText: revealSideText(o, data.names),
    };
  });
  return { rows, note: null, topValue };
}

// The own pick's place in the reference arm's whole ranking (design section 3): a rank, or "not ranked".
function ownPickPlace(card, value) {
  if (value === null || value === undefined) return null;
  const hit = card.reference_ranking.find((e) => samePick(e[0], value));
  return hit ? { rank: hit[1], value: hit[2] } : { rank: null, value: null };
}

function menuView(card, names) {
  return Object.entries(card.menu).map(([role, items]) => ({
    role,
    items: items.map((m) => ({
      champion: dn(names, m.champion),
      status: m.status,
      rank: m.best ? m.best.rank : null,
      gainLogit: m.best ? m.best.gain_logit : null,
      gainPp: m.best ? m.best.gain_pp : null,
    })),
  }));
}

// What the fixture already says about the position: the old report's verdicts, the review text, and each earlier
// graded entry in one line (mode, when it finished, how many labels, the own pick, the note).
function earlierView(card, names) {
  const lg = card.legacy || {};
  const legacy =
    "Old report: off-pool verdict " + (lg.off_pool ? "leave the pool" : "stay in the pool") +
    "; role verdict " + (lg.role_verdict ? JSON.stringify(lg.role_verdict) : "none") + ".";
  const review = card.review ? "Review: " + card.review : "No review text.";
  const entries = card.seed.verdicts.map((e) => {
    const parts = [e.mode, "finished " + e.finished, Object.keys(e.labels || {}).length + " label" + (Object.keys(e.labels || {}).length === 1 ? "" : "s")];
    if (Object.prototype.hasOwnProperty.call(e, "would_pick")) parts.push("own pick: " + pickText(e.would_pick, names));
    if (e.line) parts.push("line verdict " + (e.line.ok ? "ok" : "bad"));
    if (e.note) parts.push("note: " + e.note);
    return parts.join(" · ");
  });
  return { legacy, review, entries };
}

// A note for the card when the depth check did not hold, or could not be made (absent, or `stable: null` when the
// deeper search failed or was cut: that is not "changed"); null when it held.
function depthNote(card, names) {
  const d = card.depth_check;
  if (!d || d.stable === null || d.stable === undefined) return "The depth check could not be made for this card (it was off, or the deeper search failed or was cut): whether the #1 holds one ply deeper is unknown.";
  if (d.stable) return null;
  const top3 = d.top_3.map((a) => a.map((c) => dn(names, c)).join(" + ")).join(" | ");
  return "One ply deeper (horizon " + d.horizon + ") the #1 " + (d.same_first ? "held" : "changed") + " and the top 3 " + (d.same_top_3 ? "held" : "changed") + ". Deeper top 3: " + top3 + ". Read a clear never on this card with care.";
}

// The blind rows are counted in `progress`; the rows that only come after the reveal are counted here.
function laterProgress(data, state) {
  let done = 0;
  let total = 0;
  for (const draft of data.drafts) {
    if (draftSealed(draft)) continue; // its later rows are never shown
    for (const card of draft.cards) {
      const ps = positionState(state, card.id);
      const rows = laterRows(card);
      total += rows.length;
      done += rows.filter((o) => ps.labels[o.id] !== undefined).length;
    }
  }
  return { done, total };
}

// ---- the export (design section 3: tier-b-verdicts/1) ------------------------------------------

function pickToExport(card, rawValue, names) {
  if (rawValue === null) return { value: null };
  const value = card.kind === "pair" ? rawValue : plainPick(rawValue);
  const ids = Array.isArray(value) ? value : [value];
  const problem = pickProblem(card, ids, names);
  if (problem) return { problem };
  return { value };
}

function checkUtc(text, what) {
  if (!isUtc(text)) throw new Error(what + " is not an ISO-8601 UTC time: " + String(text));
  return text;
}

// `data` is the page's data (assemblePageData's result: it holds the run's stamps and each card's `base`).
// The export is the page's whole state at `rev`, so the newest export supersedes the rest; a position with
// nothing recorded on this page is left out. An own pick the loader would refuse (a half pair, a duplicate, an
// unknown id, an array at a single root) is left out and named in `problems`. Option ids and the line text are
// copied from the run, never built or re-sorted. The pre-set `via: "own-pick"` is an ordinary label here.
function exportWithProblems(state, data) {
  const stamps = data.run.data || {};
  for (const key of ["fm_version", "positions_patch"]) {
    if (typeof stamps[key] !== "string" || stamps[key] === "") throw new Error("the run carries no " + key + ": an export without it would be refused by the loader");
  }
  const problems = [];
  const positions = {};
  for (const draft of data.drafts) {
    for (const card of draft.cards) {
      // No option is judged at a ban root: the loader warns and does not read `verdicts` there.
      if (card.kind === "ban") continue;
      const ps = positionState(state, card.id);
      const blind = ps.span.blind;
      const scored = ps.span.scored;
      // A change made here in a mode that has no valid span (restored storage with a bad time) cannot be dated.
      // The position is refused by name, whole, rather than exported half: apply would otherwise never hear of it.
      const changeModes = new Set();
      for (const rec of Object.values(ps.labels)) if (rec.mode) changeModes.add(rec.mode);
      if (ps.pick && ps.pick.mode) changeModes.add(ps.pick.mode);
      if (ps.note) changeModes.add(ps.note.mode);
      if (ps.line) changeModes.add("scored");
      const undated = [...changeModes].filter((m) => !ps.span[m]);
      if (undated.length > 0) {
        problems.push(card.id + ": not exported: changes in " + undated.join(" and ") + " mode have no valid start and end time (the stored state was damaged)");
        continue;
      }
      if (!blind && !scored) continue;
      const out = { base: card.base };
      if (blind) {
        const b = { started: checkUtc(blind.first, "blind.started"), finished: checkUtc(blind.last, "blind.finished") };
        if (ps.pick && ps.pick.blind !== undefined) {
          const p = pickToExport(card, ps.pick.blind, data.names);
          if (p.problem) problems.push(card.id + ": own pick not exported: " + p.problem);
          else b.would_pick = p.value;
        }
        b.labels = {};
        for (const o of card.options) {
          const rec = ps.labels[o.id];
          if (rec && rec.blind !== undefined) b.labels[o.id] = rec.blind;
        }
        out.blind = b;
      }
      out.revealed = Boolean(scored);
      if (scored) {
        const s = { started: checkUtc(scored.first, "scored.started"), finished: checkUtc(scored.last, "scored.finished") };
        if (ps.pick && ps.pick.mode === "scored") {
          const p = pickToExport(card, ps.pick.current, data.names);
          if (p.problem) problems.push(card.id + ": own pick not exported: " + p.problem);
          else s.would_pick = p.value;
        }
        s.labels = {};
        for (const o of card.options) {
          const rec = ps.labels[o.id];
          if (rec && rec.mode === "scored") s.labels[o.id] = rec.current;
        }
        if (ps.line) s.line = { option: ps.line.option, line: ps.line.line, ok: ps.line.ok };
        out.scored = s;
      }
      if (ps.note && ps.note.text !== "") out.note = ps.note.text;
      positions[card.id] = out;
    }
  }
  const exported = {
    schema: "tier-b-verdicts/1",
    run: data.run.id,
    rev: state.rev,
    data: { fm_version: stamps.fm_version, positions_patch: stamps.positions_patch },
    positions,
  };
  return { exported, problems };
}

function buildExport(state, data) {
  return exportWithProblems(state, data).exported;
}

// ---- the results tab (design section 5) --------------------------------------------------------
// Pure readers of the run's `metrics` block (absent when the run has no labels). Nothing here scores anything.
//
// Blind rule: the results are corpus-wide aggregates, which are shown. What is NOT shown is anything that
// names an unrevealed draft's positions or options (which position has a clear never at #1, which row is the
// engine's #1 there): `positionVisible` gates every list of positions, and an unrevealed draft's positions are
// only counted ("n in drafts not yet revealed"). Nothing here touches `state`, so reading or selecting from the
// tab never reveals a draft.

// The heat table has four steps of one hue (palette blue 100/200/300/400 in light, 700/600/500/400 in dark).
const HEAT_STEPS = 4;

// The step of a count: 0 (the lightest, near zero) for 0, then the rest spread evenly to the largest count.
// The printed number is the value; the step only orders it.
function heatStep(value, max) {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(HEAT_STEPS - 1, Math.max(1, Math.ceil((value / max) * (HEAT_STEPS - 1))));
}

// The count range each step stands for, as printed in the key: [{ step, text }] for the steps that hold a count.
function heatLegend(max) {
  const ranges = [];
  const top = Math.max(0, max);
  for (let v = 0; v <= top; v++) {
    const step = heatStep(v, max);
    const last = ranges[ranges.length - 1];
    if (last && last.step === step) last.hi = v;
    else ranges.push({ step, lo: v, hi: v });
  }
  return ranges.map((r) => ({ step: r.step, text: r.lo === r.hi ? String(r.lo) : r.lo + "-" + r.hi }));
}

// `n`, `≥n` where positions are unjudged at that k (n is then the lower bound), `(+m)` for near ties.
function countText(m, j) {
  return (m.unjudged[j] > 0 ? "≥" : "") + m.never[j] + (m.near[j] > 0 ? "(+" + m.near[j] + ")" : "");
}

function rosterArms(metrics) {
  return metrics.arms.filter((a) => a.role === "roster");
}

// One cell of the table. The number is `text`; `tags` say, in words, what the colour must not carry alone.
function cellModel(arm, metrics, max) {
  const m = arm.metrics;
  const rule = metrics.rule;
  const tags = [];
  if (rule.pick === arm.id) tags.push("rule's pick");
  else if (rule.ties.includes(arm.id)) tags.push("tied with the pick");
  if (metrics.reference === arm.id) tags.push("current defaults");
  if (rule.pick === arm.id && rule.edge.length > 0) tags.push("on the grid's edge");
  if (!arm.readable) tags.push("not readable");
  if (m.non_speaking > 0) tags.push(m.non_speaking + " of " + m.positions + " do not speak");
  return {
    id: arm.id,
    role: arm.role,
    text: countText(m, 0),
    step: heatStep(m.never[0], max),
    readable: arm.readable,
    tags,
  };
}

// The table: roster arms by P (rows) and Q (columns), the pool_or_roster row and the floor rows beside it.
function gridModel(metrics) {
  const roster = rosterArms(metrics);
  const axis = (key) => [...new Set(roster.map((a) => a[key]))].sort((a, b) => a - b);
  const ps = axis("p");
  const qs = axis("q");
  const max = Math.max(0, ...roster.map((a) => a.metrics.never[0]));
  const rows = ps.map((p) => qs.map((q) => {
    const arm = roster.find((a) => a.p === p && a.q === q);
    return arm ? cellModel(arm, metrics, max) : null;
  }));
  const por = metrics.arms.find((a) => a.role === "pool_or_roster");
  return {
    ps,
    qs,
    rows,
    max,
    por: por ? cellModel(por, metrics, max) : null,
    floors: metrics.arms.filter((a) => a.role === "floor").map((a) => ({
      id: a.id,
      text: countText(a.metrics, 0),
      never3: countText(a.metrics, 1),
      pick3: a.metrics.pick[1],
      nonSpeaking: a.metrics.non_speaking,
      positions: a.metrics.positions,
      unknownR: a.unknown_r_kept,
    })),
  };
}

// Whether a position of the run may be named on the results tab: only once its draft is revealed.
function positionVisible(data, state, positionId) {
  for (const d of data.drafts) {
    if (d.cards.some((c) => c.id === positionId)) return draftShown(d, state);
  }
  return false;
}

// "a, b" for the visible ids, then how many were left unnamed: "none" for an empty list.
function namedPositions(ids, visible) {
  if (ids.length === 0) return "none";
  const named = ids.filter(visible);
  const hidden = ids.length - named.length;
  const parts = [];
  if (named.length > 0) parts.push(named.join(", "));
  if (hidden > 0) parts.push((named.length > 0 ? "+" : "") + hidden + " in drafts not yet revealed (not named)");
  return parts.join(" ");
}

// The tooltip / detail text of an arm: what the table does not print, and the positions behind each count.
function hoverLines(arm, visible) {
  const m = arm.metrics;
  const p = arm.positions;
  const named = (key) => namedPositions(p[key], visible);
  const lines = [
    arm.id + (arm.role === "roster" ? "" : arm.role === "pool_or_roster" ? " (not a candidate for the pick)" : arm.role === "weight" ? " (weighted arm: not a candidate for the pick, read by the w read)" : " (comparison row, not selectable)"),
    "never@1 " + countText(m, 0) + ", never@3 " + countText(m, 1) + ", pick@3 " + m.pick[1] + " of " + m.with_pick + " with an own pick",
    "never@1 " + m.never[0] + ", near " + m.near[0] + ", unjudged " + m.unjudged[0] + ". never@3 " + m.never[1] + ", near " + m.near[1] + ", unjudged " + m.unjudged[1] + ".",
    "never@1 at: " + named("never_1"),
    "near ties at 1: " + named("near_1"),
    "unjudged at 1: " + named("unjudged_1"),
    "never@3 at: " + named("never_3"),
    "near ties at 3: " + named("near_3"),
    "unjudged at 3: " + named("unjudged_3"),
    "pick@3 holds at: " + named("pick_3"),
    "own pick outside the top 3 at: " + named("pick_3_out"),
    "positions that do not speak: " + named("not_speaking"),
    "own pick median rank " + rankText(m) + " (absent " + m.pick_absent + " of " + m.with_pick + "), median regret " + regretText(m) + ", opp_charge_lead " + m.opp_charge_lead,
    "bad_line@1 " + m.bad_line + " bad of " + m.judged_line + " judged, " + m.unjudged_line + " unjudged, " + m.no_line + " with no line",
  ];
  if (m.unjudged[0] > 0 || m.unjudged[1] > 0) lines.splice(3, 0, "upper bounds (never + unjudged): ≤" + (m.never[0] + m.unjudged[0]) + " / ≤" + (m.never[1] + m.unjudged[1]));
  if (!arm.readable && arm.role !== "weight") lines.splice(1, 0, "not readable: a position does not speak, or a count is unjudged at k = 1 or 3");
  return lines;
}

// The arm index a table click selects for the cards: a roster or pool_or_roster arm of the run, else -1
// (a floor row is not an arm of the run, so it is never selectable). Selecting changes the arm the revealed
// cards show and nothing else.
function armChoice(data, armId) {
  return data.run.arms.findIndex((a) => a.id === armId);
}

// What the page says about a selection, in words.
function selectionNote(data, state, armIdx) {
  const arm = data.run.arms[armIdx];
  const label = armLabel(arm, data.run.reference_arm);
  const revealed = data.drafts.some((d) => draftShown(d, state));
  return "Cards show: " + label + (revealed ? "." : ". No draft is revealed yet, so no card shows an arm.");
}

function arrow(a, b) {
  return a + " → " + b;
}

// The median own-pick rank as the summary spells it: a number, `∞` when every own pick is absent, `none` with no own pick.
function rankText(m) {
  if (m.pick_median_rank_absent) return "∞";
  return m.pick_median_rank === null || m.pick_median_rank === undefined ? "none" : String(m.pick_median_rank);
}
function regretText(m) {
  return m.pick_median_regret === null || m.pick_median_regret === undefined ? "none" : m.pick_median_regret.toFixed(3);
}

// The receipt's second line (summary.txt prints the same words).
function receiptAlso(f, t) {
  return "also near@3 " + arrow(f.near[1], t.near[1]) + ", play@1 " + arrow(f.play[0], t.play[0]) + ", play@3 " + arrow(f.play[1], t.play[1]) +
    ", no_play@3 " + arrow(f.no_play[1], t.no_play[1]) + " (neither " + arrow(f.neither_play[1], t.neither_play[1]) + "), own pick median rank " +
    rankText(f) + " → " + rankText(t) + " (absent " + f.pick_absent + " of " + f.with_pick + " → " + t.pick_absent + " of " + t.with_pick +
    "), median regret " + regretText(f) + " → " + regretText(t) + ", opp_charge_lead " + arrow(f.opp_charge_lead, t.opp_charge_lead);
}

function receiptLines(r, visible) {
  const f = r.from;
  const t = r.to;
  const out = [
    "never@1 " + arrow(f.never[0], t.never[0]) + " (in-pool " + arrow(f.never_1_by_class.in_pool, t.never_1_by_class.in_pool) +
      ", off-pool base " + arrow(f.never_1_by_class.off_pool_base, t.never_1_by_class.off_pool_base) +
      ", off-pool graded " + arrow(f.never_1_by_class.off_pool_graded, t.never_1_by_class.off_pool_graded) + "), near@1 " + arrow(f.near[0], t.near[0]) +
      ", never@3 " + arrow(f.never[1], t.never[1]) + ", pick@3 " + arrow(f.pick[1], t.pick[1]) +
      ", pick_off@3 " + f.pick_off[1] + " of " + f.pick_off_eligible + " → " + t.pick_off[1] + " of " + t.pick_off_eligible +
      ", top in-pool " + arrow(f.top_in_pool, t.top_in_pool),
    receiptAlso(f, t),
    "own pick leaves the top 3 at: " + namedPositions(r.leaves_top_3, visible),
    "own pick enters the top 3 at: " + namedPositions(r.enters_top_3, visible),
  ];
  for (const [name, s] of [["depth check did not hold", r.unstable], ["the others", r.stable]]) {
    out.push(name + " (" + s.positions.length + " positions" + (s.positions.length > 0 ? ": " + namedPositions(s.positions, visible) : "") + "): never@1 " + arrow(s.from.never[0], s.to.never[0]) +
      ", never@3 " + arrow(s.from.never[1], s.to.never[1]) + ", pick@3 " + arrow(s.from.pick[1], s.to.pick[1]));
  }
  return out;
}

const pickWords = (p) => (p === null || p === undefined ? "none readable" : p);

// The rule's line: "N of M arms readable. Pick: ..." or "0 of M arms readable, so it names no pick."
function ruleLine(rule) {
  if (rule.readable === 0) return "0 of " + rule.roster_arms + " arms readable, so the rule names no pick. The worklist below says what is left to judge.";
  return rule.readable + " of " + rule.roster_arms + " arms readable. Pick: " + pickWords(rule.pick) +
    (rule.ties.length > 1 ? " (tied on the three keys: " + rule.ties.join(", ") + ")" : "");
}

function sensitivityLines(s) {
  const tail = (x) => (x.pick === null || x.pick === undefined ? "no pick" : x.pick) + " (" + x.readable + " readable)";
  return [
    ...s.margins.map((x) => "ε " + x.margin + ": " + tail(x)),
    ...s.leave_out.map((x) => "without " + x.draft + ": " + tail(x)),
  ];
}

function secondLine(sl) {
  const o = sl.outcome;
  return o.readable + " of " + o.roster_arms + " arms readable, pick " + pickWords(o.pick) + (sl.differs ? "  ** DIFFERS from the blind read **" : " (same as the blind read)");
}

// `bad_line@1` as "bad of judged", for the reference arm and the rule's pick.
function badLineLines(metrics) {
  const byId = (id) => metrics.arms.find((a) => a.id === id);
  const text = (a) => a.id + ": " + a.metrics.bad_line + " bad of " + a.metrics.judged_line + " judged, " + a.metrics.unjudged_line + " unjudged, " + a.metrics.no_line + " with no line";
  const ref = byId(metrics.reference);
  const pick = metrics.rule.pick === null ? undefined : byId(metrics.rule.pick);
  const out = [];
  if (ref) out.push((pick && pick.id === ref.id ? "reference = pick, " : "reference, ") + text(ref));
  if (pick && ref && pick.id !== ref.id) out.push("pick, " + text(pick));
  return out;
}

function neverEverywhereLine(list, visible) {
  return list.length === 0 ? "none" : namedPositions(list, visible);
}

function rByLabelRows(rows) {
  return rows.map((r) => ({ bucket: r.bucket, play: r.play, maybe: r.maybe, never: r.never }));
}

// reveal_changes for the page: the changed labels and picks of visible positions (a revealed draft's own answers).
function revealChangesView(rc, visible) {
  return { labels: rc.labels.filter((c) => visible(c.position)), picks: rc.picks.filter((c) => visible(c.position)) };
}

function revealChangesLine(rc) {
  return rc.labels.length + " of " + rc.blind_labels + " blind labels and " + rc.picks.length + " of " + rc.blind_picks +
    " blind picks changed after the reveal; drafts revealed: " + (rc.drafts_revealed.length === 0 ? "none" : rc.drafts_revealed.join(", ")) +
    "; reveals with no change: " + (rc.reveals_without_change.length === 0 ? "none" : rc.reveals_without_change.join(", "));
}

// The worklist for the page: unlabelled rows and unjudged #1 lines are listed only for revealed drafts' positions
// (an unlabelled row or a #1 line at an unrevealed draft is an engine fact about it); the rest is a count.
function worklistView(w, visible) {
  const shown = w.unlabelled_rows.filter((e) => visible(e.position));
  const hiddenRows = w.unlabelled_rows.filter((e) => !visible(e.position)).reduce((n, e) => n + e.rows.length, 0);
  const lines = w.unjudged_lines.filter((l) => visible(l.position));
  return {
    unlabelled: shown.map((e) => ({ position: e.position, rows: e.rows })),
    hiddenRows,
    linesAt: w.lines_at,
    unjudgedLines: lines,
    hiddenLines: w.unjudged_lines.length - lines.length,
    totalLines: w.unjudged_lines.length,
    notJudgeable: w.not_judgeable,
  };
}

// The worklist's #1-lines header, as summary.txt words it.
function linesHeader(w) {
  return "#1 lines at " + (w.linesAt === null || w.linesAt === undefined ? "-" : w.linesAt) + " with no line verdict: " + w.totalLines + " (" + w.notJudgeable +
    " not judgeable on the page: it offers a verdict only on the reference arm's #1 line)";
}
const NOT_JUDGEABLE = "  [not judgeable on the page]";

// The `≥` cells are lower bounds: never + unjudged is the upper end, for every arm that has an unjudged position
// (floor rows included), as summary.txt lists them.
function upperBoundLines(metrics) {
  return metrics.arms
    .filter((a) => a.metrics.unjudged[0] > 0 || a.metrics.unjudged[1] > 0)
    .map((a) => a.id + "  ≤" + (a.metrics.never[0] + a.metrics.unjudged[0]) + " / ≤" + (a.metrics.never[1] + a.metrics.unjudged[1]));
}

function labelsLine(l) {
  return l.options + " options labelled over " + l.labelled_positions + " of " + l.positions + " positions (" + l.blind_options + " blind, " + l.scored_only_options +
    " scored only), " + l.own_picks + " own picks (" + l.blind_picks + " blind). Read from the current fold, no blind answer: " + l.fallback_labels + " labels, " + l.fallback_picks + " own picks.";
}

export { draftSealed, draftShown, BLIND_REACH, LABELS, armLabel, cardSettled, currentLineVerdict, currentNote, earlierView, blindRows, buildExport, buildNameIndex, cardDone, cardRows, currentLabel, depthNote, dn, draftRevealState, exportWithProblems, hash53, isPositionRevealed, isUtc, labelMode, laterProgress, laterRows, lineText, makeStorage, menuView, newState, ownPickPlace, parseNameInput, pickAnswered, pickProblem, pickText, poolTag, progress, referenceArmIndex, referenceTop, restoreState, revealDraft, revealRows, rowView, samePick, setLabel, setLineVerdict, setNote, setPick, shuffleRows, sideParts, sideText, stageTwoOpen, HEAT_STEPS, linesHeader, NOT_JUDGEABLE, upperBoundLines, heatLegend, revealChangesView, armChoice, badLineLines, cellModel, countText, gridModel, heatStep, hoverLines, labelsLine, namedPositions, neverEverywhereLine, positionVisible, rByLabelRows, receiptLines, revealChangesLine, ruleLine, secondLine, selectionNote, sensitivityLines, worklistView };
