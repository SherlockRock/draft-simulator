// Diagnostic for slot-17 R5-missing-from-scenarios bug.
// Runs the engine at the user's reported reproducer state, captures
// depth_reached / nodes_evaluated / compute_time_ms, and walks the
// returned tree to compute the leaf-depth distribution and which slots
// each leaf has reached.

const path = require("path");
const { Engine, CancelToken } = require(path.resolve(
  __dirname,
  "../packages/engine-node",
));
const meta = require(path.resolve(
  __dirname,
  "../data/compiled/champion-meta.json",
));

const CHAMPION_META_PATH = path.resolve(
  __dirname,
  "../data/compiled/champion-meta.json",
);
const MATCHUP_DATA_PATH = path.resolve(
  __dirname,
  "../data/compiled/matchup-data.json",
);

// Build display+search pools by role from production meta. Both sides
// get the full 172-champion roster — the user's actual session pool may
// be more restrictive, but full-pool is the worst case for search budget
// (most candidates → most expensive depth-2 expansion). If full-pool
// reaches depth 2 fine, narrower pools will too.
function buildFullPool() {
  const display = { TOP: [], JUNGLE: [], MIDDLE: [], ADC: [], SUPPORT: [] };
  const search = [];
  for (const id of Object.keys(meta.champions)) {
    const c = meta.champions[id];
    search.push(id);
    const primary = c.positions && c.positions[0];
    if (primary && display[primary]) display[primary].push(id);
  }
  return { display, search };
}

const fullPool = buildFullPool();

// User-reported state: 5/5 bans (placeholder champion ids — content
// doesn't matter as long as they're distinct and not in pick lists),
// blue picks Skarner/Camille/Galio, red picks Azir/Amumu/Jax/Nautilus.
// Ban order per TURN_SEQUENCE: blue,red,blue,red,blue,red (ban1) +
// red,blue,red,blue (ban2) per slots 12-15.
function makeBan(side, slot, championId) {
  return { championId, side, slot };
}
function makePick(side, slot, championId) {
  return { championId, side, slot };
}

// Distinct ban placeholders (must NOT collide with any picked champ).
const banFillers = [
  "Aatrox", "Ahri", "Akali", "Akshan", "Alistar", // ban1 slots 0-4 (5 bans)
  "Annie",                                         // ban1 slot 5
  "Ashe", "Aurelion Sol", "Bard", "Blitzcrank",    // ban2 slots 12-15
];

// Slot order (from navigatorEngine.js TURN_SEQUENCE):
// 0 blue ban, 1 red ban, 2 blue ban, 3 red ban, 4 blue ban, 5 red ban
// 6 blue pick, 7 red pick, 8 red pick, 9 blue pick, 10 blue pick, 11 red pick
// 12 red ban, 13 blue ban, 14 red ban, 15 blue ban
// 16 red pick, 17 blue pick, 18 blue pick, 19 red pick

const bans = [
  makeBan("blue", 0, banFillers[0]),
  makeBan("red", 1, banFillers[1]),
  makeBan("blue", 2, banFillers[2]),
  makeBan("red", 3, banFillers[3]),
  makeBan("blue", 4, banFillers[4]),
  makeBan("red", 5, banFillers[5]),
  makeBan("red", 12, banFillers[6]),
  makeBan("blue", 13, banFillers[7]),
  makeBan("red", 14, banFillers[8]),
  makeBan("blue", 15, banFillers[9]),
];

const picks = [
  makePick("blue", 6, "Skarner"),    // B1
  makePick("red", 7, "Azir"),        // R1
  makePick("red", 8, "Amumu"),       // R2
  makePick("blue", 9, "Camille"),    // B2
  makePick("blue", 10, "Galio"),     // B3
  makePick("red", 11, "Jax"),        // R3
  makePick("red", 16, "Nautilus"),   // R4
  // Slot 17 = blue pick2 pair_start (B4)  ← currentSlot
];

const realEvents = bans.length + picks.length; // 10 + 7 = 17. ✓
console.log(`turn_index = ${realEvents} (expected 17)`);

const request = {
  protocolVersion: "1.0.0",
  draftState: {
    format: "standard",
    bans,
    picks,
    currentPhase: "pick2",
    currentSlot: realEvents,
    currentSide: "blue",
  },
  pools: {
    ourSide: "blue",
    blue: fullPool,
    red: fullPool,
    crossGameExclusions: [],
  },
  opponentModel: { type: "meta", weights: {} },
  playerModel: {
    championTiers: { core: [], playable: [], emergency: [] },
    weights: {},
  },
  config: {
    search: {
      branchWidth: 5,
      pairBranchWidth: 500,
      singlePairTopK: 32,
      maxDepth: 8,
      broadDepth: 8,
      extensionTurnThreshold: 8,
      latencyBudgetMs: 2000,
    },
    weights: {
      phaseWeights: {
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
      },
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

// Mirrors frontend/src/utils/treeSynthesis.ts TURN_SEQUENCE shape needed
// for eventsToConfirmedTurns + remapScenarioPath. Source of truth lives
// at frontend/src/utils/turnSequence.ts.
const TURN_SEQUENCE = [
  { side: "blue", actionType: "ban", phase: "ban1", pairStart: false, pairEnd: false }, // 0
  { side: "red", actionType: "ban", phase: "ban1", pairStart: false, pairEnd: false }, // 1
  { side: "blue", actionType: "ban", phase: "ban1", pairStart: false, pairEnd: false }, // 2
  { side: "red", actionType: "ban", phase: "ban1", pairStart: false, pairEnd: false }, // 3
  { side: "blue", actionType: "ban", phase: "ban1", pairStart: false, pairEnd: false }, // 4
  { side: "red", actionType: "ban", phase: "ban1", pairStart: false, pairEnd: false }, // 5
  { side: "blue", actionType: "pick", phase: "pick1", pairStart: false, pairEnd: false }, // 6
  { side: "red", actionType: "pick", phase: "pick1", pairStart: true, pairEnd: false }, // 7
  { side: "red", actionType: "pick", phase: "pick1", pairStart: false, pairEnd: true }, // 8
  { side: "blue", actionType: "pick", phase: "pick1", pairStart: true, pairEnd: false }, // 9
  { side: "blue", actionType: "pick", phase: "pick1", pairStart: false, pairEnd: true }, // 10
  { side: "red", actionType: "pick", phase: "pick1", pairStart: false, pairEnd: false }, // 11
  { side: "red", actionType: "ban", phase: "ban2", pairStart: false, pairEnd: false }, // 12
  { side: "blue", actionType: "ban", phase: "ban2", pairStart: false, pairEnd: false }, // 13
  { side: "red", actionType: "ban", phase: "ban2", pairStart: false, pairEnd: false }, // 14
  { side: "blue", actionType: "ban", phase: "ban2", pairStart: false, pairEnd: false }, // 15
  { side: "red", actionType: "pick", phase: "pick2", pairStart: false, pairEnd: false }, // 16
  { side: "blue", actionType: "pick", phase: "pick2", pairStart: true, pairEnd: false }, // 17
  { side: "blue", actionType: "pick", phase: "pick2", pairStart: false, pairEnd: true }, // 18
  { side: "red", actionType: "pick", phase: "pick2", pairStart: false, pairEnd: false }, // 19
];

// Mirror of frontend/src/utils/treeSynthesis.ts eventsToConfirmedTurns,
// adapted to the in-script (bans, picks) input shape used to build the
// reproducer.
function buildConfirmedTurns() {
  const all = [
    ...bans.map((b, i) => ({ ...b, event_type: "ban", id: `b${i}`, createdAt: i })),
    ...picks.map((p, i) => ({ ...p, event_type: "pick", id: `p${i}`, createdAt: 100 + i })),
  ];
  // turn-side info needed by trimChildrenByPriority's nodeKey helper.
  for (const e of all) {
    const ti = TURN_SEQUENCE[e.slot];
    e.side = ti.side;
  }
  all.sort((a, b) => a.slot - b.slot);
  const turns = [];
  let i = 0;
  while (i < all.length) {
    const first = all[i];
    const turnInfo = TURN_SEQUENCE[first.slot];
    if (first.event_type === "pick" && turnInfo.pairStart) {
      const second = all[i + 1];
      if (
        second &&
        second.event_type === "pick" &&
        second.side === first.side &&
        second.slot === first.slot + 1 &&
        TURN_SEQUENCE[second.slot]?.pairEnd
      ) {
        turns.push({
          side: first.side,
          actionType: "pick",
          phase: turnInfo.phase,
          championIds: [first.championId, second.championId],
          slots: [first.slot, second.slot],
          pairState: "pair-complete",
        });
        i += 2;
        continue;
      }
    }
    turns.push({
      side: first.side,
      actionType: first.event_type,
      phase: turnInfo.phase,
      championIds: [first.championId],
      slots: [first.slot],
      pairState: "solo",
    });
    i += 1;
  }
  return turns;
}

function spineNodeCount(turns) {
  const last = turns[turns.length - 1];
  if (last?.pairState === "pair-pending") return turns.length - 1;
  return turns.length;
}

// Mirror of treeSynthesis.synthesizeFullTree (only the fields needed for
// path-walk).
function synthesizeFullTree(engineTree, confirmedTurns) {
  let current;
  if (confirmedTurns.length === 0) {
    current = {
      championIds: [...engineTree.championIds],
      actionType: engineTree.actionType,
      side: engineTree.side ?? null,
      children: engineTree.children,
    };
  } else {
    const latest = confirmedTurns[confirmedTurns.length - 1];
    current = {
      championIds: [...latest.championIds],
      actionType: latest.actionType,
      side: latest.side,
      children: engineTree.children,
    };
    for (let i = confirmedTurns.length - 2; i >= 0; i--) {
      const t = confirmedTurns[i];
      current = {
        championIds: [...t.championIds],
        actionType: t.actionType,
        side: t.side,
        children: [current],
      };
    }
  }
  return {
    championIds: [],
    actionType: "ban",
    side: null,
    children: [current],
  };
}

// Mirror of treeSynthesis.remapScenarioPath.
function remapScenarioPath(scenario, confirmedTurns) {
  const spineLength = spineNodeCount(confirmedTurns);
  const spinePrefix =
    spineLength === 0
      ? [{ slot: 0, championIds: [] }]
      : confirmedTurns.slice(0, spineLength).map((t) => ({
          slot: t.slots[0],
          championIds: [...t.championIds],
        }));
  return { ...scenario, treePath: [...spinePrefix, ...scenario.treePath] };
}

function sortedJoin(ids) {
  return [...ids].sort().join("|");
}

function nodeKey(node) {
  return `${node.side ?? "none"}:${node.actionType}:${sortedJoin(node.championIds)}`;
}

function pathStepsToKeyPathFromRoot(root, steps) {
  const keys = [];
  let node = root;
  for (const step of steps) {
    const stepKey = sortedJoin(step.championIds);
    const child = node.children.find((c) => sortedJoin(c.championIds) === stepKey);
    if (!child) return keys;
    keys.push(nodeKey(child));
    node = child;
  }
  return keys;
}

function walkSpine(root, depth) {
  let node = root;
  for (let i = 0; i < depth; i++) {
    node = node.children[0];
    if (!node) return null;
  }
  return node;
}

// Mirror of treeSynthesis.trimChildrenByPriority — post-B version.
function trimChildrenByPriority(children, keyPath, priority, branchWidth) {
  const segmentsAtDepth = new Set();
  for (const path of priority.scenarioKeyPaths) {
    if (path === "") continue;
    const seg = path.split(">")[keyPath.length];
    if (seg !== undefined) segmentsAtDepth.add(seg);
  }
  const ranked = children.map((child) => {
    const key = nodeKey(child);
    let rank = 3;
    if (segmentsAtDepth.has(key)) rank = 0;
    return { child, rank, score: child.scores?.composite ?? 0 };
  });
  const rankZero = ranked.filter((r) => r.rank === 0);
  const rest = ranked
    .filter((r) => r.rank !== 0)
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : b.score - a.score));
  const fillCount = Math.max(0, branchWidth - rankZero.length);
  return [...rankZero, ...rest.slice(0, fillCount)].map((r) => r.child);
}

// Mirror of treeReconcile.pathStepsToIndexPath.
function pathStepsToIndexPath(root, steps) {
  const result = [];
  let node = root;
  for (const step of steps) {
    const stepKey = [...step.championIds].sort().join("|");
    const idx = node.children.findIndex(
      (c) => [...c.championIds].sort().join("|") === stepKey,
    );
    if (idx === -1) return { path: null, failedAt: result.length, step };
    result.push(idx);
    node = node.children[idx];
  }
  return { path: result, failedAt: null, step: null };
}

function dumpSyntheticShape(synth) {
  // Walks down spine via children[0] until fanout, reports level-by-level
  // child counts.
  const levels = [];
  let node = synth;
  let depth = 0;
  while (node && node.children && node.children.length > 0) {
    levels.push({ depth, childCount: node.children.length, championIds: node.championIds });
    if (node.children.length === 1) {
      node = node.children[0];
      depth += 1;
    } else {
      // fanout — sample first child
      levels.push({
        depth: depth + 1,
        childCount: node.children[0].children.length,
        sampleChampionIds: node.children[0].championIds,
      });
      break;
    }
  }
  return levels;
}

// Walk the wire tree to (a) collect leaf depth distribution and (b)
// per-leaf last-slot, so we can see whether R5 (slot 19) is reached.
function analyzeTree(root) {
  const leafDepthCounts = new Map();
  const leafSlotCounts = new Map();
  const samples = []; // first few leaves: (depth, slots reached)
  let totalNodes = 0;
  let maxDepth = 0;

  function walk(node, depth, slotsTouched) {
    totalNodes++;
    if (depth > maxDepth) maxDepth = depth;
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    if (!hasChildren) {
      leafDepthCounts.set(depth, (leafDepthCounts.get(depth) || 0) + 1);
      const lastSlot = slotsTouched.length ? slotsTouched[slotsTouched.length - 1] : "(root)";
      leafSlotCounts.set(lastSlot, (leafSlotCounts.get(lastSlot) || 0) + 1);
      if (samples.length < 5) {
        samples.push({ depth, slotsTouched: [...slotsTouched] });
      }
      return;
    }
    for (const child of node.children) {
      const childSlots = Array.isArray(child.slots) ? child.slots : [];
      walk(child, depth + 1, [...slotsTouched, ...childSlots]);
    }
  }

  walk(root, 0, []);
  return { leafDepthCounts, leafSlotCounts, totalNodes, maxDepth, samples };
}

(async () => {
  const engine = Engine.create({
    championMetaPath: CHAMPION_META_PATH,
    matchupDataPath: MATCHUP_DATA_PATH,
  });

  console.log("\n=== Run 1: production config (max_depth=8, budget=2000ms) ===");
  await runOnce(engine, request, "prod-default");

  console.log("\n=== Run 2: longer budget (max_depth=8, budget=10000ms) ===");
  const longBudget = JSON.parse(JSON.stringify(request));
  longBudget.config.search.latencyBudgetMs = 10000;
  await runOnce(engine, longBudget, "long-budget");

  console.log("\n=== Run 3: alpha-beta off (max_depth=8, budget=10000ms) ===");
  const noAb = JSON.parse(JSON.stringify(request));
  noAb.config.search.latencyBudgetMs = 10000;
  // disable_alpha_beta is internal; not in protocol. Skip — keep on.
  // We'll reuse this slot for: smaller pair_branch_width to see if depth grows
  noAb.config.search.pairBranchWidth = 32;
  await runOnce(engine, noAb, "small-pair-width");

  console.log("\n=== Run 4: tiny pool (10 champs/side, max_depth=8, budget=10000ms) ===");
  const tinyPool = JSON.parse(JSON.stringify(request));
  tinyPool.config.search.latencyBudgetMs = 10000;
  // Build a 10-champ-per-side pool that includes the 7 reproducer picks
  // plus enough role coverage to leave ADC + SUP options for blue and ADC
  // option for red.
  const survivors = [
    "Skarner", "Camille", "Galio", "Azir", "Amumu", "Jax", "Nautilus",
    "Jinx", "Caitlyn", "Lulu", "Senna", "Karma", "Kaisa", "Ezreal",
    "Vi", "Lee Sin", "Ahri", "Yasuo",
  ];
  const tinyDisplay = { TOP: [], JUNGLE: [], MIDDLE: [], ADC: [], SUPPORT: [] };
  const tinySearch = [];
  for (const id of survivors) {
    const c = meta.champions[id];
    if (!c) continue;
    tinySearch.push(id);
    const primary = c.positions && c.positions[0];
    if (primary && tinyDisplay[primary]) tinyDisplay[primary].push(id);
  }
  tinyPool.pools.blue = { display: tinyDisplay, search: tinySearch };
  tinyPool.pools.red = { display: tinyDisplay, search: tinySearch };
  await runOnce(engine, tinyPool, "tiny-pool");
})();

async function runOnce(engine, req, label) {
  const token = new CancelToken();
  const t0 = Date.now();
  const respJson = await engine.compute(JSON.stringify(req), token);
  const wallMs = Date.now() - t0;
  const resp = JSON.parse(respJson);
  console.log(`[${label}] wall=${wallMs}ms`);
  console.log(`  meta:`, JSON.stringify(resp.meta));
  console.log(`  scenarios.length = ${resp.scenarios.length}`);
  for (let i = 0; i < resp.scenarios.length; i++) {
    const s = resp.scenarios[i];
    console.log(
      `  scenario[${i}] perspective=${s.perspective} blue=[${s.bluePicks.join(",")}] red=[${s.redPicks.join(",")}]`,
    );
    console.log(`    treePath=${JSON.stringify(s.treePath)}`);
  }

  // Frontend conversion check.
  const turns = buildConfirmedTurns();
  const spineLen = spineNodeCount(turns);
  console.log(`  confirmedTurns.length=${turns.length}, spineLength=${spineLen}`);
  const synth = synthesizeFullTree(resp.tree, turns);
  console.log(`  synthetic shape:`, dumpSyntheticShape(synth));
  const scenarioKeyPathsFanoutRel = [];
  for (let i = 0; i < resp.scenarios.length; i++) {
    const remapped = remapScenarioPath(resp.scenarios[i], turns);
    const result = pathStepsToIndexPath(synth, remapped.treePath);
    if (result.path) {
      console.log(`  scenario[${i}] → path[${result.path.length}]=${result.path.join(",")}`);
      // Build fanout-relative nodeKeyPath for the trim simulation.
      const keys = pathStepsToKeyPathFromRoot(synth, remapped.treePath);
      const fanoutRel = keys.slice(spineLen).join(">");
      scenarioKeyPathsFanoutRel.push(fanoutRel);
    } else {
      console.log(
        `  scenario[${i}] FAILED at step ${result.failedAt}: ${JSON.stringify(result.step)}`,
      );
    }
  }
  console.log(`  scenarioKeyPaths (fanout-relative, ${scenarioKeyPathsFanoutRel.length} entries):`, scenarioKeyPathsFanoutRel);

  // Simulate B's trimChildrenByPriority on the fanout level. branchWidth=5.
  const fanoutParent = walkSpine(synth, spineLen);
  const trimmed = trimChildrenByPriority(
    fanoutParent.children,
    [],
    { scenarioKeyPaths: scenarioKeyPathsFanoutRel, manualExpansionKeyPaths: new Set() },
    5,
  );
  console.log(`  fanout children pre-trim: ${fanoutParent.children.length}, post-trim: ${trimmed.length}`);
  // Verify all scenario-referenced children survive.
  const trimmedKeys = new Set(trimmed.map((c) => sortedJoin(c.championIds)));
  let allSurvived = true;
  for (let i = 0; i < scenarioKeyPathsFanoutRel.length; i++) {
    const seg0 = scenarioKeyPathsFanoutRel[i].split(">")[0];
    // seg0 is full nodeKey (e.g. "blue:pick:Tristana|Ziggs"); extract champion-ids piece.
    const champsStr = seg0.split(":").slice(2).join(":");
    if (trimmedKeys.has(champsStr)) {
      console.log(`    scenario[${i}] survives trim (key=${champsStr})`);
    } else {
      console.log(`    scenario[${i}] DROPPED in trim (key=${champsStr})`);
      allSurvived = false;
    }
  }
  console.log(`  ${allSurvived ? "PASS" : "FAIL"}: all converted scenarios ${allSurvived ? "survive" : "do NOT survive"} the frontend trim.`);
  const analysis = analyzeTree(resp.tree);
  console.log(`  tree totalNodes=${analysis.totalNodes} maxDepth=${analysis.maxDepth}`);
  console.log(
    `  leaf depth distribution:`,
    JSON.stringify(Object.fromEntries(analysis.leafDepthCounts)),
  );
  console.log(
    `  leaf last-slot distribution:`,
    JSON.stringify(Object.fromEntries(analysis.leafSlotCounts)),
  );
  console.log(`  first leaf samples:`, JSON.stringify(analysis.samples));
}
