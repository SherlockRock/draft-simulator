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
        const pick = { current: wp.current === undefined ? wp.blind : wp.current, mode: null, t: null };
        if (wp.blind !== undefined) pick.blind = wp.blind;
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
      if (validRecord(sp.pick, validPickValue)) ps.pick = cleanRecord(sp.pick);
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
  return pickAnswered(ps) || Object.keys(ps.labels).length > 0 || draftRevealState(draft, state) === "revealed";
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

// The card's note: free text, recorded in the mode it was written in (it dates that mode's span).
function setNote(state, draft, cardId, text, now) {
  const card = draft.cards.find((c) => c.id === cardId);
  if (!card) throw new Error("card " + cardId + " is not in draft " + draft.id);
  const ps = positionState(state, cardId);
  const next = text.trim();
  if ((ps.note ? ps.note.text : "") === next) return false;
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
  if (draftRevealState(draft, state) !== "revealed") throw new Error("the line is shown, and judged, only after the reveal");
  const top = referenceTop(data, card);
  if (!top || top.line === null) throw new Error("there is no line to judge on " + cardId);
  const ps = positionState(state, cardId);
  if (ps.line && ps.line.option === top.option.id && ps.line.line === top.line && ps.line.ok === ok) return false;
  ps.line = { option: top.option.id, line: top.line, ok, t: now };
  touch(state, ps, "scored", now);
  return true;
}

function armLabel(arm, referenceId) {
  const base = arm.rule === "roster" ? "P " + arm.p + "  Q " + arm.q : "pool or roster";
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

// A note for the card when the depth check did not hold; null when it held or was not run.
function depthNote(card, names) {
  const d = card.depth_check;
  if (!d || d.stable) return null;
  const top3 = d.top_3.map((a) => a.map((c) => dn(names, c)).join(" + ")).join(" | ");
  return "One ply deeper (horizon " + d.horizon + ") the #1 " + (d.same_first ? "held" : "changed") + " and the top 3 " + (d.same_top_3 ? "held" : "changed") + ". Deeper top 3: " + top3 + ". Read a clear never on this card with care.";
}

// The blind rows are counted in `progress`; the rows that only come after the reveal are counted here.
function laterProgress(data, state) {
  let done = 0;
  let total = 0;
  for (const draft of data.drafts) {
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

function pickToExport(card, value, names) {
  if (value === null) return { value: null };
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

export { BLIND_REACH, LABELS, armLabel, earlierView, blindRows, buildExport, buildNameIndex, cardDone, cardRows, currentLabel, depthNote, dn, draftRevealState, exportWithProblems, hash53, isPositionRevealed, isUtc, labelMode, laterProgress, laterRows, lineText, makeStorage, menuView, newState, ownPickPlace, parseNameInput, pickAnswered, pickProblem, pickText, poolTag, progress, referenceArmIndex, referenceTop, restoreState, revealDraft, revealRows, rowView, samePick, setLabel, setLineVerdict, setNote, setPick, shuffleRows, sideParts, sideText, stageTwoOpen };
