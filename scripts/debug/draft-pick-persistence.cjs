// Real PostgreSQL verification, isolated from application credentials/data.
// Requires local PostgreSQL binaries: node scripts/debug/draft-pick-persistence.cjs
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { createRequire, Module } = require("node:module");
const { randomUUID } = require("node:crypto");
const back = createRequire(`${process.cwd()}/backend/package.json`);
const { Sequelize } = back("sequelize");
const bin = ["/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin"].find(
  (path) => existsSync(join(path, "initdb")),
);
assert(bin, "Local PostgreSQL binaries are required");
const directory = mkdtempSync(join(tmpdir(), "firstpick-pick-db-"));
let started = false;
let db;
function run(name, args) {
  const result = spawnSync(join(bin, name), args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${name} failed: ${result.stderr || result.stdout}`);
}
(async () => {
  try {
    run("initdb", [
      "-D",
      directory,
      "-A",
      "trust",
      "-U",
      "postgres",
      "--no-locale",
      "-E",
      "UTF8",
    ]);
    // Unix socket only. Never listens on a network interface.
    run("pg_ctl", [
      "-D",
      directory,
      "-l",
      join(directory, "server.log"),
      "-o",
      `-F -h '' -k ${directory} -p 55439`,
      "-w",
      "start",
    ]);
    started = true;
    db = new Sequelize("postgres", "postgres", "", {
      host: directory,
      port: 55439,
      dialect: "postgres",
      logging: false,
    });
    // Inject the explicitly local connection before importing any app models;
    // config/database.js and dotenv are never evaluated by this harness.
    const configPath = back.resolve("./config/database");
    const config = new Module(configPath);
    config.exports = db;
    require.cache[configPath] = config;
    back("./models/associations")();
    const Draft = back("./models/Draft");
    const User = back("./models/User");
    const { Canvas, CanvasDraft, UserCanvas } = back("./models/Canvas");
    const { createCanvasMutationGate } = back("./services/canvasMutations");
    const migration = back(
      "./migrations/20260911120000-add-draft-pick-revision",
    );
    const qi = db.getQueryInterface();
    await db.sync();
    await qi.removeColumn("Drafts", "lastPickMutationId");
    await qi.removeColumn("Drafts", "picksVersion");
    await migration.up(qi, Sequelize);
    const owner = await User.create({
      name: "Local test",
      email: "test@example.test",
    });
    const canvas = await Canvas.create({ name: "Local verification" });
    await UserCanvas.create({
      canvas_id: canvas.id,
      user_id: owner.id,
      permissions: "admin",
    });
    const draft = await Draft.create({
      owner_id: owner.id,
      picks: Array(20).fill(""),
    });
    await CanvasDraft.create({
      canvas_id: canvas.id,
      draft_id: draft.id,
      positionX: 0,
      positionY: 0,
    });
    const io = { to: () => ({ emit() {} }) };
    const gate = createCanvasMutationGate({ io });
    const actor = { userId: owner.id, socketId: "local-test" };
    const request = {
      actor,
      id: draft.id,
      mutationId: randomUUID(),
      baseVersion: 0,
      changes: [{ index: 10, championId: "Orianna" }],
    };
    const duplicate = await Promise.all([
      gate.applyDraftPickMutation(request),
      gate.applyDraftPickMutation(request),
    ]);
    assert.deepEqual(
      duplicate.map((value) => value.picksVersion),
      [1, 1],
    );
    const afterDuplicate = await Draft.findByPk(draft.id);
    assert.equal(afterDuplicate.picksVersion, 1);
    assert.equal(afterDuplicate.picks[10], "Orianna");
    // Fresh gate instance has no in-memory knowledge of the previous receipt.
    const freshGate = createCanvasMutationGate({ io });
    assert.equal(
      (await freshGate.applyDraftPickMutation(request)).picksVersion,
      1,
    );
    const contenders = await Promise.allSettled(
      ["Syndra", "Ahri"].map((championId) =>
        gate.applyDraftPickMutation({
          ...request,
          mutationId: randomUUID(),
          baseVersion: 1,
          changes: [{ index: 10, championId }],
        }),
      ),
    );
    assert.equal(
      contenders.filter((value) => value.status === "fulfilled").length,
      1,
    );
    const rejected = contenders.find((value) => value.status === "rejected");
    assert.equal(rejected.reason.code, "PICK_CONFLICT");
    await assert.rejects(
      gate.applyDraftPickMutation(request),
      (error) => error.code === "PICK_CONFLICT",
    );
    assert.equal((await Draft.findByPk(draft.id)).picksVersion, 2);
    // A legacy client must also advance the revision and invalidate the receipt.
    await gate.applyDraftPicks({
      actor,
      draftId: draft.id,
      picks: Array(20).fill(""),
    });
    const afterLegacy = await Draft.findByPk(draft.id);
    assert.equal(afterLegacy.picksVersion, 3);
    assert.equal(afterLegacy.lastPickMutationId, null);
    await migration.down(qi);
    assert.equal((await qi.describeTable("Drafts")).picksVersion, undefined);
    await migration.up(qi, Sequelize);
    assert.equal((await Draft.findByPk(draft.id)).picksVersion, 0);
    console.log(
      "PASS: migration up/down, concurrent duplicate delivery, persisted receipt, conflicting writers, stale retry, legacy revision",
    );
  } finally {
    if (db) await db.close();
    if (started) run("pg_ctl", ["-D", directory, "-m", "fast", "-w", "stop"]);
    rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
