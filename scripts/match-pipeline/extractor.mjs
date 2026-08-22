/**
 * Pure extractor: (matchDto, timelineDto) → { record } | { skipReason }.
 *
 * Field set follows LoLDraftAI's matchProcessing.ts (per-role champion +
 * timeline snapshots at 15/20/25/30 min + whole-game tank/utility stats +
 * per-snapshot team stats + win), plus per-team bans which they dropped.
 * Champion IDs are raw Riot ints; positions are Riot vocabulary
 * (TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY). No player identity is stored.
 *
 * Bump EXTRACTOR_VERSION whenever the record shape changes — it is stamped on
 * every row so exports can select by shape instead of re-crawling.
 */

export const EXTRACTOR_VERSION = 1;

export const SNAPSHOT_TIMESTAMPS = [900_000, 1_200_000, 1_500_000, 1_800_000];

const POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
const MIN_DURATION_SEC = 900;

const skip = (skipReason) => ({ skipReason });

export function extractMatch(matchDto, timelineDto) {
  const info = matchDto.info;

  if (info.queueId !== 420) return skip(`queue ${info.queueId} (not ranked solo/duo)`);
  if (info.gameDuration < MIN_DURATION_SEC) {
    return skip(`duration ${info.gameDuration}s < ${MIN_DURATION_SEC}s (remake/short game)`);
  }

  const [patchMajor, patchMinor] = info.gameVersion.split(".").map((n) => parseInt(n, 10) || 0);
  if (patchMajor < 11 || (patchMajor === 11 && patchMinor < 4)) {
    // championId is unreliable before 11.4; startTime makes this unreachable.
    return skip(`pre-11.4 patch (${info.gameVersion})`);
  }

  // Each team must field exactly the five positions — autofill ambiguity
  // (missing/duplicate teamPosition, ~3% of games) is skipped, not guessed.
  for (const teamId of [100, 200]) {
    const positions = info.participants
      .filter((p) => p.teamId === teamId)
      .map((p) => p.teamPosition);
    const valid =
      positions.length === 5 &&
      new Set(positions).size === 5 &&
      positions.every((p) => POSITIONS.includes(p));
    if (!valid) return skip(`ambiguous positions for team ${teamId}: [${positions.join(",")}]`);
  }

  const teamDto = (teamId) => info.teams.find((t) => t.teamId === teamId);
  const teams = {};
  const byParticipantId = {};
  for (const teamId of [100, 200]) {
    teams[String(teamId)] = {
      win: teamDto(teamId).win,
      bans: (teamDto(teamId).bans ?? []).map((b) => b.championId),
      participants: {},
      teamStats: {},
    };
  }
  for (const p of info.participants) {
    byParticipantId[p.participantId] = p;
    teams[String(p.teamId)].participants[p.teamPosition] = {
      championId: p.championId,
      timeline: {},
      totalTimeCCDealt: p.totalTimeCCDealt,
      timeCCingOthers: p.timeCCingOthers,
      totalHealsOnTeammates: p.totalHealsOnTeammates,
      totalHeal: p.totalHeal,
      totalDamageShieldedOnTeammates: p.totalDamageShieldedOnTeammates,
      totalDamageTaken: p.totalDamageTaken,
      damageSelfMitigated: p.damageSelfMitigated,
    };
  }

  // Walk frames in order, accumulating K/D/A and objective events, snapshotting
  // at the relevant timestamps. Frame timestamps are rounded to the frame
  // interval (the real API jitters them by a few ms).
  const frameInterval = timelineDto.info.frameInterval ?? 60_000;
  const kda = {};
  for (let pid = 1; pid <= 10; pid++) kda[pid] = { kills: 0, deaths: 0, assists: 0 };
  const runningTeamStats = {};
  for (const teamId of [100, 200]) {
    runningTeamStats[teamId] = {
      totalKills: 0,
      totalDeaths: 0,
      totalAssists: 0,
      totalGold: 0,
      towerKills: 0,
      inhibitorKills: 0,
      baronKills: 0,
      dragonKills: 0,
      riftHeraldKills: 0,
    };
  }

  for (const frame of timelineDto.info.frames) {
    for (const event of frame.events ?? []) applyEvent(event, kda, byParticipantId, runningTeamStats);

    const timestamp = Math.round(frame.timestamp / frameInterval) * frameInterval;
    if (!SNAPSHOT_TIMESTAMPS.includes(timestamp)) continue;

    for (const teamId of [100, 200]) runningTeamStats[teamId].totalGold = 0;
    for (const [pidStr, pf] of Object.entries(frame.participantFrames)) {
      const p = byParticipantId[Number(pidStr)];
      const stats = kda[Number(pidStr)];
      teams[String(p.teamId)].participants[p.teamPosition].timeline[timestamp] = {
        level: pf.level,
        kills: stats.kills,
        deaths: stats.deaths,
        assists: stats.assists,
        creepScore: pf.minionsKilled + pf.jungleMinionsKilled,
        totalGold: pf.totalGold,
        damageStats: {
          magicDamageDoneToChampions: pf.damageStats.magicDamageDoneToChampions,
          physicalDamageDoneToChampions: pf.damageStats.physicalDamageDoneToChampions,
          trueDamageDoneToChampions: pf.damageStats.trueDamageDoneToChampions,
        },
      };
      runningTeamStats[p.teamId].totalGold += pf.totalGold;
    }
    for (const teamId of [100, 200]) {
      teams[String(teamId)].teamStats[timestamp] = { ...runningTeamStats[teamId] };
    }
  }

  if (!(SNAPSHOT_TIMESTAMPS[0] in teams["100"].teamStats)) {
    return skip("missing 15-min frame");
  }

  // Back-fill snapshots past the game's end from the last valid one
  // (reference semantics: copy the previous relevant timestamp).
  for (let i = 1; i < SNAPSHOT_TIMESTAMPS.length; i++) {
    const ts = SNAPSHOT_TIMESTAMPS[i];
    const prev = SNAPSHOT_TIMESTAMPS[i - 1];
    if (ts in teams["100"].teamStats) continue;
    for (const teamId of ["100", "200"]) {
      teams[teamId].teamStats[ts] = { ...teams[teamId].teamStats[prev] };
      for (const position of POSITIONS) {
        const participant = teams[teamId].participants[position];
        participant.timeline[ts] = { ...participant.timeline[prev] };
      }
    }
  }

  return {
    record: {
      queueId: info.queueId,
      gameVersion: info.gameVersion,
      patchMajor,
      patchMinor,
      gameDurationSec: info.gameDuration,
      gameStartTimestampMs: info.gameStartTimestamp,
      teams,
    },
  };
}

function applyEvent(event, kda, byParticipantId, teamStats) {
  if (event.type === "CHAMPION_KILL") {
    if (event.killerId && kda[event.killerId]) {
      kda[event.killerId].kills++;
      teamStats[byParticipantId[event.killerId].teamId].totalKills++;
    }
    if (event.victimId && kda[event.victimId]) {
      kda[event.victimId].deaths++;
      teamStats[byParticipantId[event.victimId].teamId].totalDeaths++;
    }
    for (const assistId of event.assistingParticipantIds ?? []) {
      if (kda[assistId]) {
        kda[assistId].assists++;
        teamStats[byParticipantId[assistId].teamId].totalAssists++;
      }
    }
  } else if (event.type === "BUILDING_KILL") {
    // Reference semantics (LoLDraftAI): credit the event's teamId bucket
    // as-is. Consistent across the corpus, which is what training needs.
    if (event.buildingType === "TOWER_BUILDING") teamStats[event.teamId].towerKills++;
    else if (event.buildingType === "INHIBITOR_BUILDING") teamStats[event.teamId].inhibitorKills++;
  } else if (event.type === "ELITE_MONSTER_KILL") {
    const bucket = teamStats[event.killerTeamId];
    if (!bucket) return;
    if (event.monsterType === "BARON_NASHOR") bucket.baronKills++;
    else if (event.monsterType === "DRAGON") bucket.dragonKills++;
    else if (event.monsterType === "RIFTHERALD") bucket.riftHeraldKills++;
  }
}
