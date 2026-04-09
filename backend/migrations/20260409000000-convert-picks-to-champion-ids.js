"use strict";

const championData = require("../../frontend/src/data/champions.json");

const indexToChampionId = championData.champions.map((champion) => champion.id);
const validChampionIds = new Set(indexToChampionId);
const numericStringPattern = /^(0|[1-9]\d*)$/;
const batchSize = 100;

function convertChampionRef(value) {
  if (value === "" || validChampionIds.has(value)) {
    return value;
  }

  if (!numericStringPattern.test(value)) {
    return value;
  }

  return indexToChampionId[Number(value)] ?? value;
}

function convertChampionRefs(values) {
  let changed = false;
  const converted = values.map((value) => {
    const nextValue = convertChampionRef(value);
    if (nextValue !== value) {
      changed = true;
    }
    return nextValue;
  });

  return { changed, converted };
}

function parseMetadata(metadata) {
  if (metadata === null || metadata === undefined) {
    return {};
  }

  if (typeof metadata === "string") {
    return JSON.parse(metadata);
  }

  return metadata;
}

async function migrateTableRows(
  queryInterface,
  Sequelize,
  tableName,
  fieldName,
) {
  let offset = 0;

  while (true) {
    const rows = await queryInterface.sequelize.query(
      `SELECT "id", "${fieldName}" FROM "${tableName}" ORDER BY "id" ASC LIMIT :limit OFFSET :offset`,
      {
        replacements: { limit: batchSize, offset },
        type: Sequelize.QueryTypes.SELECT,
      },
    );

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const values = Array.isArray(row[fieldName]) ? row[fieldName] : [];
      const { changed, converted } = convertChampionRefs(values);
      if (!changed) {
        continue;
      }

      await queryInterface.bulkUpdate(
        tableName,
        { [fieldName]: converted, updatedAt: new Date() },
        { id: row.id },
      );
    }

    offset += batchSize;
  }
}

async function migrateCanvasGroupMetadata(queryInterface, Sequelize) {
  let offset = 0;

  while (true) {
    const rows = await queryInterface.sequelize.query(
      'SELECT "id", "metadata" FROM "CanvasGroups" ORDER BY "id" ASC LIMIT :limit OFFSET :offset',
      {
        replacements: { limit: batchSize, offset },
        type: Sequelize.QueryTypes.SELECT,
      },
    );

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const metadata = parseMetadata(row.metadata);
      const disabledChampions = Array.isArray(metadata.disabledChampions)
        ? metadata.disabledChampions
        : [];
      const { changed, converted } = convertChampionRefs(disabledChampions);
      if (!changed) {
        continue;
      }

      await queryInterface.bulkUpdate(
        "CanvasGroups",
        {
          metadata: { ...metadata, disabledChampions: converted },
          updatedAt: new Date(),
        },
        { id: row.id },
      );
    }

    offset += batchSize;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await migrateTableRows(queryInterface, Sequelize, "Drafts", "picks");
    await migrateTableRows(
      queryInterface,
      Sequelize,
      "VersusDrafts",
      "disabledChampions",
    );
    await migrateCanvasGroupMetadata(queryInterface, Sequelize);
  },

  async down() {
    // Irreversible data migration: champion IDs remain valid storage values.
  },
};
