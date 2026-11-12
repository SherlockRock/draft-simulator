import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sqlKit = require("../../utils/placeholderTeamNameMigration");
const { PLACEHOLDER_NAMES, isPlaceholderTeamName } = require("../../utils/teamPlaceholders");

const sides = [
  { key: "blueTeamName", other: "redTeamName" },
  { key: "redTeamName", other: "blueTeamName" },
];

// Expected SQL, written out independently of the helper's builders so a wrong
// edit to the helper cannot also change the expectation. Both sides are
// normalised for whitespace only.
const norm = (sql) =>
  sql.replace(/[ \t\r\n]+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
const WS = sqlKit.WHITESPACE_CLASS;
const trimmed = (x) => `regexp_replace(${x}, '^[${WS}]+|[${WS}]+$', '', 'g')`;
const storable = (x) =>
  `(${trimmed(x)} <> '' AND lower(${trimmed(x)}) NOT IN ('team 1', 'team 2'))`;
const metaText = (k) => `g."metadata" ->> '${k}'`;
const metaStorable = (k) =>
  `(jsonb_typeof(g."metadata" -> '${k}') = 'string' AND ${storable(metaText(k))})`;
const unstorable = (k) =>
  `(jsonb_exists(g."metadata", '${k}') AND NOT ${metaStorable(k)})`;

const candidateGroups = (k) =>
  `FROM "CanvasGroups" g WHERE g."type" = 'series' AND g."versus_draft_id" IS NOT NULL AND ${metaStorable(k)} GROUP BY g."versus_draft_id"`;
const candidates = (k) =>
  `SELECT g."versus_draft_id" AS versus_draft_id, min(${metaText(k)}) AS name ${candidateGroups(k)} HAVING count(DISTINCT ${metaText(k)}) = 1 AND max(char_length(${metaText(k)})) <= 255`;
const draftNeedsCopy = (k) =>
  `vd."origin" = 'manual' AND NOT ${storable(`COALESCE(vd."${k}", '')`)}`;

describe("predicates match the JS rule", () => {
  it("lists exactly T0's placeholder names", () => {
    expect([...sqlKit.PLACEHOLDER_NAMES].sort()).toEqual(["team 1", "team 2"]);
    expect(sqlKit.PLACEHOLDER_NAMES).toBe(PLACEHOLDER_NAMES);
    for (const name of PLACEHOLDER_NAMES) {
      expect(isPlaceholderTeamName(name)).toBe(true);
      expect(sqlKit.stripCountSql()).toContain(`'${name}'`);
    }
  });

  it("trims exactly the characters String.prototype.trim strips", () => {
    const edge = new RegExp(
      `^[${sqlKit.WHITESPACE_CLASS}]+|[${sqlKit.WHITESPACE_CLASS}]+$`,
      "g",
    );
    for (let code = 0; code <= 0xffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const ch = String.fromCharCode(code);
      const jsStrips = `a${ch}`.trim() === "a";
      expect(`a${ch}`.replace(edge, "") === "a", `U+${code.toString(16)}`).toBe(jsStrips);
    }
  });

  it("puts the whitespace class in the SQL, not btrim or \\s", () => {
    const sql = sqlKit.stripCountSql();
    expect(sql).toContain("regexp_replace(");
    expect(sql).toContain(sqlKit.WHITESPACE_CLASS);
    expect(sql).not.toMatch(/btrim|\\s/);
  });
});

describe.each(sides)("copy, $key", ({ key, other }) => {
  it("count: joins group.versus_draft_id to draft.id, manual drafts, column not storable", () => {
    expect(norm(sqlKit.copyCountSql(key))).toBe(
      norm(
        `SELECT count(*) AS count FROM "VersusDrafts" vd JOIN (${candidates(key)}) c ON c.versus_draft_id = vd."id" WHERE ${draftNeedsCopy(key)}`,
      ),
    );
  });

  it("update: sets the same-side column from the same-side name, same join and WHERE", () => {
    expect(norm(sqlKit.copyUpdateSql(key))).toBe(
      norm(
        `UPDATE "VersusDrafts" vd SET "${key}" = c.name FROM (${candidates(key)}) c WHERE c.versus_draft_id = vd."id" AND ${draftNeedsCopy(key)}`,
      ),
    );
  });

  it("never mentions the other side", () => {
    for (const sql of [
      sqlKit.copyCountSql(key),
      sqlKit.copyUpdateSql(key),
      sqlKit.copySkippedCountSql(key),
    ]) {
      expect(sql).not.toContain(other);
    }
  });

  it("skipped count: manual drafts needing a copy whose groups disagree or are over 255", () => {
    expect(norm(sqlKit.copySkippedCountSql(key))).toBe(
      norm(
        `SELECT count(*) AS count FROM "VersusDrafts" vd JOIN (SELECT g."versus_draft_id" AS versus_draft_id ${candidateGroups(key)} HAVING count(DISTINCT ${metaText(key)}) > 1 OR max(char_length(${metaText(key)})) > 255) c ON c.versus_draft_id = vd."id" WHERE ${draftNeedsCopy(key)}`,
      ),
    );
  });

  it("candidate predicate carries the trim and lower() on the metadata side", () => {
    const sql = norm(sqlKit.copyUpdateSql(key));
    expect(sql).toContain(
      norm(
        `AND (jsonb_typeof(g."metadata" -> '${key}') = 'string' AND ${storable(metaText(key))}) GROUP BY`,
      ),
    );
    expect(sql).toContain(
      norm(`lower(${trimmed(metaText(key))}) NOT IN ('team 1', 'team 2')`),
    );
  });

  it("the shared-draft skip is exactly one distinct name per draft", () => {
    const sql = norm(sqlKit.copyUpdateSql(key));
    expect(sql).toContain(
      `GROUP BY g."versus_draft_id" HAVING count(DISTINCT ${metaText(key)}) = 1 AND max(char_length(${metaText(key)})) <= 255)`,
    );
  });
});

describe("copy scope", () => {
  it("is series groups for the candidates and manual drafts for the write, never custom or live", () => {
    for (const k of ["blueTeamName", "redTeamName"]) {
      for (const sql of [sqlKit.copyCountSql(k), sqlKit.copyUpdateSql(k)]) {
        const s = norm(sql);
        expect(s).toContain(`WHERE g."type" = 'series' AND`);
        expect(s).toContain(`vd."origin" = 'manual' AND NOT`);
        expect(s).not.toContain("custom");
        expect(s).not.toContain("'live'");
      }
    }
  });
});

describe("strip", () => {
  const [blue, red] = ["blueTeamName", "redTeamName"];
  const needsWrite = `g."type" = 'series' AND jsonb_typeof(g."metadata") = 'object' AND (${unstorable(blue)} OR ${unstorable(red)})`;
  const afterBlue = `CASE WHEN ${unstorable(blue)} THEN g."metadata" - '${blue}' ELSE g."metadata" END`;

  it("update: each CASE branch removes the key of the side it tests", () => {
    expect(norm(sqlKit.stripUpdateSql())).toBe(
      norm(
        `UPDATE "CanvasGroups" g SET "metadata" = CASE WHEN ${unstorable(red)} THEN (${afterBlue}) - '${red}' ELSE ${afterBlue} END WHERE ${needsWrite}`,
      ),
    );
  });

  it("count: same WHERE as the update", () => {
    expect(norm(sqlKit.stripCountSql())).toBe(
      norm(`SELECT count(*) AS count FROM "CanvasGroups" g WHERE ${needsWrite}`),
    );
  });

  it("is series-only and removes keys by the minus operator, never null", () => {
    const sql = norm(sqlKit.stripUpdateSql());
    expect(sql).toContain(`WHERE g."type" = 'series' AND`);
    expect(sql).not.toContain("custom");
    expect(sql).not.toMatch(/jsonb_set|\|\||null|VersusDrafts/i);
  });

  it("has no ? operator outside quoted literals", () => {
    for (const sql of [sqlKit.stripUpdateSql(), sqlKit.stripCountSql(), sqlKit.copyUpdateSql(blue)]) {
      expect(sql.replace(/'[^']*'/g, "''")).not.toContain("?");
    }
  });
});

describe("dry-run counts", () => {
  const [blue, red] = ["blueTeamName", "redTeamName"];
  const both = (build) => `(${build(blue)} OR ${build(red)})`;
  const present = (k) => `jsonb_exists(g."metadata", '${k}')`;
  const isString = (k) => `jsonb_typeof(g."metadata" -> '${k}') = 'string'`;
  const placeholder = (k) =>
    `(${isString(k)} AND lower(${trimmed(metaText(k))}) IN ('team 1', 'team 2'))`;
  const blank = (k) => `(${isString(k)} AND ${trimmed(metaText(k))} = '')`;
  const nonString = (k) => `(${present(k)} AND NOT ${isString(k)})`;
  const stripWhere = `g."type" = 'series' AND jsonb_typeof(g."metadata") = 'object' AND (${unstorable(blue)} OR ${unstorable(red)})`;

  it("splits the strip into total, placeholder, blank and non-string", () => {
    expect(norm(sqlKit.stripBreakdownSql())).toBe(
      norm(
        `SELECT count(*) AS total, count(*) FILTER (WHERE ${both(placeholder)}) AS placeholder, count(*) FILTER (WHERE ${both(blank)}) AS blank, count(*) FILTER (WHERE ${both(nonString)}) AS non_string FROM "CanvasGroups" g WHERE ${stripWhere}`,
      ),
    );
  });

  it("counts custom groups holding an unstorable name, nothing else", () => {
    expect(norm(sqlKit.customGroupsHoldingCountSql())).toBe(
      norm(
        `SELECT count(*) AS count FROM "CanvasGroups" g WHERE g."type" = 'custom' AND jsonb_typeof(g."metadata") = 'object' AND (${unstorable(blue)} OR ${unstorable(red)})`,
      ),
    );
  });

  it("every dry-run query is read-only", () => {
    const all = [
      sqlKit.copyCountSql(blue), sqlKit.copyCountSql(red),
      sqlKit.copySkippedCountSql(blue), sqlKit.copySkippedCountSql(red),
      sqlKit.stripCountSql(), sqlKit.stripBreakdownSql(),
      sqlKit.customGroupsHoldingCountSql(),
    ];
    for (const sql of all) {
      expect(norm(sql)).toMatch(/^SELECT /);
      expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/);
    }
  });

  it("rejects an unknown side", () => {
    expect(() => sqlKit.copyUpdateSql("greenTeamName")).toThrow(/Unknown team side/);
  });
});
