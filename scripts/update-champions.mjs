#!/usr/bin/env node

/**
 * Fetches champion data from Riot Data Dragon + Meraki Analytics CDN and
 * MERGES it into frontend/src/data/champions.json (design § 5 of
 * docs/designs/champion-meta-positions-refresh-design.md):
 *
 *   - an id already in the file keeps every refresh-owned field (`positions`,
 *     `playable`, the root `positionsSource` block); DDragon owns `name`,
 *     `version` and `updatedAt`;
 *   - a DDragon id not in the file is added with Meraki's positions (or [] —
 *     then hand-enter positions: the compile refuses an empty list);
 *   - an id DDragon no longer returns is kept and reported for the operator to
 *     reconcile by hand — never dropped, never duplicated.
 *
 * Usage: pnpm update-champions [-- --in PATH] [-- --out PATH]
 * Then:  node scripts/refresh-champion-positions.mjs (when the corpus is here)
 *        node scripts/compile-champion-meta.mjs && node scripts/validate-compiled-data.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { normalize } from "./lib/fetch-utils.mjs";
import { assertChampionRows } from "./champion-positions/invariants.mjs";
import { mergeChampionRows } from "./champion-positions/merge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAMPIONS_PATH = join(__dirname, "..", "frontend", "src", "data", "champions.json");

const DDRAGON_VERSIONS_URL = "https://ddragon.leagueoflegends.com/api/versions.json";
const DDRAGON_CHAMPIONS_URL = (version) =>
    `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`;
const MERAKI_CHAMPIONS_URL =
    "https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/champions.json";

async function fetchJson(url, label) {
    console.log(`Fetching ${label}...`);
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to fetch ${label}: ${res.status} ${res.statusText}`);
    }
    return res.json();
}

async function main() {
    const { values } = parseArgs({
        options: {
            in: { type: "string", default: CHAMPIONS_PATH },
            out: { type: "string" },
        },
    });
    const outPath = values.out ?? values.in;
    const existing = JSON.parse(readFileSync(values.in, "utf-8"));

    // 1. Get latest Data Dragon version
    const versions = await fetchJson(DDRAGON_VERSIONS_URL, "Data Dragon versions");
    const version = versions[0];
    console.log(`Latest Data Dragon version: ${version}`);

    // 2. Fetch Data Dragon champion list
    const ddragonData = await fetchJson(DDRAGON_CHAMPIONS_URL(version), "Data Dragon champions");
    const ddragonChamps = Object.values(ddragonData.data).map((dd) => ({ id: dd.id, name: dd.name }));
    console.log(`Data Dragon champions: ${ddragonChamps.length}`);

    // 3. Fetch Meraki position data (used only for ids being added)
    const merakiData = await fetchJson(MERAKI_CHAMPIONS_URL, "Meraki Analytics champions");
    const merakiByName = new Map();
    for (const champ of Object.values(merakiData)) {
        merakiByName.set(normalize(champ.name), { positions: champ.positions ?? [] });
    }
    console.log(`Meraki champions: ${merakiByName.size}`);

    // 4. Merge
    const { champions, added, vanished, missingFromMeraki } = mergeChampionRows({
        existing: existing.champions,
        ddragon: ddragonChamps,
        merakiByName,
    });

    // 5. Invariants before the single write (design § 5): unique ids, unique
    //    names, output count == input count + genuinely new ids. Empty positions
    //    are allowed here (a brand-new champion) and refused by the compile.
    assertChampionRows(champions, {
        label: "update-champions",
        expectedCount: existing.champions.length + added.length,
        requirePositions: false,
    });

    // 6. Write: DDragon owns version/updatedAt; every other root key
    //    (positionsSource, anything a later script adds) is carried through.
    const { version: _version, updatedAt: _updatedAt, champions: _rows, ...rest } = existing;
    const output = {
        version,
        updatedAt: new Date().toISOString().split("T")[0],
        ...rest,
        champions,
    };
    writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
    console.log(`\nWrote ${outPath}`);
    console.log(`  Version: ${version}`);
    console.log(`  Champions: ${champions.length} (${existing.champions.length} existing + ${added.length} new)`);

    if (added.length > 0) {
        console.log(`\nAdded: ${added.join(", ")}`);
    }
    if (missingFromMeraki.length > 0) {
        console.log(`\n⚠ Added without Meraki position data (positions: []) — hand-enter positions before compiling:`);
        for (const name of missingFromMeraki) console.log(`  - ${name}`);
    }
    if (vanished.length > 0) {
        console.log(`\n⚠ OPERATOR ACTION: ${vanished.length} id(s) in the file are no longer returned by Data Dragon and were KEPT: ${vanished.join(", ")}`);
        console.log(`  Reconcile by hand (a renamed/recased id also shows up under "Added").`);
    }

    // 7. Log position coverage
    const withPositions = champions.filter((c) => c.positions.length > 0).length;
    console.log(`\nPosition coverage: ${withPositions}/${champions.length}`);
}

main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
});
