// SQL for migration 20261112120200-clear-placeholder-team-names, and the
// read-only count queries the dry-run kit runs. Pure string building: nothing
// here touches a database. Lives in utils/ (not migrations/) because
// sequelize-cli loads every .js file in migrations/ as a migration.
//
// The predicates mirror backend/utils/teamPlaceholders.js:
//   isPlaceholderTeamName(x): typeof x === "string" && trim(x).toLowerCase()
//                             is "team 1" or "team 2"
//   isStorableTeamName(x):    a string, non-blank after trim, not a placeholder
// A test checks the placeholder list against T0's and the whitespace class
// against String.prototype.trim.

const { PLACEHOLDER_NAMES } = require("./teamPlaceholders");

// Exactly the characters String.prototype.trim strips (ECMAScript WhiteSpace +
// LineTerminator), spelled out. Postgres btrim() strips spaces only and \s /
// [[:space:]] depends on the database locale, so neither would match JS.
// Postgres ARE accepts \t \n \v \f \r and \uXXXX inside a bracket expression;
// the string is read literally (standard_conforming_strings is on).
const WHITESPACE_CLASS = String.raw`\t\n\v\f\r    -     　﻿`;

// One entry per side: the metadata key and the VersusDrafts column share a name.
const SIDES = [
  { key: "blueTeamName", column: "blueTeamName" },
  { key: "redTeamName", column: "redTeamName" },
];

const PLACEHOLDER_LIST = [...PLACEHOLDER_NAMES]
  .sort()
  .map((name) => `'${name}'`)
  .join(", ");

// A VersusDrafts column is only ever written as 255-char STRING.
const MAX_NAME_LENGTH = 255;

function sideFor(side) {
  const found = SIDES.find((s) => s.key === side || s.column === side);
  if (!found) throw new Error(`Unknown team side: ${side}`);
  return found;
}

const trimmed = (expr) =>
  `regexp_replace(${expr}, '^[${WHITESPACE_CLASS}]+|[${WHITESPACE_CLASS}]+$', '', 'g')`;

// text expression -> boolean SQL
const isBlank = (expr) => `${trimmed(expr)} = ''`;
const isPlaceholder = (expr) => `lower(${trimmed(expr)}) IN (${PLACEHOLDER_LIST})`;
const isStorable = (expr) =>
  `(${trimmed(expr)} <> '' AND lower(${trimmed(expr)}) NOT IN (${PLACEHOLDER_LIST}))`;

// A VersusDrafts column that is a placeholder or blank (NOT NULL in the
// schema, COALESCE is belt and braces).
const columnNotStorable = (ref) => `NOT ${isStorable(`COALESCE(${ref}, '')`)}`;

// metadata -> key helpers. jsonb_exists(), not the `?` operator: in raw
// sequelize.query `?` is a replacement token.
const metaValue = (alias, key) => `${alias}."metadata" ->> '${key}'`;
const metaIsString = (alias, key) =>
  `jsonb_typeof(${alias}."metadata" -> '${key}') = 'string'`;
const metaKeyPresent = (alias, key) =>
  `jsonb_exists(${alias}."metadata", '${key}')`;
const metaIsObject = (alias) => `jsonb_typeof(${alias}."metadata") = 'object'`;

// Key present with a storable string: the strip keeps it.
const metaKeyStorable = (alias, key) =>
  `(${metaIsString(alias, key)} AND ${isStorable(metaValue(alias, key))})`;
// Key present and the strip would remove it (T0's withoutPlaceholderTeamNames).
const metaKeyUnstorable = (alias, key) =>
  `(${metaKeyPresent(alias, key)} AND NOT ${metaKeyStorable(alias, key)})`;
const metaKeyPlaceholder = (alias, key) =>
  `(${metaIsString(alias, key)} AND ${isPlaceholder(metaValue(alias, key))})`;
const metaKeyBlank = (alias, key) =>
  `(${metaIsString(alias, key)} AND ${isBlank(metaValue(alias, key))})`;
const metaKeyNonString = (alias, key) =>
  `(${metaKeyPresent(alias, key)} AND NOT ${metaIsString(alias, key)})`;

const anySide = (build) => `(${SIDES.map((s) => build("g", s.key)).join(" OR ")})`;

// ---- Step 1: copy (manual series only) ------------------------------------
//
// Per VersusDraft, the real names its series groups carry for one side. Groups
// sharing a VersusDraft (possible through POST /canvases/:id/import/series)
// can disagree: the draft is skipped on that side unless exactly one distinct
// name exists. A name too long for the column also skips.
function copyCandidatesSql(side) {
  const { key } = sideFor(side);
  const value = metaValue("g", key);
  return `SELECT g."versus_draft_id" AS versus_draft_id, min(${value}) AS name
      FROM "CanvasGroups" g
      WHERE g."type" = 'series'
        AND g."versus_draft_id" IS NOT NULL
        AND ${metaKeyStorable("g", key)}
      GROUP BY g."versus_draft_id"
      HAVING count(DISTINCT ${value}) = 1
        AND max(char_length(${value})) <= ${MAX_NAME_LENGTH}`;
}

function copyNeedsWrite(side) {
  const { column } = sideFor(side);
  return `vd."origin" = 'manual' AND ${columnNotStorable(`vd."${column}"`)}`;
}

function copyCountSql(side) {
  return `SELECT count(*) AS count
    FROM "VersusDrafts" vd
    JOIN (${copyCandidatesSql(side)}) c ON c.versus_draft_id = vd."id"
    WHERE ${copyNeedsWrite(side)}`;
}

function copyUpdateSql(side) {
  const { column } = sideFor(side);
  return `UPDATE "VersusDrafts" vd
    SET "${column}" = c.name
    FROM (${copyCandidatesSql(side)}) c
    WHERE c.versus_draft_id = vd."id"
      AND ${copyNeedsWrite(side)}`;
}

// Dry-run only: manual VersusDrafts needing a copy on this side that the
// migration skips (disagreeing names across groups, or a name over 255).
function copySkippedCountSql(side) {
  const { key } = sideFor(side);
  const value = metaValue("g", key);
  return `SELECT count(*) AS count
    FROM "VersusDrafts" vd
    JOIN (
      SELECT g."versus_draft_id" AS versus_draft_id
      FROM "CanvasGroups" g
      WHERE g."type" = 'series'
        AND g."versus_draft_id" IS NOT NULL
        AND ${metaKeyStorable("g", key)}
      GROUP BY g."versus_draft_id"
      HAVING count(DISTINCT ${value}) > 1
        OR max(char_length(${value})) > ${MAX_NAME_LENGTH}
    ) c ON c.versus_draft_id = vd."id"
    WHERE ${copyNeedsWrite(side)}`;
}

// ---- Step 2: strip (series groups only) -----------------------------------

const stripNeedsWrite = () =>
  `g."type" = 'series' AND ${metaIsObject("g")} AND ${anySide(metaKeyUnstorable)}`;

function stripCountSql() {
  return `SELECT count(*) AS count FROM "CanvasGroups" g WHERE ${stripNeedsWrite()}`;
}

function stripUpdateSql() {
  const [blue, red] = SIDES;
  const afterBlue = `CASE WHEN ${metaKeyUnstorable("g", blue.key)}
        THEN g."metadata" - '${blue.key}' ELSE g."metadata" END`;
  return `UPDATE "CanvasGroups" g
    SET "metadata" = CASE WHEN ${metaKeyUnstorable("g", red.key)}
        THEN (${afterBlue}) - '${red.key}'
        ELSE ${afterBlue} END
    WHERE ${stripNeedsWrite()}`;
}

// Dry run: series groups the strip would change, split by why. A group with
// two unstorable keys of different kinds counts in each kind and once in total.
function stripBreakdownSql() {
  const any = (build) => anySide(build);
  return `SELECT
      count(*) AS total,
      count(*) FILTER (WHERE ${any(metaKeyPlaceholder)}) AS placeholder,
      count(*) FILTER (WHERE ${any(metaKeyBlank)}) AS blank,
      count(*) FILTER (WHERE ${any(metaKeyNonString)}) AS non_string
    FROM "CanvasGroups" g
    WHERE ${stripNeedsWrite()}`;
}

// Dry run: custom groups holding an unstorable name key. The migration leaves
// them alone (T0's writers never touched custom groups).
function customGroupsHoldingCountSql() {
  return `SELECT count(*) AS count FROM "CanvasGroups" g
    WHERE g."type" = 'custom' AND ${metaIsObject("g")} AND ${anySide(metaKeyUnstorable)}`;
}

module.exports = {
  PLACEHOLDER_NAMES,
  WHITESPACE_CLASS,
  SIDES,
  MAX_NAME_LENGTH,
  copyCountSql,
  copyUpdateSql,
  copySkippedCountSql,
  stripCountSql,
  stripUpdateSql,
  stripBreakdownSql,
  customGroupsHoldingCountSql,
};
