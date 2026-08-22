import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMatch, EXTRACTOR_VERSION, SNAPSHOT_TIMESTAMPS } from "./extractor.mjs";
import {
  POSITIONS,
  buildMatchDto,
  buildTimelineDto,
  buildParticipant,
  kill,
  buildingKill,
  monsterKill,
  skillLevelUp,
  itemPurchased,
  turretPlateDestroyed,
} from "./test-fixtures.mjs";

test("EXTRACTOR_VERSION is a positive integer", () => {
  assert.ok(Number.isInteger(EXTRACTOR_VERSION) && EXTRACTOR_VERSION >= 1);
});

test("happy path: scalars, wins, bans, and champion-by-role for both teams", () => {
  const { record, skipReason } = extractMatch(buildMatchDto(), buildTimelineDto());
  assert.equal(skipReason, undefined);
  assert.equal(record.queueId, 420);
  assert.equal(record.gameVersion, "15.16.703.1234");
  assert.equal(record.patchMajor, 15);
  assert.equal(record.patchMinor, 16);
  assert.equal(record.gameDurationSec, 1900);
  assert.equal(record.gameStartTimestampMs, 1_755_700_000_000);

  const t100 = record.teams["100"];
  const t200 = record.teams["200"];
  assert.equal(t100.win, true);
  assert.equal(t200.win, false);
  assert.deepEqual(t100.bans, [201, 202, 203, 204, 205]);
  assert.deepEqual(t200.bans, [206, 207, -1, 209, 210]);
  assert.deepEqual(
    POSITIONS.map((p) => t100.participants[p].championId),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    POSITIONS.map((p) => t200.participants[p].championId),
    [6, 7, 8, 9, 10],
  );
  // No player identity in the training store.
  assert.equal(t100.participants.TOP.puuid, undefined);
  assert.equal(t100.participants.TOP.participantId, undefined);
});

test("whole-game participant stats are copied from the match DTO", () => {
  const { record } = extractMatch(buildMatchDto(), buildTimelineDto());
  const top100 = record.teams["100"].participants.TOP; // pid 1
  assert.equal(top100.totalTimeCCDealt, 101);
  assert.equal(top100.timeCCingOthers, 21);
  assert.equal(top100.totalHealsOnTeammates, 301);
  assert.equal(top100.totalHeal, 1001);
  assert.equal(top100.totalDamageShieldedOnTeammates, 401);
  assert.equal(top100.totalDamageTaken, 15001);
  assert.equal(top100.damageSelfMitigated, 9001);
});

test("snapshots at 15/20/25/30 carry frame-derived leaves", () => {
  const { record } = extractMatch(buildMatchDto(), buildTimelineDto());
  const jg200 = record.teams["200"].participants.JUNGLE; // pid 7
  assert.deepEqual(Object.keys(jg200.timeline).map(Number).sort((a, b) => a - b), SNAPSHOT_TIMESTAMPS);

  const at15 = jg200.timeline[900000];
  assert.equal(at15.level, 8); // 1 + floor(15/2)
  assert.equal(at15.creepScore, 15 * 8 + 7 + 7); // minions + jungle
  assert.equal(at15.totalGold, 500 + 70 + 1500);
  assert.deepEqual(at15.damageStats, {
    magicDamageDoneToChampions: 757,
    physicalDamageDoneToChampions: 907,
    trueDamageDoneToChampions: 75,
  });
  const at30 = jg200.timeline[1800000];
  assert.equal(at30.totalGold, 500 + 70 + 3000);
  assert.equal(at30.level, 16);
});

test("K/D/A snapshots are cumulative event counts at each timestamp", () => {
  const events = [
    kill(5 * 60_000, 1, 6, [2]), // pid1 kills pid6, pid2 assists, at 5'
    kill(18 * 60_000, 6, 1), // revenge at 18'
    kill(22 * 60_000, 1, 7), // pid1 again at 22'
  ];
  const { record } = extractMatch(buildMatchDto(), buildTimelineDto({ events }));
  const top100 = record.teams["100"].participants.TOP; // pid 1
  const jg100 = record.teams["100"].participants.JUNGLE; // pid 2
  const top200 = record.teams["200"].participants.TOP; // pid 6

  assert.equal(top100.timeline[900000].kills, 1);
  assert.equal(top100.timeline[900000].deaths, 0);
  assert.equal(jg100.timeline[900000].assists, 1);
  assert.equal(top200.timeline[900000].deaths, 1);

  assert.equal(top100.timeline[1200000].deaths, 1); // 18' kill visible at 20'
  assert.equal(top100.timeline[1200000].kills, 1); // 22' kill NOT yet visible
  assert.equal(top100.timeline[1500000].kills, 2);
});

test("team stats: cumulative kills/objectives, per-frame gold sum", () => {
  const events = [
    kill(10 * 60_000, 1, 6, [3]),
    buildingKill(14 * 60_000, 200, "TOWER_BUILDING"),
    buildingKill(21 * 60_000, 200, "INHIBITOR_BUILDING"),
    monsterKill(16 * 60_000, 100, "DRAGON"),
    monsterKill(19 * 60_000, 100, "BARON_NASHOR"),
    monsterKill(13 * 60_000, 200, "RIFTHERALD"),
  ];
  const { record } = extractMatch(buildMatchDto(), buildTimelineDto({ events }));
  const ts100 = record.teams["100"].teamStats;
  const ts200 = record.teams["200"].teamStats;

  assert.equal(ts100[900000].totalKills, 1);
  assert.equal(ts100[900000].totalAssists, 1);
  assert.equal(ts200[900000].totalDeaths, 1);
  // Reference semantics: BUILDING_KILL credits the event's teamId bucket.
  assert.equal(ts200[900000].towerKills, 1);
  assert.equal(ts200[1200000].inhibitorKills, 0);
  assert.equal(ts200[1500000].inhibitorKills, 1);
  assert.equal(ts200[900000].riftHeraldKills, 1);
  assert.equal(ts100[900000].dragonKills, 0);
  assert.equal(ts100[1200000].dragonKills, 1);
  assert.equal(ts100[1200000].baronKills, 1);
  // Gold is a per-frame sum over the team's five participants.
  const gold15 = [1, 2, 3, 4, 5].reduce((s, pid) => s + 500 + pid * 10 + 1500, 0);
  assert.equal(ts100[900000].totalGold, gold15);
  const gold30 = [6, 7, 8, 9, 10].reduce((s, pid) => s + 500 + pid * 10 + 3000, 0);
  assert.equal(ts200[1800000].totalGold, gold30);
});

test("frame timestamps are rounded to the frame interval before matching", () => {
  const { record, skipReason } = extractMatch(
    buildMatchDto(),
    buildTimelineDto({ jitterMs: 21 }),
  );
  assert.equal(skipReason, undefined);
  assert.equal(record.teams["100"].participants.TOP.timeline[900000].totalGold, 2010);
});

test("a game ending before 20' back-fills later snapshots from the last valid one", () => {
  const { record, skipReason } = extractMatch(
    buildMatchDto({ gameDuration: 1030 }),
    buildTimelineDto({ minutes: 17 }),
  );
  assert.equal(skipReason, undefined);
  const top = record.teams["100"].participants.TOP;
  assert.deepEqual(top.timeline[1200000], top.timeline[900000]);
  assert.deepEqual(top.timeline[1800000], top.timeline[900000]);
  assert.deepEqual(record.teams["200"].teamStats[1500000], record.teams["200"].teamStats[900000]);
});

test("skip: non-420 queue", () => {
  const { record, skipReason } = extractMatch(
    buildMatchDto({ queueId: 700 }),
    buildTimelineDto(),
  );
  assert.equal(record, undefined);
  assert.match(skipReason, /queue 700/);
});

test("skip: remake / short game", () => {
  const { skipReason } = extractMatch(
    buildMatchDto({ gameDuration: 240 }),
    buildTimelineDto({ minutes: 4 }),
  );
  assert.match(skipReason, /duration 240/);
});

test("skip: missing 15-minute frame despite claimed duration", () => {
  const { skipReason } = extractMatch(buildMatchDto(), buildTimelineDto({ minutes: 12 }));
  assert.match(skipReason, /15-min frame/);
});

test("skip: duplicate teamPosition (autofill ambiguity)", () => {
  const participants = buildMatchDto().info.participants;
  participants[1] = buildParticipant({
    participantId: 2,
    teamId: 100,
    teamPosition: "TOP", // duplicate with pid 1
    championId: 2,
  });
  const { skipReason } = extractMatch(buildMatchDto({ participants }), buildTimelineDto());
  assert.match(skipReason, /positions/);
});

test("skip: empty teamPosition", () => {
  const participants = buildMatchDto().info.participants;
  participants[7] = buildParticipant({
    participantId: 8,
    teamId: 200,
    teamPosition: "",
    championId: 8,
  });
  const { skipReason } = extractMatch(buildMatchDto({ participants }), buildTimelineDto());
  assert.match(skipReason, /positions/);
});

test("skip: pre-11.4 patch (assertion — startTime makes this unreachable)", () => {
  const { skipReason } = extractMatch(
    buildMatchDto({ gameVersion: "11.3.355.1234" }),
    buildTimelineDto(),
  );
  assert.match(skipReason, /pre-11\.4/);
});

// ---- extractor v2: widened field set ----

test("v2: EXTRACTOR_VERSION is 2 and snapshots include the 10-minute mark", () => {
  assert.equal(EXTRACTOR_VERSION, 2);
  assert.deepEqual(SNAPSHOT_TIMESTAMPS, [600000, 900000, 1200000, 1500000, 1800000]);
  const { record } = extractMatch(buildMatchDto(), buildTimelineDto());
  const at10 = record.teams["100"].participants.TOP.timeline[600000];
  assert.equal(at10.totalGold, 500 + 10 + 1000); // pid 1, minute 10
  assert.equal(at10.level, 6);
});

test("v2: endgame scalars, items, spells, and perks per participant", () => {
  const { record } = extractMatch(buildMatchDto(), buildTimelineDto());
  const jg200 = record.teams["200"].participants.JUNGLE.endgame; // pid 7
  assert.equal(jg200.kills, 7);
  assert.equal(jg200.deaths, 3);
  assert.equal(jg200.assists, 14);
  assert.equal(jg200.champLevel, 15);
  assert.equal(jg200.goldEarned, 10_007);
  assert.equal(jg200.goldSpent, 9_007);
  assert.equal(jg200.visionScore, 37);
  assert.equal(jg200.creepScore, 207 + 27);
  assert.equal(jg200.totalDamageDealtToChampions, 25_007);
  assert.deepEqual(jg200.items, [3007, 3107, 3207, 3307, 3407, 3507, 3363]);
  assert.deepEqual(jg200.summonerSpells, [4, 7]);
  assert.equal(jg200.perks.statPerks.offense, 5005);
  assert.equal(jg200.perks.styles[0].selections[0].perk, 8012);
});

test("v2: skill order accumulates SKILL_LEVEL_UP slots in time order", () => {
  const events = [
    skillLevelUp(60_000, 1, 1),
    skillLevelUp(120_000, 1, 2),
    skillLevelUp(200_000, 1, 1),
    skillLevelUp(90_000, 6, 3),
  ];
  const { record } = extractMatch(buildMatchDto(), buildTimelineDto({ events }));
  assert.equal(record.teams["100"].participants.TOP.endgame.skillOrder, "121");
  assert.equal(record.teams["200"].participants.TOP.endgame.skillOrder, "3");
});

test("v2: item purchases accumulate as [timestamp, itemId] pairs", () => {
  const events = [
    itemPurchased(30_000, 2, 1055),
    itemPurchased(600_000, 2, 3057),
    itemPurchased(45_000, 9, 1036),
  ];
  const { record } = extractMatch(buildMatchDto(), buildTimelineDto({ events }));
  assert.deepEqual(record.teams["100"].participants.JUNGLE.endgame.itemPurchases, [
    [30_000, 1055],
    [600_000, 3057],
  ]);
  assert.deepEqual(record.teams["200"].participants.BOTTOM.endgame.itemPurchases, [
    [45_000, 1036],
  ]);
});

test("v2: team objectives copied raw, dragon subtypes ordered, plates counted", () => {
  const events = [
    monsterKill(8 * 60_000, 100, "DRAGON", "HEXTECH_DRAGON"),
    monsterKill(14 * 60_000, 100, "DRAGON", "INFERNAL_DRAGON"),
    monsterKill(35 * 60_000 - 30_000, 200, "DRAGON", "ELDER_DRAGON"),
    turretPlateDestroyed(9 * 60_000, 200),
    turretPlateDestroyed(10 * 60_000, 200),
    turretPlateDestroyed(11 * 60_000, 100),
  ];
  const { record } = extractMatch(buildMatchDto(), buildTimelineDto({ minutes: 35, events }));
  const t100 = record.teams["100"];
  const t200 = record.teams["200"];
  assert.deepEqual(t100.objectives.horde, { first: true, kills: 4 });
  assert.deepEqual(t200.objectives.tower, { first: false, kills: 3 });
  assert.deepEqual(t100.dragonSubtypes, ["HEXTECH_DRAGON", "INFERNAL_DRAGON"]);
  assert.deepEqual(t200.dragonSubtypes, ["ELDER_DRAGON"]);
  // Reference semantics: plates bucketed by the event's teamId as-is.
  assert.equal(t200.platesDestroyed, 2);
  assert.equal(t100.platesDestroyed, 1);
});

test("v2: surrender flags surface at match level", () => {
  const clean = extractMatch(buildMatchDto(), buildTimelineDto()).record;
  assert.equal(clean.gameEndedInSurrender, false);
  assert.equal(clean.gameEndedInEarlySurrender, false);

  const participants = buildMatchDto().info.participants;
  for (const p of participants) p.gameEndedInSurrender = true;
  const surrendered = extractMatch(buildMatchDto({ participants }), buildTimelineDto()).record;
  assert.equal(surrendered.gameEndedInSurrender, true);
});
