import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const {
  buildCanvasSnapshot,
} = require("../../routes/canvasProjections");
const {
  Canvas,
  CanvasDraft,
  CanvasGroup,
  CanvasConnection,
  CanvasAnnotation,
} = require("../../models/Canvas");

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({
    toJSON: () => ({ id: "c1", name: "C", cardLayout: "wide" }),
  });
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
});

describe("buildCanvasSnapshot", () => {
  // The failure mode is SILENT client-side erasure: the canvasUpdate handler
  // reconciles whatever arrives, so a missing key wipes every annotation on
  // every remote client.
  it("always carries an annotations array, even when there are none", async () => {
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
    const payload = await buildCanvasSnapshot("c1");
    expect(payload).toHaveProperty("annotations");
    expect(payload.annotations).toEqual([]);
  });

  it("returns annotations as plain JSON", async () => {
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([
      { toJSON: () => ({ id: "a1", text: "why we lost" }) },
    ]);
    const payload = await buildCanvasSnapshot("c1");
    expect(payload.annotations).toEqual([{ id: "a1", text: "why we lost" }]);
  });

  it("scopes the annotation query to the canvas", async () => {
    const findAll = vi
      .spyOn(CanvasAnnotation, "findAll")
      .mockResolvedValue([]);
    await buildCanvasSnapshot("c1");
    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { canvas_id: "c1" } }),
    );
  });
});

// Static guard: this is what stops a fourteenth hand-built payload appearing.
//
// Round 1 fix (task-5 review, finding 2): the original guard hardcoded a
// three-file list and regex-matched only the `emitToRoom(id, "canvasUpdate",
// {` literal shape. That missed: a payload assembled into a variable first
// (prettier does this once a literal gets long), a producer outside the
// hardcoded list (the same undercount this task's own brief committed
// twice), no positive proof the payload actually traces to
// buildCanvasSnapshot (a stale/partial variable passed silently), single
// quotes, and an `expect` inside the loop that aborts on the first offender
// so later files never get reported.
//
// This version (a) discovers every backend .js file that mentions
// "canvasUpdate" instead of trusting a hand-maintained list, (b) parses each
// `emitToRoom(...)` call's arguments with a bracket/string-aware splitter so
// multi-line calls and nested braces don't break a regex, (c) requires the
// payload argument to be traceable to buildCanvasSnapshot — either the
// inline `await buildCanvasSnapshot(...)` call, or a bare identifier that
// this same file assigned directly from `await buildCanvasSnapshot(...)`
// (the hoisted shape task-5's round-1 fix moved nine sites to, reading the
// snapshot BEFORE res.json so a DB failure can't throw
// ERR_HTTP_HEADERS_SENT out of an already-sent response) — and (d) collects
// every violation across every file before asserting once, so the failure
// message names every offender instead of just the first file scanned.

const BACKEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "tests",
  "coverage",
]);

function collectBackendJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      collectBackendJsFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Splits a balanced `(...)` argument list on top-level commas, tracking
// string/template literals and nested (), {}, [] so a comma inside an
// object literal or a nested call doesn't split early.
function splitTopLevelArgs(argsText) {
  const args = [];
  let depth = 0;
  let current = "";
  let inString = null;
  for (let i = 0; i < argsText.length; i += 1) {
    const ch = argsText[i];
    if (inString) {
      current += ch;
      if (ch === "\\") {
        i += 1;
        current += argsText[i] ?? "";
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

// Finds every `emitToRoom(...)` call in `source` and returns its parsed
// top-level argument list. Brace/string-aware so a multi-line call (the
// shape every converted site now uses) parses the same as a single-line one.
function findEmitToRoomArgLists(source) {
  const marker = "emitToRoom(";
  const results = [];
  let searchFrom = 0;
  while (true) {
    const idx = source.indexOf(marker, searchFrom);
    if (idx === -1) break;
    let i = idx + marker.length;
    let depth = 1;
    let inString = null;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (inString) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === inString) inString = null;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
      } else if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
      }
      i += 1;
    }
    results.push(splitTopLevelArgs(source.slice(idx + marker.length, i - 1)));
    searchFrom = i;
  }
  return results;
}

const CANVAS_UPDATE_LITERAL = /^["']canvasUpdate["']$/;
const INLINE_BUILDER_CALL = /^await\s+buildCanvasSnapshot\(/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const BUILDER_ASSIGNMENT = /\b(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*await\s+buildCanvasSnapshot\(/g;

// Returns violation strings for one file's source, or [] if every
// canvasUpdate emit in it traces to buildCanvasSnapshot.
function findCanvasUpdateViolations(source, label) {
  const violations = [];
  const snapshotVars = new Set(
    [...source.matchAll(BUILDER_ASSIGNMENT)].map((m) => m[1]),
  );

  for (const args of findEmitToRoomArgLists(source)) {
    const event = args[1];
    if (!event || !CANVAS_UPDATE_LITERAL.test(event)) continue; // not canvasUpdate

    const payload = args[2];
    if (!payload) {
      violations.push(`${label}: canvasUpdate emit is missing a payload argument`);
      continue;
    }
    const isInlineBuilderCall = INLINE_BUILDER_CALL.test(payload);
    const isTracedVariable = IDENTIFIER.test(payload) && snapshotVars.has(payload);
    if (!isInlineBuilderCall && !isTracedVariable) {
      violations.push(
        `${label}: canvasUpdate payload "${payload}" does not trace to buildCanvasSnapshot`,
      );
    }
  }
  return violations;
}

describe("no route hand-builds a canvasUpdate payload", () => {
  it("every emitToRoom('canvasUpdate') payload traces to buildCanvasSnapshot", () => {
    const files = collectBackendJsFiles(BACKEND_ROOT).filter((file) =>
      readFileSync(file, "utf8").includes("canvasUpdate"),
    );
    // A producer with zero candidates would mean the scan itself is broken
    // (canvas.js, drafts.js, users.js are all known producers), not that the
    // codebase is clean.
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap((file) =>
      findCanvasUpdateViolations(
        readFileSync(file, "utf8"),
        path.relative(BACKEND_ROOT, file),
      ),
    );

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
