"use strict";

// Finishes T0 (placeholder team names) on existing data. Two steps, in one
// transaction, copy first. SQL lives in utils/placeholderTeamNameMigration.js.
//
// A "storable" name is a string that is non-blank after trim and is not
// "team 1" / "team 2" (any case, trimmed): backend/utils/teamPlaceholders.js.
//
// Step 1, copy (Q10). Changes VersusDrafts rows where ALL hold:
//   - origin = 'manual';
//   - a CanvasGroup of type 'series' points at it (versus_draft_id) and holds a
//     storable string in metadata.blueTeamName (redTeamName for the red side);
//   - that VersusDraft's blueTeamName (redTeamName) column is NOT storable:
//     a placeholder ("Team 1"/"Team 2", any case or spacing) or blank.
//   The column gets the metadata string as stored (untrimmed): that is what the
//   group PUT copies to the column and what T0's writers keep in metadata.
//   Sides are independent. Never touched: live series (origin <> 'manual'); a
//   column already holding a real name, even when it differs from the metadata
//   name; any VersusDraft side where several series groups share the draft and
//   carry different real names, or a name over 255 characters (skipped, not
//   guessed: POST /canvases/:id/import/series can put one manual series on
//   two groups). Columns are NOT NULL and this never blanks or nulls one.
//
// Step 2, strip. Changes CanvasGroups rows where type = 'series' and metadata
//   is an object holding blueTeamName and/or redTeamName with a value that is
//   not storable: a placeholder, blank, or not a string (null, number...).
//   This is per series group, whatever its series is: groups whose
//   VersusDraft is live, and groups with no VersusDraft (versus_draft_id
//   NULL), are stripped too. Only metadata changes; no VersusDraft is read.
//   Only those keys are removed (absent, not null: the shape the clear
//   protocol leaves); every other metadata key is kept. Never touched: custom
//   groups (T0's writers never wrote names there); keys holding real names;
//   rows with a null or non-object metadata.
//
// A manual VersusDraft whose column is a placeholder or blank, and whose series
// groups carry no real name for that side, is left as it is (a blank stays
// blank): there is nothing real to copy, and this never blanks or nulls.
//
// updatedAt is not bumped on either table: a data clean-up must not reorder
// anything that sorts or caches by recency.
//
// Idempotent by its WHERE clauses: once copied, the column is storable; once
// stripped, no unstorable key remains. A second run changes nothing.
//
// down: a no-op (Q7). The removed placeholders and blanks carried no
// information (the VersusDraft column defaults and the card fallbacks show
// "Team 1"/"Team 2" anyway), and the copy only filled a placeholder with a
// real name. Restoring either would put back the state T0 removed.

const {
  SIDES,
  copyCountSql,
  copyUpdateSql,
  stripCountSql,
  stripUpdateSql,
} = require("../utils/placeholderTeamNameMigration");

function readCount(rows) {
  const first = Array.isArray(rows) ? rows[0] : undefined;
  return first && first.count !== undefined ? Number(first.count) : 0;
}

// pg UPDATE through sequelize.query resolves [rows, { rowCount }].
function affectedRows(result) {
  const meta = Array.isArray(result) ? result[1] : undefined;
  if (typeof meta === "number") return meta;
  return meta && typeof meta.rowCount === "number" ? meta.rowCount : "unknown";
}

async function countThenWrite(sequelize, transaction, label, countSql, updateSql) {
  const before = readCount(
    await sequelize.query(countSql, { type: "SELECT", transaction }),
  );
  console.log(`clear-placeholder-team-names: ${label}: ${before} row(s) to change`);
  const result = await sequelize.query(updateSql, { transaction });
  console.log(
    `clear-placeholder-team-names: ${label}: ${affectedRows(result)} row(s) changed`,
  );
}

module.exports = {
  async up(queryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.transaction(async (transaction) => {
      for (const side of SIDES) {
        await countThenWrite(
          sequelize,
          transaction,
          `copy ${side.key} to VersusDrafts`,
          copyCountSql(side.key),
          copyUpdateSql(side.key),
        );
      }
      await countThenWrite(
        sequelize,
        transaction,
        "strip CanvasGroups.metadata",
        stripCountSql(),
        stripUpdateSql(),
      );
    });
  },

  // No-op by design (Q7): see the header.
  async down() {},
};
