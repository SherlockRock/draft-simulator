import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Tournament = require("../../models/Tournament");
const UserTournament = require("../../models/UserTournament");
const User = require("../../models/User");
const Team = require("../../models/Team");
const { TEAM_REGIONS } = require("../../utils/teamRegions");
const setupAssociations = require("../../models/associations");

setupAssociations();

describe("Tournament model", () => {
  const attrs = Tournament.getAttributes();

  it("has the snake_case columns, not camelCase twins", () => {
    for (const column of [
      "id", "name", "source", "external_id", "region", "starts_at", "ends_at",
      "created_by", "archived_at", "last_synced_at",
    ]) {
      expect(attrs[column], `missing column ${column}`).toBeDefined();
    }
    expect(attrs.externalId).toBeUndefined();
    expect(attrs.createdBy).toBeUndefined();
  });

  it("uses a UUID primary key", () => {
    expect(attrs.id.primaryKey).toBe(true);
    expect(attrs.id.type.key).toBe("UUID");
  });

  it("requires a name of at most 200 characters", () => {
    expect(attrs.name.allowNull).toBe(false);
    expect(attrs.name.type.toString()).toBe("VARCHAR(200)");
    expect(attrs.name.validate.notEmpty).toBe(true);
  });

  it("defaults source to manual and limits it to manual or esclub", () => {
    expect(attrs.source.allowNull).toBe(false);
    expect(attrs.source.defaultValue).toBe("manual");
    expect(attrs.source.type.toString()).toBe("VARCHAR(16)");
    expect(attrs.source.validate.isIn).toEqual([["manual", "esclub"]]);
  });

  it("defaults region to na1 and limits it to the team region set", () => {
    expect(attrs.region.allowNull).toBe(false);
    expect(attrs.region.defaultValue).toBe("na1");
    expect(attrs.region.type.toString()).toBe("VARCHAR(8)");
    expect(attrs.region.validate.isIn).toEqual([
      ["na1", "euw1", "eun1", "kr", "br1", "oc1"],
    ]);
  });

  it("uses the shared region set itself, not a copy", () => {
    expect(attrs.region.validate.isIn[0]).toBe(TEAM_REGIONS);
  });

  it("makes external_id and the date columns nullable", () => {
    expect(attrs.external_id.allowNull).toBe(true);
    expect(attrs.external_id.type.toString()).toBe("VARCHAR(64)");
    for (const column of ["starts_at", "ends_at", "archived_at", "last_synced_at"]) {
      expect(attrs[column].allowNull, column).toBe(true);
      expect(attrs[column].type.key, column).toBe("DATE");
    }
  });

  it("links created_by to Users, nullable", () => {
    expect(attrs.created_by.allowNull).toBe(true);
    expect(attrs.created_by.references).toEqual({ model: "Users", key: "id" });
  });

  it("rejects an unknown source or region on validate", async () => {
    const bad = Tournament.build({ name: "Cup", source: "other", region: "xx9" });
    await expect(bad.validate()).rejects.toThrow();
    const good = Tournament.build({ name: "Cup", source: "esclub", region: "euw1" });
    await expect(good.validate()).resolves.toBeDefined();
  });

  it("applies defaults on build", () => {
    const t = Tournament.build({ name: "Cup" });
    expect(t.source).toBe("manual");
    expect(t.region).toBe("na1");
    expect(t.external_id).toBeUndefined();
  });
});

describe("UserTournament model", () => {
  const attrs = UserTournament.getAttributes();

  it("has a composite primary key of user_id and tournament_id", () => {
    expect(attrs.user_id.primaryKey).toBe(true);
    expect(attrs.tournament_id.primaryKey).toBe(true);
    expect(attrs.user_id.type.key).toBe("UUID");
    expect(attrs.tournament_id.type.key).toBe("UUID");
    expect(attrs.user_id.references).toEqual({ model: "Users", key: "id" });
    expect(attrs.tournament_id.references).toEqual({
      model: "Tournaments",
      key: "id",
    });
  });

  it("has a nullable archived_at", () => {
    expect(attrs.archived_at.allowNull).toBe(true);
    expect(attrs.archived_at.type.key).toBe("DATE");
  });
});

describe("Tournament associations", () => {
  it("belongs to a creator through created_by", () => {
    const assoc = Tournament.associations.creator;
    expect(assoc.associationType).toBe("BelongsTo");
    expect(assoc.target).toBe(User);
    expect(assoc.foreignKey).toBe("created_by");
  });

  it("links Users and Tournaments many-to-many through UserTournament", () => {
    const userSide = User.associations.Tournaments;
    expect(userSide.associationType).toBe("BelongsToMany");
    expect(userSide.through.model).toBe(UserTournament);
    expect(userSide.foreignKey).toBe("user_id");
    expect(userSide.otherKey).toBe("tournament_id");

    const tournamentSide = Tournament.associations.Users;
    expect(tournamentSide.associationType).toBe("BelongsToMany");
    expect(tournamentSide.through.model).toBe(UserTournament);
    expect(tournamentSide.foreignKey).toBe("tournament_id");
    expect(tournamentSide.otherKey).toBe("user_id");
  });

  it("lets UserTournament join to its two parents", () => {
    expect(UserTournament.associations.Tournament.target).toBe(Tournament);
    expect(UserTournament.associations.User.target).toBe(User);
  });

  it("has many Teams through tournament_id", () => {
    const assoc = Tournament.associations.Teams;
    expect(assoc.associationType).toBe("HasMany");
    expect(assoc.target).toBe(Team);
    expect(assoc.foreignKey).toBe("tournament_id");
  });
});
