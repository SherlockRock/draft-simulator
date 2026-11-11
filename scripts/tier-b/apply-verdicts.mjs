#!/usr/bin/env node
// Writes the review page's verdict export back into the Tier B fixtures as append-only `verdicts` entries
// (design: docs/designs/tier-b-review-tool-design.md, section 3b), then re-runs the review.
//
//   node scripts/tier-b/apply-verdicts.mjs <verdicts.json> [--fixtures <dir>] [--no-review]
//
// What it does to one position, in this order (applyPosition):
//   1. replay / older: an entry from this run with `rev` at or above the export's -> write nothing.
//   2. stale: the fixture holds entries beyond the export's `base` from a different run -> refuse, name it.
//   3. otherwise write what differs: a `blind` entry (labels / own pick that differ from the blind fold), a
//      `scored` entry (what differs from the current fold after the blind entry, and the line verdict), or one
//      empty `scored` entry for a reveal that changed nothing, once. The note rides on the last entry written.
// Every entry written is checked against the loader's rules first (validateVerdicts mirrors
// packages/engine-core/src/reference/tier_b.rs; tests/data/tier-b-review/refusal-vectors.json is the shared
// test), and a position that would fail is refused by name and left byte-identical. The two folds exist here
// and in the loader; tests/data/tier-b-review/fold-vectors.json keeps them equal.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const DEFAULT_FIXTURES = path.join(REPO, "packages/engine-core/fixtures/tier-b");

const SCHEMA = "tier-b-verdicts/1";
const LABEL_NAMES = ["play", "maybe", "never"];
const MODE_NAMES = ["blind", "scored"];
const ROLE_KEYS = ["top", "jungle", "mid", "adc", "support"];

// ---- the standard format (packages/engine-core/src/reference/format.rs, STANDARD_TURNS) --------

const STANDARD_TURNS = [
  ["Blue", "ban"], ["Red", "ban"], ["Blue", "ban"], ["Red", "ban"], ["Blue", "ban"], ["Red", "ban"],
  ["Blue", "pick"], ["Red", "pair"], ["Blue", "pair"], ["Red", "pick"],
  ["Red", "ban"], ["Blue", "ban"], ["Red", "ban"], ["Blue", "ban"],
  ["Red", "pick"], ["Blue", "pair"], ["Red", "pick"],
];

const SLOTS = STANDARD_TURNS.flatMap(([side, kind]) =>
  kind === "pair"
    ? [{ side, action: "pick", pairStart: true }, { side, action: "pick", pairStart: false }]
    : [{ side, action: kind, pairStart: false }],
);

// The root of a fixture: the slot after its board. `kind` is ban / pair / single (a mid-pair root is a
// single pick: its first half is already on the board). `moverPicks` are the mover's locked picks.
function rootOf(fixture) {
  const board = Array.isArray(fixture.position) ? fixture.position : [];
  const slot = SLOTS[board.length];
  if (!slot) return null;
  const kind = slot.action === "ban" ? "ban" : slot.pairStart ? "pair" : "single";
  const moverPicks = board.filter((e) => e.side === slot.side && e.kind === "pick" && typeof e.champion === "string").map((e) => e.champion);
  return { kind, side: slot.side, moverPicks };
}

// The id's text between the `YYYY-MM-DD-` prefix and `-pinch` or `-slot-`; the whole id when there is no date
// prefix, neither marker, or nothing between (mirrors tier_b_review.rs `draft_of`).
function draftOf(id) {
  if (!/^\d{4}-\d\d-\d\d-/.test(id) || id.length <= 11) return id;
  const rest = id.slice(11);
  const at = ["-pinch", "-slot-"].map((m) => rest.indexOf(m)).filter((i) => i >= 0);
  const first = at.length ? Math.min(...at) : -1;
  return first > 0 ? rest.slice(0, first) : id;
}

function isPlain(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function byCode(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- the folds ---------------------------------------------------------------------------------

function asIds(value) {
  return Array.isArray(value) ? value : [value];
}

// Two picks are equal as sets (the order written is not the order stored); "no view" (null) equals only itself.
function samePick(a, b) {
  if (a === null || b === null) return a === b;
  const x = asIds(a);
  const y = asIds(b);
  return x.length === y.length && x.every((c) => y.includes(c)) && y.every((c) => x.includes(c));
}

// Entries are read in file order. `current` is the last label written for each option in any mode, `blind`
// the last written in a blind entry; the own pick folds the same two ways (`undefined`: never answered,
// `null`: "no view"); `lines` is the last write for each (option, line), ordered by where that write sits.
function foldVerdicts(entries) {
  const out = { blind: {}, current: {}, blindPick: undefined, currentPick: undefined, lines: [], revealed: false };
  for (const e of entries) {
    const blind = e.mode === "blind";
    if (!blind) out.revealed = true;
    for (const [option, label] of Object.entries(e.labels || {})) {
      out.current[option] = label;
      if (blind) out.blind[option] = label;
    }
    if (has(e, "would_pick")) {
      out.currentPick = e.would_pick;
      if (blind) out.blindPick = e.would_pick;
    }
    if (e.line) {
      out.lines = out.lines.filter((l) => !(l.option === e.line.option && l.line === e.line.line));
      out.lines.push({ option: e.line.option, line: e.line.line, ok: e.line.ok });
    }
  }
  return out;
}

// ---- validation: the loader's rules (tier_b.rs resolve_verdicts, OptionKey::parse) --------------

// `YYYY-MM-DDTHH:MM:SS[.f]Z`, a real date and time: ISO-8601 UTC, as the loader's `is_utc_timestamp`.
function isUtcTimestamp(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(\.\d+)?Z$/.exec(typeof s === "string" ? s : "");
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return month >= 1 && month <= 12 && day >= 1 && day <= days && hour < 24 && minute < 60 && second < 60;
}

// Why these champion ids are not an action at this root, or null (spec_to_action).
function actionProblem(names, root, champions) {
  for (const c of names) {
    if (typeof c !== "string") return "champion ids are strings";
    if (champions && !champions.has(c)) return `unknown champion ${JSON.stringify(c)}`;
  }
  if (names.length === 1) {
    return root.kind === "pair" ? "the root is a pair turn; expected actions are [a, b] pairs" : null;
  }
  if (root.kind !== "pair") return "the root is not a pair turn; expected actions are single ids";
  return names[0] === names[1] ? "a pair of the same champion" : null;
}

// Why this string is not an option id at this root, or null (OptionKey::parse).
function optionProblem(id, root, champions) {
  const bar = id.indexOf("|");
  const left = bar < 0 ? id : id.slice(0, bar);
  const right = bar < 0 ? undefined : id.slice(bar + 1);
  const names = left.split("+");
  if (names.length > 2) return `${JSON.stringify(left)} is not one champion or two joined by '+'`;
  const bad = actionProblem(names, root, champions);
  if (bad) return bad;
  const locked = names.find((c) => root.moverPicks.includes(c));
  if (locked) return `${locked} is already one of the side's locked picks; the action must add new champions`;
  // Byte order of the ids (plain code-unit comparison, never localeCompare).
  if (names.length === 2 && names[0] > names[1]) {
    return `the pair is not sorted by id: write ${names[1]}+${names[0]}, the one spelling of an option`;
  }
  if (right === undefined) return null;
  if (right === "") return "an empty comp after '|'; leave the '|' off to give the action alone";
  const listed = [];
  let lastRole = -1;
  for (const part of right.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) return `comp entry ${JSON.stringify(part)} is not role=champion`;
    const key = part.slice(0, eq);
    const champion = part.slice(eq + 1);
    const role = ROLE_KEYS.indexOf(key);
    if (role < 0) return `unknown role key ${JSON.stringify(key)}; the keys are ${ROLE_KEYS.join(", ")}`;
    if (role <= lastRole) return `the comp's roles must be in the order ${ROLE_KEYS.join(", ")}, each once; ${JSON.stringify(key)} is out of place`;
    lastRole = role;
    if (champions && !champions.has(champion)) return `unknown champion ${JSON.stringify(champion)}`;
    listed.push(champion);
  }
  const twice = listed.find((c, i) => listed.indexOf(c) !== i);
  if (twice) return `the comp lists ${twice} twice`;
  const missingLocked = root.moverPicks.find((c) => !listed.includes(c));
  if (missingLocked) return `the comp is missing ${missingLocked}, a pick the side has already locked`;
  const missingAction = names.find((c) => !listed.includes(c));
  if (missingAction) return `the comp is missing ${missingAction}, a champion of the action`;
  const extra = listed.find((c) => !root.moverPicks.includes(c) && !names.includes(c));
  if (extra) return `the comp has ${extra}, who is neither a locked pick nor in the action`;
  return null;
}

const ENTRY_KEYS = ["started", "finished", "mode", "from", "fm_version", "positions_patch", "would_pick", "labels", "line", "note"];

// The structure the loader's reader (serde) needs before it looks at any value: the first problem, as
// `{ field, reason }`, or null. A missing field is named bare (`started`), as serde names it.
function structureProblem(entry, i) {
  const at = (name) => `verdicts[${i}].${name}`;
  if (!isPlain(entry)) return { field: `verdicts[${i}]`, reason: "an entry is an object" };
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.includes(key)) return { field: at(key), reason: "unknown field" };
  }
  for (const key of ["started", "finished", "mode", "from", "fm_version", "positions_patch"]) {
    if (!has(entry, key)) return { field: key, reason: `missing field ${key}` };
  }
  const from = entry.from;
  if (!isPlain(from) || Object.keys(from).some((k) => k !== "run" && k !== "rev") || typeof from.run !== "string" || !Number.isInteger(from.rev) || from.rev < 0) {
    return { field: at("from"), reason: "from is { run: string, rev: non-negative integer }" };
  }
  if (has(entry, "would_pick") && entry.would_pick !== null) {
    const p = entry.would_pick;
    const shapeOk = typeof p === "string" || (Array.isArray(p) && p.length === 2 && p.every((c) => typeof c === "string"));
    if (!shapeOk) return { field: at("would_pick"), reason: "would_pick is null, a champion id, or two champion ids" };
  }
  if (has(entry, "labels") && (!isPlain(entry.labels) || Object.values(entry.labels).some((l) => typeof l !== "string"))) {
    return { field: at("labels"), reason: "labels map option ids to label names" };
  }
  if (has(entry, "line") && entry.line !== null) {
    const l = entry.line;
    if (!isPlain(l) || Object.keys(l).some((k) => !["option", "line", "ok"].includes(k)) || typeof l.option !== "string" || !has(l, "line") || typeof l.ok !== "boolean") {
      return { field: at("line"), reason: "line is { option: string, line, ok: boolean }" };
    }
  }
  if (has(entry, "note") && entry.note !== null && typeof entry.note !== "string") {
    return { field: at("note"), reason: "note is a string" };
  }
  return null;
}

// The loader's refusals for a fixture's `verdicts`, as `[{ field, reason }]` (empty: the loader reads it; at
// most the first problem is given, as the loader stops there). `champions` is the set of known ids; without it
// the unknown-champion check is skipped.
function validateVerdicts(fixture, entries, champions) {
  const root = rootOf(fixture);
  if (!root) return [{ field: "position", reason: "the draft is complete; nothing to evaluate" }];
  if (entries.length === 0) return [];
  if (root.kind === "ban") return [{ field: "verdicts", reason: "no options to judge at a ban root; the loader does not read them" }];
  for (let i = 0; i < entries.length; i++) {
    const problem = structureProblem(entries[i], i);
    if (problem) return [problem];
  }
  let revealed = false;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const at = (name) => `verdicts[${i}].${name}`;
    for (const key of ["started", "finished"]) {
      if (typeof e[key] !== "string") return [{ field: at(key), reason: `must be a string, got ${JSON.stringify(e[key])}` }];
      if (!isUtcTimestamp(e[key])) return [{ field: at(key), reason: `${JSON.stringify(e[key])} is not an ISO-8601 UTC timestamp like 2026-11-09T14:10:05Z` }];
    }
    if (typeof e.mode !== "string") return [{ field: at("mode"), reason: `must be a string, got ${JSON.stringify(e.mode)}` }];
    if (!MODE_NAMES.includes(e.mode)) return [{ field: at("mode"), reason: `unknown mode ${JSON.stringify(e.mode)}; the modes are ${MODE_NAMES.join(", ")}` }];
    for (const key of ["fm_version", "positions_patch"]) {
      if (typeof e[key] !== "string") return [{ field: at(key), reason: `must be a string, got ${JSON.stringify(e[key])}` }];
    }
    if (e.mode === "blind" && revealed) {
      return [{ field: at("mode"), reason: "a blind entry after a scored one; once a position has been revealed every later label is scored" }];
    }
    if (e.mode === "scored") revealed = true;
    if (has(e, "would_pick") && e.would_pick !== null) {
      const bad = actionProblem(asIds(e.would_pick), root, champions);
      if (bad) return [{ field: at("would_pick"), reason: bad }];
    }
    for (const option of Object.keys(e.labels || {}).sort(byCode)) {
      const field = at(`labels[${option}]`);
      const bad = optionProblem(option, root, champions);
      if (bad) return [{ field, reason: bad }];
      if (!LABEL_NAMES.includes(e.labels[option])) {
        return [{ field, reason: `unknown label ${JSON.stringify(e.labels[option])}; the labels are ${LABEL_NAMES.join(", ")}` }];
      }
    }
    if (e.line) {
      if (e.mode === "blind") return [{ field: at("line"), reason: "a line verdict in a blind entry; the line is shown only at reveal" }];
      const bad = optionProblem(e.line.option, root, champions);
      if (bad) return [{ field: at("line.option"), reason: bad }];
      if (typeof e.line.line !== "string") return [{ field: at("line.line"), reason: `must be a string, got ${JSON.stringify(e.line.line)}` }];
    }
  }
  return [];
}

// ---- applying one position ----------------------------------------------------------------------

// Why this position of an export is malformed (nothing is read from it), or null.
function exportProblem(pos) {
  if (!isPlain(pos)) return "the position's export is not an object";
  if (!Number.isInteger(pos.base) || pos.base < 0) return "base must be a non-negative integer";
  for (const mode of MODE_NAMES) {
    if (!has(pos, mode)) continue;
    const m = pos[mode];
    const allowed = mode === "blind" ? ["started", "finished", "would_pick", "labels"] : ["started", "finished", "would_pick", "labels", "line"];
    if (!isPlain(m)) return `${mode} is not an object`;
    const stray = Object.keys(m).find((k) => !allowed.includes(k));
    if (stray) return `${mode}.${stray} is not part of the export (a blind entry never carries a line)`;
    if (!isUtcTimestamp(m.started) || !isUtcTimestamp(m.finished)) return `${mode}.started and ${mode}.finished must be ISO-8601 UTC times`;
    if (!isPlain(m.labels)) return `${mode}.labels must be an object`;
    if (has(m, "line") && !isPlain(m.line)) return `${mode}.line must be an object`;
  }
  if (has(pos, "scored") && pos.revealed !== true) return "a scored block without revealed: true";
  if (pos.revealed === true && !has(pos, "scored")) return "revealed: true without a scored block";
  if (has(pos, "note") && typeof pos.note !== "string") return "note must be a string";
  return null;
}

function diffLabels(exported, fold) {
  const out = {};
  for (const option of Object.keys(exported).sort(byCode)) {
    if (fold[option] !== exported[option]) out[option] = exported[option];
  }
  return out;
}

function describeEntry(entry) {
  const parts = [`${Object.keys(entry.labels).length} label${Object.keys(entry.labels).length === 1 ? "" : "s"}`];
  if (has(entry, "would_pick")) parts.push("own pick");
  if (entry.line) parts.push("line verdict");
  if (has(entry, "note")) parts.push("note");
  return `${entry.mode} (${parts.join(", ")})`;
}

// `fixture` is the parsed fixture, `pos` one position of the export, `ctx`:
//   { run, rev }                     the export's stamp (design 3b)
//   data: { fm_version, positions_patch }   the export's `data`, never the current files
//   draftScored: boolean             the fixtures directory held a `scored` entry on any card of this draft
//                                    when the apply began (blind means never revealed, per draft)
//   runMark: number                  the highest rev of this run applied on any position of the directory (optional)
//   champions: Set<string>           known champion ids (optional: skips the unknown-champion check)
// Pure: returns `{ fixture, outcome }`; `fixture` is the input itself unless something was written.
// outcome.kind: "replay" | "older" | "stale" | "refused" | "applied"; `applied` carries `entries` (the new
// entries, possibly none) and `message`.
function applyPosition(fixture, pos, ctx) {
  const { run, rev } = ctx;
  const unchanged = (kind, message) => ({ fixture, outcome: { kind, message, entries: [] } });
  const problem = exportProblem(pos);
  if (problem) return unchanged("refused", `${fixture.id}: refused: malformed export: ${problem}`);
  const entries = Array.isArray(fixture.verdicts) ? fixture.verdicts : [];

  // 1. Replay, or an older export.
  // Deviation from design 3b rule 1 (per position), ruled by the user: `rev` is a page-wide counter and every export
  // is the whole page, so the mark is run-wide (`ctx.runMark`, the highest rev of this run on ANY position in the
  // directory) as well as this position's own. A change made and reverted leaves a position unstamped, and a
  // per-position check would let an intermediate export overwrite the newer judgement.
  const mine = entries.filter((e) => isPlain(e) && isPlain(e.from) && e.from.run === run && Number.isInteger(e.from.rev));
  const ownTop = mine.length > 0 ? Math.max(...mine.map((e) => e.from.rev)) : -1;
  const top = Math.max(ownTop, Number.isInteger(ctx.runMark) ? ctx.runMark : -1);
  if (top >= 0) {
    if (top > rev) return unchanged("older", `${fixture.id}: older export (rev ${rev}); this run already applied rev ${top}: nothing written`);
    if (top === rev) return unchanged("replay", `${fixture.id}: replay (rev ${rev} already applied): nothing written`);
  }

  // 2. Stale: entries beyond the page's base from a different run.
  if (entries.length < pos.base) {
    return unchanged("stale", `${fixture.id}: stale: the page saw ${pos.base} entries and the fixture holds ${entries.length}; this export is from another corpus: refused, regenerate the page (tier-b:review)`);
  }
  const foreign = entries.slice(pos.base).filter((e) => !(isPlain(e) && isPlain(e.from) && e.from.run === run));
  if (foreign.length > 0) {
    const runs = [...new Set(foreign.map((e) => (isPlain(e) && isPlain(e.from) ? e.from.run : "unknown")))];
    return unchanged("stale", `${fixture.id}: stale: ${foreign.length} entr${foreign.length === 1 ? "y" : "ies"} from run ${runs.join(", ")} came after this page was built: refused, regenerate the page (tier-b:review)`);
  }

  // 3. Write what differs.
  const refuse = (why) => unchanged("refused", `${fixture.id}: refused: ${why}`);
  const stamp = (mode, span, body) => ({
    started: span.started,
    finished: span.finished,
    mode,
    from: { run, rev },
    fm_version: ctx.data.fm_version,
    positions_patch: ctx.data.positions_patch,
    ...body,
  });
  const written = [];
  let fold = foldVerdicts(entries);

  if (pos.blind) {
    const labels = diffLabels(pos.blind.labels, fold.blind);
    const pickChanged = has(pos.blind, "would_pick") && (fold.blindPick === undefined || !samePick(pos.blind.would_pick, fold.blindPick));
    if (Object.keys(labels).length > 0 || pickChanged) {
      if (ctx.draftScored || fold.revealed) {
        return refuse(`a blind entry for ${draftOf(fixture.id)}, a draft that already holds a scored entry: blind means never revealed; regenerate the page (tier-b:review)`);
      }
      const body = {};
      if (pickChanged) body.would_pick = pos.blind.would_pick;
      body.labels = labels;
      written.push(stamp("blind", pos.blind, body));
      fold = foldVerdicts([...entries, ...written]);
    }
  }

  if (pos.scored) {
    const labels = diffLabels(pos.scored.labels, fold.current);
    const pickChanged = has(pos.scored, "would_pick") && (fold.currentPick === undefined || !samePick(pos.scored.would_pick, fold.currentPick));
    const line = pos.scored.line;
    const lineChanged = isPlain(line) && !fold.lines.some((l) => l.option === line.option && l.line === line.line && l.ok === line.ok);
    // A reveal that changed nothing writes one empty scored entry, if the fixture holds none yet.
    const revealRecord = pos.revealed === true && !fold.revealed;
    if (Object.keys(labels).length > 0 || pickChanged || lineChanged || revealRecord) {
      const body = {};
      if (pickChanged) body.would_pick = pos.scored.would_pick;
      body.labels = labels;
      if (lineChanged) body.line = { option: line.option, line: line.line, ok: line.ok };
      written.push(stamp("scored", pos.scored, body));
    }
  }

  // The note: written when it differs from the fixture's last note (file order), on the entry written; or alone.
  if (typeof pos.note === "string" && pos.note !== "") {
    const lastNote = [...entries].reverse().find((e) => isPlain(e) && typeof e.note === "string");
    if (!lastNote || lastNote.note !== pos.note) {
      if (written.length > 0) {
        written[written.length - 1].note = pos.note;
      } else {
        const mode = pos.scored || fold.revealed ? "scored" : "blind";
        if (!pos[mode]) return refuse(`a note on a position with no ${mode} block to date it`);
        if (mode === "blind" && ctx.draftScored) {
          return refuse(`a blind entry for ${draftOf(fixture.id)}, a draft that already holds a scored entry: blind means never revealed; regenerate the page (tier-b:review)`);
        }
        written.push(stamp(mode, pos[mode], { labels: {}, note: pos.note }));
      }
    }
  }

  if (written.length === 0) return unchanged("applied", `${fixture.id}: nothing differs: nothing written`);

  const verdicts = [...entries, ...written];
  const errors = validateVerdicts({ ...fixture, verdicts }, verdicts, ctx.champions);
  if (errors.length > 0) {
    return refuse(`the loader would refuse the result (${errors[0].field}: ${errors[0].reason}); nothing written`);
  }
  // `verdicts` goes immediately before `review`; every other key keeps its place.
  const next = {};
  let placed = false;
  for (const [key, value] of Object.entries(fixture)) {
    if (key === "verdicts") {
      next.verdicts = verdicts;
      placed = true;
    } else if (key === "review" && !placed) {
      next.verdicts = verdicts;
      next.review = value;
      placed = true;
    } else {
      next[key] = value;
    }
  }
  if (!placed) next.verdicts = verdicts;
  return {
    fixture: next,
    outcome: { kind: "applied", entries: written, message: `${fixture.id}: wrote ${written.map(describeEntry).join(" + ")}` },
  };
}

// ---- the file: new entries spliced in as text, so every other byte stays as it was --------------------

function entryText(entry) {
  return JSON.stringify(entry, null, 2).split("\n").map((l) => "    " + l).join("\n");
}

// The fixture's text with `entries` appended to its `verdicts` array (created before `review` when absent).
// Returns null when the text is not laid out as 2-space-indented JSON this can edit.
function spliceVerdicts(text, entries) {
  const added = entries.map(entryText).join(",\n");
  const existing = /^  "verdicts": (\[\]|\[\n[\s\S]*?\n  \])(,?)$/m.exec(text);
  if (existing) {
    const [whole, array, comma] = existing;
    const replaced = array === "[]" ? `[\n${added}\n  ]` : `${array.slice(0, -"\n  ]".length)},\n${added}\n  ]`;
    return text.slice(0, existing.index) + `  "verdicts": ${replaced}${comma}` + text.slice(existing.index + whole.length);
  }
  const block = `  "verdicts": [\n${added}\n  ],\n`;
  const review = /^  "review":/m.exec(text);
  if (review) return text.slice(0, review.index) + block + text.slice(review.index);
  const end = /\n}\s*$/.exec(text);
  if (end && /\S\s*$/.test(text.slice(0, end.index))) {
    return text.slice(0, end.index) + `,\n${block.slice(0, -2)}` + text.slice(end.index);
  }
  return null;
}

// Why the spliced text is not the intended fixture, or null. It must read back equal to `intended`, hold exactly
// one top-level `verdicts` key (JSON.parse would hide a duplicate, which the loader refuses), and keep the key
// order of `intended`: the original order with `verdicts` immediately before `review`, or last when there is no
// `review` (deepStrictEqual ignores order, so it is compared separately). A file laid out any other way
// (hand-written `[ ]`, 4-space or tab indentation) fails here and is refused whole, nothing written.
function spliceProblem(text, intended) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return "the edited text is not JSON";
  }
  try {
    assert.deepStrictEqual(parsed, intended);
  } catch (e) {
    return "the edited text does not read back as the intended fixture";
  }
  if ((text.match(/^ {2}"verdicts":/gm) || []).length !== 1) return "the edited text does not hold exactly one top-level verdicts key";
  if (JSON.stringify(Object.keys(parsed)) !== JSON.stringify(Object.keys(intended))) {
    return "the edited text puts verdicts somewhere other than immediately before review";
  }
  return null;
}

// ---- the whole export ---------------------------------------------------------------------------

function checkExport(exp) {
  if (!isPlain(exp)) throw new Error("the export is not a JSON object");
  if (exp.schema !== SCHEMA) throw new Error(`unsupported export schema ${JSON.stringify(exp.schema)}; this reads ${SCHEMA}`);
  if (!isUtcTimestamp(exp.run)) throw new Error(`the export's run ${JSON.stringify(exp.run)} is not a run id (an ISO-8601 UTC time)`);
  if (!Number.isInteger(exp.rev) || exp.rev < 0) throw new Error("the export's rev must be a non-negative integer");
  if (!isPlain(exp.data)) throw new Error("the export carries no data stamps (fm_version, positions_patch): it was made by an older page");
  for (const key of ["fm_version", "positions_patch"]) {
    if (typeof exp.data[key] !== "string" || exp.data[key] === "") throw new Error(`the export's data.${key} is missing`);
  }
  if (!isPlain(exp.positions)) throw new Error("the export has no positions object");
}

function loadChampionIds(repo = REPO) {
  const meta = JSON.parse(fs.readFileSync(path.join(repo, "data/compiled/champion-meta.json"), "utf8"));
  return new Set(Object.keys(meta.champions));
}

function loadFixtures(dir) {
  const byId = new Map();
  const problems = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, "utf8");
    try {
      const fixture = JSON.parse(text);
      if (isPlain(fixture) && typeof fixture.id === "string") byId.set(fixture.id, { file, text, fixture });
      else problems.push(`${name}: not a fixture (no id); skipped`);
    } catch (e) {
      problems.push(`${name}: not JSON (${e.message}); skipped`);
    }
  }
  return { byId, problems };
}

// Applies an export to the fixtures in `dir`. Every position is decided against the files as they were when the
// apply began; files are written (only the ones that changed) after every decision is made, unless
// `write: false`. Returns `{ results: [{ id, outcome }], written: [file], problems }`.
function applyExport(exp, dir, { write = true, champions = loadChampionIds() } = {}) {
  checkExport(exp);
  const { byId, problems } = loadFixtures(dir);
  const scoredDrafts = new Set();
  for (const { fixture } of byId.values()) {
    if (Array.isArray(fixture.verdicts) && fixture.verdicts.some((e) => isPlain(e) && e.mode === "scored")) {
      scoredDrafts.add(draftOf(fixture.id));
    }
  }
  const runMark = Math.max(-1, ...[...byId.values()].flatMap(({ fixture }) => (Array.isArray(fixture.verdicts) ? fixture.verdicts : [])).filter((e) => isPlain(e) && isPlain(e.from) && e.from.run === exp.run && Number.isInteger(e.from.rev)).map((e) => e.from.rev));
  const results = [];
  const edits = [];
  for (const id of Object.keys(exp.positions).sort(byCode)) {
    const held = byId.get(id);
    if (!held) {
      results.push({ id, outcome: { kind: "refused", entries: [], message: `${id}: refused: no such position in ${dir}` } });
      continue;
    }
    const ctx = { run: exp.run, rev: exp.rev, data: exp.data, draftScored: scoredDrafts.has(draftOf(id)), runMark, champions };
    const { fixture, outcome } = applyPosition(held.fixture, exp.positions[id], ctx);
    let final = outcome;
    if (outcome.kind === "applied" && outcome.entries.length > 0) {
      const text = spliceVerdicts(held.text, outcome.entries);
      const reason = text === null ? "the file is not laid out as 2-space-indented JSON this can edit" : spliceProblem(text, fixture);
      if (reason) final = { kind: "refused", entries: [], message: `${id}: refused: ${reason}; nothing written` };
      else edits.push({ file: held.file, text });
    }
    results.push({ id, outcome: final });
  }
  if (write) for (const { file, text } of edits) fs.writeFileSync(file, text);
  return { results, written: edits.map((e) => e.file), problems };
}

// ---- the command --------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { file: null, fixtures: null, review: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-review") args.review = false;
    else if (a === "--fixtures") {
      args.fixtures = argv[++i];
      if (!args.fixtures) throw new Error("--fixtures needs a directory");
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else if (args.file === null) args.file = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (args.file === null) throw new Error("usage: apply-verdicts.mjs <verdicts.json> [--fixtures <dir>] [--no-review]");
  return args;
}

async function main(argv) {
  let args;
  let exp;
  try {
    args = parseArgs(argv);
    // A byte-order mark (Notepad's "UTF-8 with BOM") is not part of the JSON.
    exp = JSON.parse(fs.readFileSync(args.file, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    console.error(args && args.file ? `${args.file}: ${e.message} (the export must be the page's JSON, UTF-8, as copied or downloaded)` : e.message);
    return 2;
  }
  const dir = args.fixtures ? path.resolve(args.fixtures) : DEFAULT_FIXTURES;
  let applied;
  try {
    applied = applyExport(exp, dir);
  } catch (e) {
    console.error(`apply-verdicts: ${e.message}`);
    return 2;
  }
  for (const p of applied.problems) console.warn(`warning: ${p}`);
  console.log(`export ${exp.run} rev ${exp.rev} -> ${dir}`);
  for (const { outcome } of applied.results) console.log(outcome.message);
  const refused = applied.results.filter((r) => r.outcome.kind === "refused" || r.outcome.kind === "stale");
  const wrote = applied.written.length;
  console.log(`${wrote} file${wrote === 1 ? "" : "s"} written, ${refused.length} position${refused.length === 1 ? "" : "s"} refused`);
  let code = refused.length > 0 ? 1 : 0;
  if (args.review) {
    const { runReview } = await import("./review.mjs");
    try {
      runReview({ fixtures: args.fixtures ? dir : null });
    } catch (e) {
      console.error(`review: ${e.message}`);
      code = code || 3;
    }
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}

export { applyExport, applyPosition, draftOf, foldVerdicts, isUtcTimestamp, loadChampionIds, rootOf, samePick, spliceProblem, spliceVerdicts, validateVerdicts };
