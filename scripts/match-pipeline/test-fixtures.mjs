/**
 * Hand-built minimal Match-V5 fixtures for extractor/processor tests.
 * Shapes mirror the real DTOs (only the fields the extractor reads).
 * Once a live key exists, a fixture-fetch script can replace these with
 * captured real payloads per shape.
 */

export const POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];

export function buildParticipant({ participantId, teamId, teamPosition, championId }) {
  return {
    participantId,
    teamId,
    teamPosition,
    championId,
    win: teamId === 100,
    totalTimeCCDealt: 100 + participantId,
    timeCCingOthers: 20 + participantId,
    totalHealsOnTeammates: 300 + participantId,
    totalHeal: 1000 + participantId,
    totalDamageShieldedOnTeammates: 400 + participantId,
    totalDamageTaken: 15000 + participantId,
    damageSelfMitigated: 9000 + participantId,
  };
}

/**
 * Ten participants: team 100 = pids 1–5 champions 1–5, team 200 = pids 6–10
 * champions 6–10, positions in POSITIONS order on both teams.
 */
export function defaultParticipants() {
  const out = [];
  for (let i = 0; i < 10; i++) {
    out.push(
      buildParticipant({
        participantId: i + 1,
        teamId: i < 5 ? 100 : 200,
        teamPosition: POSITIONS[i % 5],
        championId: i + 1,
      }),
    );
  }
  return out;
}

export function buildMatchDto({
  matchId = "NA1_100",
  queueId = 420,
  gameVersion = "15.16.703.1234",
  gameDuration = 1900,
  gameStartTimestamp = 1_755_700_000_000,
  participants = defaultParticipants(),
  winner = 100,
  bans100 = [201, 202, 203, 204, 205],
  bans200 = [206, 207, -1, 209, 210],
} = {}) {
  return {
    metadata: { matchId },
    info: {
      gameId: 100,
      queueId,
      gameVersion,
      gameDuration,
      gameStartTimestamp,
      participants,
      teams: [
        {
          teamId: 100,
          win: winner === 100,
          bans: bans100.map((championId, pickTurn) => ({ championId, pickTurn: pickTurn + 1 })),
        },
        {
          teamId: 200,
          win: winner === 200,
          bans: bans200.map((championId, pickTurn) => ({ championId, pickTurn: pickTurn + 6 })),
        },
      ],
    },
  };
}

/**
 * Deterministic per-participant frame stats so tests can assert literal values:
 *   totalGold = 500 + pid*10 + minute*100
 *   minionsKilled = minute*8 + pid, jungleMinionsKilled = pid
 *   level = min(18, 1 + floor(minute/2))
 *   magic/physical/true damage = minute*50+pid / minute*60+pid / minute*5
 */
export function frameStats(pid, minute) {
  return {
    participantId: pid,
    level: Math.min(18, 1 + Math.floor(minute / 2)),
    minionsKilled: minute * 8 + pid,
    jungleMinionsKilled: pid,
    totalGold: 500 + pid * 10 + minute * 100,
    damageStats: {
      magicDamageDoneToChampions: minute * 50 + pid,
      physicalDamageDoneToChampions: minute * 60 + pid,
      trueDamageDoneToChampions: minute * 5,
    },
  };
}

/**
 * Frames at 0..minutes inclusive, one per minute. `events` are placed in the
 * first frame whose timestamp >= event.timestamp. `jitterMs` offsets frame
 * timestamps to exercise the rounding the real API exhibits.
 */
export function buildTimelineDto({ minutes = 31, events = [], jitterMs = 0 } = {}) {
  const frames = [];
  for (let m = 0; m <= minutes; m++) {
    const ts = m * 60_000;
    const participantFrames = {};
    for (let pid = 1; pid <= 10; pid++) {
      participantFrames[String(pid)] = frameStats(pid, m);
    }
    frames.push({
      timestamp: ts + (m > 0 ? jitterMs : 0),
      participantFrames,
      events: events.filter(
        (e) => e.timestamp > (m - 1) * 60_000 && e.timestamp <= ts,
      ),
    });
  }
  return { metadata: {}, info: { frameInterval: 60_000, frames } };
}

export const kill = (timestamp, killerId, victimId, assistingParticipantIds = []) => ({
  type: "CHAMPION_KILL",
  timestamp,
  killerId,
  victimId,
  assistingParticipantIds,
});

export const buildingKill = (timestamp, teamId, buildingType = "TOWER_BUILDING") => ({
  type: "BUILDING_KILL",
  timestamp,
  teamId,
  buildingType,
});

export const monsterKill = (timestamp, killerTeamId, monsterType) => ({
  type: "ELITE_MONSTER_KILL",
  timestamp,
  killerTeamId,
  monsterType,
});
