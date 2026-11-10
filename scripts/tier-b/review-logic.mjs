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
//       revealedAt: null | <time>                                         set by the reveal (task 6) or the seed
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
          if (isPlain(s) && typeof s.first === "string" && typeof s.last === "string") span[mode] = { first: s.first, last: s.last };
        }
        ps.span = span;
      }
      if (typeof sp.revealedAt === "string") ps.revealedAt = sp.revealedAt;
    }
  }
  return seed;
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

function touch(state, ps, mode, now) {
  const span = ps.span[mode];
  ps.span[mode] = span ? { first: span.first, last: now } : { first: now, last: now };
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
function sideParts(option) {
  const acting = (c) => option.action.includes(c.champion);
  const own = option.side.filter(acting).sort((a, b) => option.action.indexOf(a.champion) - option.action.indexOf(b.champion));
  const rest = option.side.filter((c) => !acting(c));
  return [...own, ...rest].map((c) => ({
    champion: c.champion,
    role: c.role,
    moved: c.locked && !c.in_pool,
    acting: acting(c),
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

export { BLIND_REACH, LABELS, blindRows, buildNameIndex, cardDone, cardRows, makeStorage, rowView, currentLabel, dn, draftRevealState, hash53, isPositionRevealed, labelMode, laterRows, newState, parseNameInput, pickAnswered, pickProblem, pickText, poolTag, progress, restoreState, samePick, setLabel, setPick, shuffleRows, sideParts, sideText, stageTwoOpen };
