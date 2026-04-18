import { parentPort } from "worker_threads";
import type { EngineRequest, EngineOutput, DraftState, DraftStateInput, SearchContext } from "./types.js";
import { loadChampionMeta, loadMatchupData } from "./data-loader.js";
import { twoPhaseSearch } from "./two-phase-search.js";

const championMetaFile = loadChampionMeta();
const _matchupDataFile = loadMatchupData();

export function convertDraftState(input: DraftStateInput): DraftState {
  const state: DraftState = {
    blueBans: [],
    redBans: [],
    bluePicks: [],
    redPicks: [],
    turnIndex: 0,
  };

  for (const ban of input.bans) {
    if (ban.side === "blue") state.blueBans.push(ban.championId);
    else state.redBans.push(ban.championId);
  }
  for (const pick of input.picks) {
    if (pick.side === "blue") state.bluePicks.push(pick.championId);
    else state.redPicks.push(pick.championId);
  }

  state.turnIndex = input.bans.length + input.picks.length;

  return state;
}

export function handleRequest(request: EngineRequest): EngineOutput {
  const draftState = convertDraftState(request.draftState);
  const userSide = request.draftState.currentSide;

  const ctx: SearchContext = {
    champions: championMetaFile.champions,
    metaData: request.metaData,
    playerModel: request.playerModel,
    opponentModel: request.opponentModel,
    config: request.config,
    userSide,
  };

  const pool = request.searchPool;
  const { tree, scenarios, meta } = twoPhaseSearch(draftState, pool, ctx, 5);
  return { tree, scenarios, meta };
}

if (parentPort) {
  const port = parentPort;
  port.on("message", (request: EngineRequest) => {
    const output = handleRequest(request);
    port.postMessage(output);
  });
}
