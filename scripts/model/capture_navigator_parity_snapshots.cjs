#!/usr/bin/env node
// Captures the frontend's engine-parity fixtures (frontend/src/utils/__fixtures__/
// navigator-item{4,5}-shares-snapshot.json) from the prebuilt engine-node binding:
// the two smoke states of docs/plans/2026-09-06-navigator-columns-smoke/smoke.cjs
// (item4 = EUW1_7957730194 with its real bans, item5 = the tour state with
// ADC-only bans), 19 events each so the engine computes red's last pick, through
// the SAME request the backend built for them (backend/services/navigatorEngine.js
// buildEngineRequest, ported verbatim): the smoke chose "Red Side" and "Load
// defaults for both", so both pools are the frontend's default role pools — every
// champion listed in a role, in the constants.ts list order (alphabetical, the
// codegen's appended rows last) — with `search` = the flattened display, ourSide
// red, the production search config and phase weights. The capture carries the
// response's `tree` and `scenarios` — what navigatorRoles.test.ts reads — and
// nothing that varies run to run (no computeTimeMs), so a re-capture on the same
// binding and table is byte-identical.
//
//   node scripts/model/capture_navigator_parity_snapshots.cjs [--out <dir>] [item4 item5]
//
// ENGINE_NODE_DIR      another worktree's packages/engine-node (default: this one's)
// CHAMPION_META_PATH   another compiled table (default: data/compiled/champion-meta.json)
// CHAMPIONS_JSON_PATH  the champions.json the default pools are built from (default:
//                      frontend/src/data/champions.json; the frozen fixture to reproduce
//                      a capture made on an older table)
// NAVIGATOR_FM=off     boot without the FM evaluator, as the backend's switch does
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const engineDir = process.env.ENGINE_NODE_DIR || path.join(root, "packages", "engine-node");
const { Engine, CancelToken } = require(engineDir);
const { TURN_SEQUENCE, currentTurn } = require(path.join(root, "backend", "utils", "navigatorTurns.js"));

// smoke.cjs orderEvents: b,r,b,r,b,r bans | B1 R1 R2 B2 B3 R3 | r,b,r,b bans | R4 B4 B5.
function orderEvents({ blueBans, redBans, bluePicks, redPicks }) {
  const [b0, b1, b2, b3, b4] = blueBans;
  const [r0, r1, r2, r3, r4] = redBans;
  const [B1, B2, B3, B4, B5] = bluePicks;
  const [R1, R2, R3, R4] = redPicks;
  return [b0, r0, b1, r1, b2, r2, B1, R1, R2, B2, B3, R3, r3, b3, r4, b4, R4, B4, B5];
}

// The smoke typed display names into the palette; the wire carries champion ids.
const ID_OF = { "Twisted Fate": "TwistedFate", "Kai'Sa": "Kaisa" };
const idOf = (name) => ID_OF[name] || name;

const FIXTURES = {
  item4: {
    file: "navigator-item4-shares-snapshot.json",
    note: "EUW1_7957730194, real bans in ban-turn order; red picks last (slot 19)",
    events: orderEvents({
      blueBans: ["Hecarim", "Gangplank", "Malzahar", "Viktor", "Pyke"],
      redBans: ["Nasus", "Fiora", "Nautilus", "Seraphine", "Yasuo"],
      bluePicks: ["Camille", "Elise", "Mel", "Xayah", "Sona"],
      redPicks: ["Ornn", "Sylas", "Twisted Fate", "Ezreal"],
    }),
  },
  item5: {
    file: "navigator-item5-shares-snapshot.json",
    note: "the tour state, ADC-only bans so red's last-pick candidates are untouched (slot 19)",
    events: orderEvents({
      blueBans: ["Ashe", "Caitlyn", "Jinx", "Draven", "Zeri"],
      redBans: ["Twitch", "Jhin", "Kai'Sa", "Aphelios", "Sivir"],
      bluePicks: ["Gragas", "Hecarim", "Akali", "Xayah", "Shen"],
      redPicks: ["Sejuani", "Sylas", "Lissandra", "Tristana"],
    }),
  },
};

// backend/services/navigatorEngine.js DEFAULT_PHASE_WEIGHTS, AB_COMPUTE_BUDGET_MS, EMPTY_POOL
const DEFAULT_PHASE_WEIGHTS = {
  blue: {
    ban1: { comp: 0.35, info: 0.65, coverage: 0.0 },
    pick1: { comp: 0.5, info: 0.5, coverage: 0.3 },
    ban2: { comp: 0.6, info: 0.4, coverage: 0.4 },
    pick2: { comp: 0.8, info: 0.2, coverage: 1.5 },
  },
  red: {
    ban1: { comp: 0.3, info: 0.7, coverage: 0.0 },
    pick1: { comp: 0.4, info: 0.6, coverage: 0.3 },
    ban2: { comp: 0.5, info: 0.5, coverage: 0.4 },
    pick2: { comp: 0.8, info: 0.2, coverage: 1.5 },
  },
};
const AB_COMPUTE_BUDGET_MS = 5000;

// frontend/src/utils/defaultRolePools.ts getDefaultRolePoolMap: per role, every champion whose
// `positions` lists it, in the order of constants.ts's `champions` list (the generated name list,
// read from the source so an appended row keeps its place); NavigatorSetup.tsx derives
// `search` = flattenDisplayPool(display) (role order, first occurrence); navigatorEngine.js
// toProtocolTeamPool maps the keys to the protocol's.
function defaultPools() {
  const constants = fs.readFileSync(path.join(root, "frontend", "src", "utils", "constants.ts"), "utf-8");
  const list = constants.slice(constants.indexOf("export const champions = ["));
  const names = [...list.slice(0, list.indexOf("];")).matchAll(/\{ name: "([^"]+)"/g)].map((m) => m[1]);
  const table = JSON.parse(fs.readFileSync(process.env.CHAMPIONS_JSON_PATH || path.join(root, "frontend", "src", "data", "champions.json"), "utf-8"));
  const byName = new Map(table.champions.map((c) => [c.name, c]));
  const ordered = names.map((name) => byName.get(name)).filter(Boolean);
  const inRole = (position) => ordered.filter((c) => (c.positions || []).includes(position)).map((c) => c.id);
  const display = { TOP: inRole("TOP"), JUNGLE: inRole("JUNGLE"), MIDDLE: inRole("MIDDLE"), ADC: inRole("BOTTOM"), SUPPORT: inRole("SUPPORT") };
  const search = [...new Set([...display.TOP, ...display.JUNGLE, ...display.MIDDLE, ...display.ADC, ...display.SUPPORT])];
  return { display, search, size: ordered.length };
}

// navigatorEngine.js buildEngineRequest for the smoke's sessions (no exclusions, no forced branches).
function buildEngineRequest(events, pool) {
  const bans = [];
  const picks = [];
  events.forEach((name, slot) => {
    const turn = TURN_SEQUENCE[slot];
    const normalized = { championId: idOf(name), side: turn.side, slot };
    if (turn.type === "ban") bans.push(normalized);
    else picks.push(normalized);
  });
  const turn = currentTurn(events.length);
  if (!turn) throw new Error("the draft is complete");
  return {
    protocolVersion: "1.1.0",
    draftState: {
      format: "standard",
      bans,
      picks,
      currentPhase: turn.phase,
      currentSlot: events.length,
      currentSide: turn.side,
    },
    pools: { ourSide: "red", blue: pool, red: pool, crossGameExclusions: [] },
    opponentModel: { type: "meta", weights: {} },
    playerModel: { championTiers: { core: [], playable: [], emergency: [] }, weights: {} },
    config: {
      search: {
        branchWidth: 5,
        pairBranchWidth: 500,
        singlePairTopK: 32,
        maxDepth: 8,
        broadDepth: 8,
        extensionTurnThreshold: 8,
        latencyBudgetMs: AB_COMPUTE_BUDGET_MS,
      },
      weights: {
        phaseWeights: DEFAULT_PHASE_WEIGHTS,
        penalties: { outOfRole: 0.25, outOfPool: 0.75 },
        synergyMultiplier: 1.0,
        counterMultiplier: 1.0,
        flexRetentionWeight: 1.0,
        revealCostWeight: 1.0,
      },
      profile: "firstpick-default-v1",
      forcedBranches: [],
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  let out = path.join(root, "frontend", "src", "utils", "__fixtures__");
  const which = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = path.resolve(args[++i]);
    else which.push(args[i]);
  }
  const names = which.length ? which : Object.keys(FIXTURES);
  const options = {
    championMetaPath: process.env.CHAMPION_META_PATH || path.join(root, "data", "compiled", "champion-meta.json"),
    matchupDataPath: path.join(root, "data", "compiled", "matchup-data.json"),
  };
  if (process.env.NAVIGATOR_FM !== "off") options.fmWeightsPath = path.join(root, "data", "compiled", "fm-weights.json");
  const engine = Engine.create(options);
  const { display, search, size } = defaultPools();
  process.stderr.write(`[capture] engine ${engineDir}; fm: ${engine.fmStatus()}; meta ${options.championMetaPath}; default pools from ${size} champions, search ${search.length}\n`);
  for (const name of names) {
    const fixture = FIXTURES[name];
    if (!fixture) throw new Error(`unknown fixture ${name}; have ${Object.keys(FIXTURES).join(", ")}`);
    const request = buildEngineRequest(fixture.events, { display, search });
    const response = JSON.parse(await engine.compute(JSON.stringify(request), new CancelToken()));
    if (response.meta && response.meta.cancelled) throw new Error(`${name}: the engine cancelled`);
    const snapshot = {
      source: "capture",
      capturedBy: "scripts/model/capture_navigator_parity_snapshots.cjs",
      fixture: name,
      note: fixture.note,
      events: fixture.events.map(idOf),
      pools: "Load defaults for both (every champion listed in a role, constants.ts order), ourSide red",
      engineId: response.engineId,
      depthReached: response.meta ? response.meta.depthReached : null,
      tree: response.tree,
      scenarios: response.scenarios,
    };
    const file = path.join(out, fixture.file);
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 1) + "\n");
    const children = response.tree.children.map((c) => c.championIds.join("+"));
    process.stderr.write(`[capture] ${name}: ${children.length} root children [${children.join(", ")}], ${response.scenarios.length} scenarios -> ${file}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`capture failed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
