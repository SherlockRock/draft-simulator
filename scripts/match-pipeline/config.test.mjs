import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.mjs";

test("defaults: regions, queue, tiers, filters", () => {
  const cfg = loadConfig({});
  assert.deepEqual(cfg.regions, ["na1", "euw1", "kr"]);
  assert.equal(cfg.queueId, 420);
  assert.equal(cfg.leagueQueue, "RANKED_SOLO_5x5");
  assert.deepEqual(cfg.apexTiers, ["CHALLENGER", "GRANDMASTER", "MASTER"]);
  assert.deepEqual(cfg.diamondDivisions, ["I", "II"]);
  assert.equal(cfg.diamondPageCap, 40);
  assert.equal(cfg.minDurationSec, 900);
  assert.deepEqual(cfg.minPatch, [11, 4]);
  assert.ok(Number.isInteger(cfg.startTime) && cfg.startTime > 1_700_000_000);
});

test("defaults: personal-key rate buckets and loop tuning", () => {
  const cfg = loadConfig({});
  assert.deepEqual(cfg.appBuckets, [
    [20, 1000],
    [100, 120_000],
  ]);
  assert.deepEqual(cfg.matchMethodBucket, [2000, 10_000]);
  assert.equal(cfg.summonerRefetchDays, 2);
  assert.equal(cfg.rankFreshDays, 7);
  assert.equal(cfg.apexMatchIdPages, 3);
  assert.equal(cfg.diamondMatchIdPages, 1);
  assert.equal(cfg.backlogPauseThreshold, 50_000);
  assert.equal(cfg.processorBatchSize, 200);
  assert.equal(cfg.processorConcurrency, 10);
  assert.equal(cfg.ladderIntervalMs, 24 * 3600 * 1000);
});

test("env overrides: numbers, region list, bucket JSON, start time", () => {
  const cfg = loadConfig({
    COLLECTOR_REGIONS: "na1,kr",
    COLLECTOR_DIAMOND_PAGE_CAP: "5",
    COLLECTOR_APP_BUCKETS: "[[500,10000],[30000,600000]]",
    COLLECTOR_START_TIME: "2026-08-13",
    COLLECTOR_BACKLOG_PAUSE: "10000",
    COLLECTOR_PROCESSOR_BATCH: "50",
    COLLECTOR_PROCESSOR_CONCURRENCY: "4",
  });
  assert.deepEqual(cfg.regions, ["na1", "kr"]);
  assert.equal(cfg.diamondPageCap, 5);
  assert.deepEqual(cfg.appBuckets, [
    [500, 10_000],
    [30_000, 600_000],
  ]);
  assert.equal(cfg.startTime, Math.floor(Date.UTC(2026, 7, 13) / 1000));
  assert.equal(cfg.backlogPauseThreshold, 10_000);
  assert.equal(cfg.processorBatchSize, 50);
  assert.equal(cfg.processorConcurrency, 4);
});

test("COLLECTOR_START_TIME also accepts raw unix seconds", () => {
  const cfg = loadConfig({ COLLECTOR_START_TIME: "1755043200" });
  assert.equal(cfg.startTime, 1_755_043_200);
});
