import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const EsclubSync = require("../../models/EsclubSync");
const EsclubDailyUsage = require("../../models/EsclubDailyUsage");

describe("EsclubSync model", () => {
  const attrs = EsclubSync.getAttributes();

  it("maps to the EsclubSyncs table", () => {
    expect(EsclubSync.getTableName()).toBe("EsclubSyncs");
  });

  it("has the snake_case columns", () => {
    for (const column of [
      "id", "kind", "tournament_id", "stage_id", "series_id", "requested_by",
      "via", "status", "started_at", "heartbeat_at", "finished_at",
      "request_count", "error_class", "error_message", "summary",
    ]) {
      expect(attrs[column], `missing column ${column}`).toBeDefined();
    }
    expect(attrs.tournamentId).toBeUndefined();
  });

  it("uses a UUID primary key", () => {
    expect(attrs.id.primaryKey).toBe(true);
    expect(attrs.id.type.key).toBe("UUID");
  });

  it("types and nullability", () => {
    expect(attrs.kind.allowNull).toBe(false);
    expect(attrs.kind.type.toString()).toBe("VARCHAR(16)");
    expect(attrs.via.allowNull).toBe(false);
    expect(attrs.via.type.toString()).toBe("VARCHAR(8)");
    expect(attrs.status.allowNull).toBe(false);
    expect(attrs.status.type.toString()).toBe("VARCHAR(16)");
    for (const c of ["started_at", "heartbeat_at"]) {
      expect(attrs[c].allowNull, c).toBe(false);
      expect(attrs[c].type.key, c).toBe("DATE");
    }
    for (const c of ["tournament_id", "stage_id", "series_id", "requested_by"]) {
      expect(attrs[c].allowNull, c).toBe(true);
      expect(attrs[c].type.key, c).toBe("UUID");
    }
    expect(attrs.finished_at.allowNull).toBe(true);
    expect(attrs.finished_at.type.key).toBe("DATE");
    expect(attrs.error_class.allowNull).toBe(true);
    expect(attrs.error_class.type.toString()).toBe("VARCHAR(64)");
    expect(attrs.error_message.allowNull).toBe(true);
    expect(attrs.error_message.type.key).toBe("TEXT");
    expect(attrs.summary.allowNull).toBe(true);
    expect(attrs.summary.type.key).toBe("JSONB");
  });

  it("references the parents", () => {
    expect(attrs.tournament_id.references).toEqual({ model: "Tournaments", key: "id" });
    expect(attrs.stage_id.references).toEqual({ model: "LeagueStages", key: "id" });
    expect(attrs.series_id.references).toEqual({ model: "LeagueSeries", key: "id" });
    expect(attrs.requested_by.references).toEqual({ model: "Users", key: "id" });
  });

  it("defaults request_count to 0", () => {
    expect(attrs.request_count.allowNull).toBe(false);
    expect(attrs.request_count.defaultValue).toBe(0);
    expect(EsclubSync.build({ kind: "league", via: "api" }).request_count).toBe(0);
  });

  it("limits kind, via and status", async () => {
    const base = {
      kind: "add",
      via: "cli",
      status: "running",
      started_at: new Date(),
      heartbeat_at: new Date(),
    };
    await expect(EsclubSync.build(base).validate()).resolves.toBeDefined();
    for (const bad of [{ kind: "x" }, { via: "web" }, { status: "done" }]) {
      await expect(EsclubSync.build({ ...base, ...bad }).validate()).rejects.toThrow();
    }
    for (const kind of ["add", "league", "serie"]) {
      await expect(EsclubSync.build({ ...base, kind }).validate()).resolves.toBeDefined();
    }
    for (const status of ["running", "succeeded", "failed"]) {
      await expect(EsclubSync.build({ ...base, status }).validate()).resolves.toBeDefined();
    }
  });

  it("requires kind, via, status, started_at and heartbeat_at", async () => {
    await expect(EsclubSync.build({}).validate()).rejects.toThrow();
  });
});

describe("EsclubDailyUsage model", () => {
  const attrs = EsclubDailyUsage.getAttributes();

  it("maps to the EsclubDailyUsage table, not pluralised", () => {
    expect(EsclubDailyUsage.getTableName()).toBe("EsclubDailyUsage");
  });

  it("is keyed by day (DATEONLY)", () => {
    expect(EsclubDailyUsage.primaryKeyAttributes).toEqual(["day"]);
    expect(attrs.day.type.key).toBe("DATEONLY");
    expect(attrs.id).toBeUndefined();
  });

  it("defaults request_count to 0 and refuses a negative", async () => {
    expect(attrs.request_count.allowNull).toBe(false);
    expect(attrs.request_count.defaultValue).toBe(0);
    expect(attrs.request_count.type.key).toBe("INTEGER");
    const ok = EsclubDailyUsage.build({ day: "2026-11-14" });
    expect(ok.request_count).toBe(0);
    await expect(ok.validate()).resolves.toBeDefined();
    const bad = EsclubDailyUsage.build({ day: "2026-11-14", request_count: -1 });
    await expect(bad.validate()).rejects.toThrow();
  });
});
