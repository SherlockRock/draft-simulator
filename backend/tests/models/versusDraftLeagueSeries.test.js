import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const VersusDraft = require("../../models/VersusDraft");
const LeagueSeries = require("../../models/LeagueSeries");
const setupAssociations = require("../../models/associations");

setupAssociations();

const SERIES_ID = "33333333-3333-4333-8333-333333333333";

describe("VersusDraft.league_series_id (S3 D1)", () => {
  const attrs = VersusDraft.getAttributes();

  it("is a nullable UUID referencing LeagueSeries", () => {
    expect(attrs.league_series_id, "missing column league_series_id").toBeDefined();
    expect(attrs.league_series_id.type.key).toBe("UUID");
    expect(attrs.league_series_id.allowNull).toBe(true);
    expect(attrs.league_series_id.references).toEqual({
      model: "LeagueSeries",
      key: "id",
    });
    expect(attrs.league_series_id.unique).toBeFalsy();
  });

  it("defaults to null, so a manual series is not an import", async () => {
    const series = VersusDraft.build({ name: "Manual" });
    expect(series.league_series_id == null).toBe(true);
    await expect(series.validate()).resolves.toBeDefined();
  });

  it("keeps a set value", async () => {
    const series = VersusDraft.build({
      name: "Imported",
      league_series_id: SERIES_ID,
    });
    expect(series.league_series_id).toBe(SERIES_ID);
    await expect(series.validate()).resolves.toBeDefined();
  });
});

describe("VersusDraft <-> LeagueSeries associations", () => {
  it("VersusDraft belongs to its LeagueSeries, SET NULL on delete", () => {
    const assoc = VersusDraft.associations.LeagueSeries;
    expect(assoc, "VersusDraft.associations.LeagueSeries").toBeDefined();
    expect(assoc.associationType).toBe("BelongsTo");
    expect(assoc.target).toBe(LeagueSeries);
    expect(assoc.foreignKey).toBe("league_series_id");
    expect(assoc.options.onDelete).toBe("SET NULL");
  });

  it("LeagueSeries has many VersusDrafts on league_series_id", () => {
    const assoc = Object.values(LeagueSeries.associations).find(
      (a) => a.target === VersusDraft,
    );
    expect(assoc, "LeagueSeries -> VersusDraft").toBeDefined();
    expect(assoc.associationType).toBe("HasMany");
    expect(assoc.foreignKey).toBe("league_series_id");
    expect(assoc.options.onDelete).toBe("SET NULL");
  });

  it("leaves the attribute nullable after the associations are set up", () => {
    expect(VersusDraft.getAttributes().league_series_id.allowNull).toBe(true);
  });
});
