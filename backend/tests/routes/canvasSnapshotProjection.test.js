import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import * as acorn from "acorn";

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
  CanvasPoolPlacement,
} = require("../../models/Canvas");
const Pool = require("../../models/Pool");

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({
    toJSON: () => ({ id: "c1", name: "C", cardLayout: "wide" }),
  });
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([]);
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

  // Same erasure rule applies to pools: a missing `pools` key wipes every
  // pool card on every reconciling client.
  it("always carries a pools array, even when there are none", async () => {
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([]);
    const payload = await buildCanvasSnapshot("c1");
    expect(payload).toHaveProperty("pools");
    expect(payload.pools).toEqual([]);
  });

  it("returns pool placements as plain JSON with the nested Pool payload", async () => {
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([
      {
        toJSON: () => ({
          id: "pp1",
          canvas_id: "c1",
          pool_id: "p1",
          positionX: 50,
          positionY: 50,
          Pool: { id: "p1", name: "Scrims", champions: {} },
        }),
      },
    ]);
    const payload = await buildCanvasSnapshot("c1");
    expect(payload.pools).toEqual([
      {
        id: "pp1",
        canvas_id: "c1",
        pool_id: "p1",
        positionX: 50,
        positionY: 50,
        Pool: { id: "p1", name: "Scrims", champions: {} },
      },
    ]);
  });

  it("scopes the pool placement query to the canvas with nested Pool include", async () => {
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
    const findAll = vi
      .spyOn(CanvasPoolPlacement, "findAll")
      .mockResolvedValue([]);
    await buildCanvasSnapshot("c1");
    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { canvas_id: "c1" },
        include: [{ model: Pool }],
      }),
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
// Round 3 fix (task-5 review, finding on the round-1/2 fix diff): round 1's
// variable trace was a flat, FILE-scoped regex (`BUILDER_ASSIGNMENT` matched
// anywhere in the file). Two holes followed: (a) any function's `const
// snapshot = await buildCanvasSnapshot(...)` put "snapshot" in the same
// file-wide Set an UNRELATED function's emit could then ride on by name
// coincidence, with no proof that THIS function's own "snapshot" traced to
// the builder at all; (b) round 2's legitimate hoist at the group PUT route
// — `const snapshot = isDimensionOnlyResize ? null : await
// buildCanvasSnapshot(canvasId);` — is a ternary, which the flat regex never
// matched in the first place, so that site passed the guard purely by
// borrowing the name "snapshot" from the other nine call sites in the same
// file, not because its own declaration was ever checked.
//
// This version parses each candidate file with acorn and traces PROVENANCE
// instead of matching text: for a bare-identifier payload, it finds the
// call's own enclosing function, walks that function's body ONLY (never
// crossing into a nested function, so same-named variables in a sibling
// handler can't leak in), and takes the LAST assignment (declaration or
// plain reassignment) to that name before the emit. That assignment's
// right-hand side must itself be an `await buildCanvasSnapshot(...)` call,
// or a ternary where every branch is either that call or a null/undefined
// sentinel (the shape the group PUT route's conditional-snapshot hoist
// needs, since only one of its two emit branches wants the read). Anything
// else — a reassignment to a hand-built or partial object, a same-named
// variable from a different function, a destructured/spread copy, an
// inline object literal — fails. Every violation across every candidate
// file is still collected before one final assertion.

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

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

function isAstNode(value) {
  return (
    value !== null && typeof value === "object" && typeof value.type === "string"
  );
}

// Generic ESTree walk: visits every node reachable from `node` via any of
// its own enumerable properties, without needing a per-node-type schema.
function walkChildren(node, visit) {
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) visit(item);
      }
    } else if (isAstNode(value)) {
      visit(value);
    }
  }
}

function isEmitToRoomCallee(callee) {
  if (callee.type === "Identifier") return callee.name === "emitToRoom";
  if (callee.type === "MemberExpression" && !callee.computed) {
    return callee.property.type === "Identifier" && callee.property.name === "emitToRoom";
  }
  return false;
}

// Returns [{ callNode, enclosingFunction }] for every emitToRoom(...) call
// in the program, tracking the innermost enclosing function (or null, at
// module top level) as it descends.
function collectEmitToRoomCalls(program) {
  const calls = [];
  const functionStack = [];

  function visit(node) {
    const isFn = FUNCTION_TYPES.has(node.type);
    if (isFn) functionStack.push(node);

    if (node.type === "CallExpression" && isEmitToRoomCallee(node.callee)) {
      calls.push({
        callNode: node,
        enclosingFunction: functionStack[functionStack.length - 1] ?? null,
      });
    }

    walkChildren(node, visit);
    if (isFn) functionStack.pop();
  }

  visit(program);
  return calls;
}

// True if `node` is `await buildCanvasSnapshot(...)`.
function isBuilderCall(node) {
  return (
    isAstNode(node) &&
    node.type === "AwaitExpression" &&
    isAstNode(node.argument) &&
    node.argument.type === "CallExpression" &&
    node.argument.callee.type === "Identifier" &&
    node.argument.callee.name === "buildCanvasSnapshot"
  );
}

function isNullishSentinel(node) {
  return (
    isAstNode(node) &&
    ((node.type === "Literal" && node.value === null) ||
      (node.type === "Identifier" && node.name === "undefined"))
  );
}

// A payload expression is acceptable if it's the builder call directly, or a
// ternary where every branch is the builder call or a null/undefined
// sentinel (the group-PUT route's conditional-snapshot shape) — with at
// least one branch actually being the call, so `cond ? null : undefined`
// can't vacuously pass.
function isAcceptableSnapshotExpression(node) {
  if (isBuilderCall(node)) return true;
  if (isAstNode(node) && node.type === "ConditionalExpression") {
    const branches = [node.consequent, node.alternate];
    return (
      branches.every((b) => isBuilderCall(b) || isNullishSentinel(b)) &&
      branches.some(isBuilderCall)
    );
  }
  return false;
}

// Finds the textually LAST assignment (declaration or plain reassignment)
// to `name` inside `scopeRoot`'s own body, before `beforePos`, WITHOUT
// crossing into any nested function — so a same-named variable in a sibling
// handler is invisible here, and only this call's own enclosing scope can
// satisfy it.
function findLastAssignmentInScope(scopeRoot, name, beforePos) {
  let last = null;
  const record = (start, expr) => {
    if (start < beforePos && (!last || start > last.start)) {
      last = { start, expr };
    }
  };

  function visit(node, isRoot) {
    if (!isRoot && FUNCTION_TYPES.has(node.type)) return; // nested scope, stop

    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === name &&
      node.init
    ) {
      record(node.start, node.init);
    }
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "Identifier" &&
      node.left.name === name
    ) {
      record(node.start, node.right);
    }

    walkChildren(node, (child) => visit(child, false));
  }

  visit(scopeRoot, true);
  return last ? last.expr : null;
}

// Returns violation strings for one file's source, or [] if every
// canvasUpdate emit in it traces to buildCanvasSnapshot.
function findCanvasUpdateViolations(source, label) {
  const violations = [];
  let program;
  try {
    program = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script" });
  } catch (err) {
    violations.push(`${label}: failed to parse for the guard (${err.message})`);
    return violations;
  }

  for (const { callNode, enclosingFunction } of collectEmitToRoomCalls(program)) {
    const args = callNode.arguments;
    const eventArg = args[1];
    if (!eventArg || eventArg.type !== "Literal" || eventArg.value !== "canvasUpdate") {
      continue; // not a canvasUpdate emit
    }

    const payload = args[2];
    if (!payload) {
      violations.push(`${label}: canvasUpdate emit is missing a payload argument`);
      continue;
    }

    if (isAcceptableSnapshotExpression(payload)) continue;

    if (payload.type === "Identifier") {
      const scopeRoot = enclosingFunction ?? program;
      const traced = findLastAssignmentInScope(scopeRoot, payload.name, payload.start);
      if (traced && isAcceptableSnapshotExpression(traced)) continue;
    }

    violations.push(
      `${label}: canvasUpdate payload "${source.slice(payload.start, payload.end)}" does not trace to buildCanvasSnapshot`,
    );
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
