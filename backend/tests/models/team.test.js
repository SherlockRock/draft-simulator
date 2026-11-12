import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Team = require("../../models/Team");
const Tournament = require("../../models/Tournament");
const User = require("../../models/User");
const { TEAM_REGIONS } = require("../../utils/teamRegions");
const setupAssociations = require("../../models/associations");

setupAssociations();

describe("Team model", () => {
  const attrs = Team.getAttributes();

  it("has the tournament columns in snake_case", () => {
    for (const column of [
      "tournament_id", "source", "external_id", "external_org_id", "acronym",
      "colors", "archived_at",
    ]) {
      expect(attrs[column], `missing column ${column}`).toBeDefined();
    }
    expect(attrs.tournamentId).toBeUndefined();
    expect(attrs.externalId).toBeUndefined();
  });

  it("allows a null owner (imported teams have none)", () => {
    expect(attrs.owner_id.allowNull).toBe(true);
    expect(attrs.owner_id.references).toEqual({ model: "Users", key: "id" });
  });

  it("links tournament_id to Tournaments, nullable", () => {
    expect(attrs.tournament_id.allowNull).toBe(true);
    expect(attrs.tournament_id.type.key).toBe("UUID");
    expect(attrs.tournament_id.references).toEqual({
      model: "Tournaments",
      key: "id",
    });
  });

  it("defaults source to manual and limits it to manual or esclub", () => {
    expect(attrs.source.allowNull).toBe(false);
    expect(attrs.source.defaultValue).toBe("manual");
    expect(attrs.source.type.toString()).toBe("VARCHAR(16)");
    expect(attrs.source.validate.isIn).toEqual([["manual", "esclub"]]);
  });

  it("types the optional columns", () => {
    expect(attrs.external_id.type.toString()).toBe("VARCHAR(64)");
    expect(attrs.external_id.allowNull).toBe(true);
    expect(attrs.external_org_id.type.toString()).toBe("VARCHAR(64)");
    expect(attrs.external_org_id.allowNull).toBe(true);
    expect(attrs.acronym.type.toString()).toBe("VARCHAR(16)");
    expect(attrs.acronym.allowNull).toBe(true);
    expect(attrs.colors.type.key).toBe("JSONB");
    expect(attrs.colors.allowNull).toBe(true);
    expect(attrs.archived_at.type.key).toBe("DATE");
    expect(attrs.archived_at.allowNull).toBe(true);
  });

  it("limits region to the shared region set", () => {
    expect(attrs.region.defaultValue).toBe("na1");
    expect(attrs.region.validate.isIn).toEqual([TEAM_REGIONS]);
  });

  it("validates a pickup team and an ownerless esclub team", async () => {
    const pickup = Team.build({
      owner_id: "11111111-1111-4111-8111-111111111111",
      name: "Pickup",
    });
    await expect(pickup.validate()).resolves.toBeDefined();
    expect(pickup.source).toBe("manual");
    expect(pickup.tournament_id).toBeUndefined();

    const imported = Team.build({ name: "Imported", source: "esclub" });
    await expect(imported.validate()).resolves.toBeDefined();
  });

  it("rejects an unknown source or region", async () => {
    await expect(
      Team.build({ name: "T", source: "other" }).validate(),
    ).rejects.toThrow();
    await expect(
      Team.build({ name: "T", region: "xx9" }).validate(),
    ).rejects.toThrow();
  });

  it("does not carry the cross-row invariants (Task 5's module owns them)", async () => {
    // esclub with an owner is a DB CHECK and a code check, not a model rule.
    const team = Team.build({
      name: "T",
      source: "esclub",
      owner_id: "11111111-1111-4111-8111-111111111111",
    });
    await expect(team.validate()).resolves.toBeDefined();
  });
});

describe("Team associations", () => {
  it("belongs to a Tournament through tournament_id", () => {
    const assoc = Team.associations.Tournament;
    expect(assoc.associationType).toBe("BelongsTo");
    expect(assoc.target).toBe(Tournament);
    expect(assoc.foreignKey).toBe("tournament_id");
  });

  it("is had many by a Tournament, restricting deletion", () => {
    const assoc = Tournament.associations.Teams;
    expect(assoc.associationType).toBe("HasMany");
    expect(assoc.target).toBe(Team);
    expect(assoc.foreignKey).toBe("tournament_id");
    expect(assoc.options.onDelete).toBe("RESTRICT");
  });

  it("keeps the owner association and its CASCADE", () => {
    expect(Team.associations.owner.target).toBe(User);
    expect(Team.associations.owner.foreignKey).toBe("owner_id");
    const assoc = User.associations.Teams;
    expect(assoc.foreignKey).toBe("owner_id");
    expect(assoc.options.onDelete).toBe("CASCADE");
  });
});
