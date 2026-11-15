/**
 * Optional stage-end linked-name resolution. Member/user data lives only in the
 * sync-local state and is never persisted, logged, or included in the summary.
 */
const defaultRequests = require("./requests");
const { derivePlayedPlayers, timeOf } = require("./derive");
const { EsclubRequestCapReached, EsclubBudgetExhausted, EsclubProtocolChanged } = require("./errors");
const LOOKUP_LIMIT = 120;

/** Sync-local caches shared across stages, discarded when the sync ends. */
function newNameState() {
  return { users: new Set(), lists: new Map(), stopped: false };
}

/** A named row is final in S2b; a no-match is retried only after a newer game. */
function isWanted(player, row) {
  return !player.named && (!row || (row.game_name === null && player.latest > new Date(row.checked_at).getTime()));
}

function stopReason(error) {
  if (error instanceof EsclubRequestCapReached) return "names: request cap";
  if (error instanceof EsclubBudgetExhausted) return "names: daily budget";
  if (error instanceof EsclubProtocolChanged) return "names: EsclubProtocolChanged";
  return null;
}

/**
 * Resolve wanted team players. Every request uses the sync's counted client;
 * writes and roster replacements share one fenced transaction per team.
 * @param {import("./client").EsclubClient} client
 * @param {object} args
 * @param {{id: string}} args.tournament
 * @param {{id: string}} args.stage
 * @param {object} args.store
 * @param {object} args.summary counts only
 * @param {typeof defaultRequests} [args.requests]
 * @param {() => Date} [args.now]
 * @param {ReturnType<typeof newNameState>} [args.nameState]
 * @returns {Promise<void>}
 */
async function fillPlayerNames(client, { tournament, stage, store, summary,
  requests = defaultRequests, now = () => new Date(), nameState = newNameState() }) {
  if (nameState.stopped) return;
  const { inputs, rows } = await store.inTransaction(async (transaction) => ({
    inputs: await store.loadStageTeamPlayers(tournament.id, stage.id, transaction),
    rows: await store.loadPlayerNames(tournament.id, transaction),
  }), summary.syncId);
  const names = new Map(rows.map((row) => [row.player_key, row]));
  const facts = new Map(inputs.allTeams.map((team) => [team.id, derivePlayedPlayers(team.entries)]));
  const wantedFor = (team) => [...facts.get(team.id)].filter(([key, player]) => isWanted(player, names.get(key))).map(([key]) => key);
  const teams = inputs.teams.map((team) => ({ team, count: wantedFor(team).length }))
    .sort((a, b) => b.count - a.count);

  for (const { team } of teams) {
    const wanted = wantedFor(team);
    if (!wanted.length) continue;
    const matches = new Map();
    const remaining = () => wanted.filter((key) => !matches.has(key));
    let stopped = false;
    // Latest series with games, using the newest game time and stable entry order.
    const latest = team.entries.reduce((best, entry) => !best || timeOf(entry.game.playedAt) >= timeOf(best.game.playedAt) ? entry : best, null);
    const read = async (seriesId) => {
      let members = nameState.lists.get(seriesId);
      if (!members) {
        const reply = await requests.fetchSerieRosterPlayers(client, { id_serie: seriesId });
        summary.nameMemberLists++;
        members = reply.members;
        nameState.lists.set(seriesId, members);
      }
      for (const member of members) {
        if (!remaining().length) break;
        if (member.id_parent !== team.external_id || nameState.users.has(member.id_user)) continue;
        if (summary.nameLookups >= LOOKUP_LIMIT) return false;
        summary.nameLookups++;
        const { accounts } = await requests.fetchRiotAccounts(client, { id_user: member.id_user });
        nameState.users.add(member.id_user);
        for (const account of accounts) {
          if (!inputs.allKeys.has(account.accountKey) || names.get(account.accountKey)?.game_name != null || matches.has(account.accountKey)) continue;
          matches.set(account.accountKey, { game_name: account.gameName, tag_line: account.tagLine });
        }
      }
      return true;
    };
    try {
      if (!await read(latest.seriesId)) stopped = true;
      if (!stopped && remaining().length) {
        const keys = new Set(remaining());
        const extra = team.entries.filter((entry) => {
          if (entry.seriesId === latest.seriesId) return false;
          const side = entry.game.blueSideTeam === entry.teamNumber ? "blue" : "red";
          return Object.values(entry.game.participants).some((p) => p.side === side && keys.has(p.playerKey));
        }).reduce((best, entry) => !best || timeOf(entry.game.playedAt) >= timeOf(best.game.playedAt) ? entry : best, null);
        if (extra && !await read(extra.seriesId)) stopped = true;
      }
      if (stopped) {
        summary.skipped["names: lookup limit"] = (summary.skipped["names: lookup limit"] || 0) + 1;
      }
    } catch (error) {
      const reason = stopReason(error);
      if (!reason) throw error; // transport failures and abandoned ownership stay fatal
      summary.skipped[reason] = (summary.skipped[reason] || 0) + 1;
      stopped = true;
    }
    const checkedAt = now();
    const writes = [...matches].map(([key, name]) => ({ player_key: key, ...name, checked_at: checkedAt }));
    // A partial traversal proves no absence. Only a full read earns no-match rows.
    const unmatched = stopped ? [] : remaining();
    for (const key of unmatched) writes.push({ player_key: key, game_name: null, tag_line: null, checked_at: checkedAt });
    if (writes.length) {
      await store.inTransaction(async (transaction) => {
        await store.upsertPlayerNames(tournament.id, writes, transaction);
        for (const changedTeam of inputs.allTeams) {
          if ([...matches.keys()].some((key) => facts.get(changedTeam.id).has(key))) {
            await store.rebuildRoster(changedTeam, tournament.id, transaction);
          }
        }
      }, summary.syncId);
      for (const row of writes) names.set(row.player_key, row);
      summary.namesResolved += matches.size;
      summary.namesUnmatched += unmatched.length;
    }
    if (stopped) { nameState.stopped = true; return; }
  }
}

module.exports = { fillPlayerNames, newNameState, isWanted, LOOKUP_LIMIT };
