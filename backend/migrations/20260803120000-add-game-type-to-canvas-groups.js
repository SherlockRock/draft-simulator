"use strict";

/**
 * Backfill CanvasGroup.metadata.gameType from the existing `competitive` flag.
 *
 * No column: gameType lives inside the existing metadata JSONB (design D3).
 * Behaviour-preserving by construction (D7) — every series group counts toward a
 * team's search record today and still counts after; custom groups are untouched
 * and stay untagged. The only new fact in the world is the official/scrim split.
 *
 * Rollback note: `down` removes the key from every series group, which discards
 * classifications a user set AFTER deployment as well as the ones this migration
 * wrote. That is conventional for a schema rollback but is not semantically
 * lossless — an untagged series still counts (the D6 structural fallback), so no
 * record changes, but a deliberate `scratch` would be lost.
 */
module.exports = {
  async up(queryInterface) {
    // COALESCE everywhere: metadata is JSONB with defaultValue {} but no
    // allowNull:false (models/Canvas.js), so it is null in practice, and both
    // `jsonb_set(NULL, …)` and `NULL || …` yield SQL NULL — those rows would
    // silently skip the backfill.
    //
    // jsonb_exists(...), NOT the `?` operator: in raw sequelize.query `?` is
    // Sequelize's positional-replacement token, inert only while no
    // `replacements` option is passed. Two migrations in this repo already pass
    // replacements, so a later edit could silently mangle this guard.
    //
    // `competitive` is a JSON boolean, so ->> yields 'true'/'false'; a row
    // missing the key yields SQL NULL, which must fall to 'scrim', not NULL.
    await queryInterface.sequelize.query(`
      UPDATE "CanvasGroups"
      SET "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object(
        'gameType',
        CASE
          WHEN COALESCE("metadata", '{}'::jsonb) ->> 'competitive' = 'true'
            THEN 'official'
          ELSE 'scrim'
        END
      )
      WHERE "type" = 'series'
        AND NOT jsonb_exists(COALESCE("metadata", '{}'::jsonb), 'gameType');
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "CanvasGroups"
      SET "metadata" = COALESCE("metadata", '{}'::jsonb) - 'gameType'
      WHERE "type" = 'series'
        AND jsonb_exists(COALESCE("metadata", '{}'::jsonb), 'gameType');
    `);
  },
};
