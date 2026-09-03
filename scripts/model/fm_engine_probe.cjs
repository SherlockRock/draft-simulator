#!/usr/bin/env node
// Exploration tooling (fm_explore.py --engine): feed one EngineRequest JSON on
// stdin to the prebuilt engine-node binding and print the EngineResponse JSON.
// Never touches the dev servers — it loads packages/engine-node/index.node in
// this process, exactly the artifact backend/services/navigatorEngine.js loads.
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const { Engine, CancelToken } = require(path.join(root, "packages", "engine-node"));

const options = {
  championMetaPath: path.join(root, "data", "compiled", "champion-meta.json"),
  matchupDataPath: path.join(root, "data", "compiled", "matchup-data.json"),
};
if (process.env.NAVIGATOR_FM !== "off") {
  options.fmWeightsPath = path.join(root, "data", "compiled", "fm-weights.json");
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", async () => {
  const engine = Engine.create(options);
  process.stderr.write(`[fm_engine_probe] fm: ${engine.fmStatus()}\n`);
  const response = await engine.compute(raw, new CancelToken());
  process.stdout.write(response);
});
