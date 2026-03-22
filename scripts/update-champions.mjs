#!/usr/bin/env node

/**
 * Fetches champion data from Riot Data Dragon + Meraki Analytics CDN
 * and writes frontend/src/data/champions.json with position (role) data.
 *
 * Usage: pnpm update-champions
 */

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "frontend", "src", "data", "champions.json");

const DDRAGON_VERSIONS_URL = "https://ddragon.leagueoflegends.com/api/versions.json";
const DDRAGON_CHAMPIONS_URL = (version) =>
    `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`;
const MERAKI_CHAMPIONS_URL =
    "https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/champions.json";

/** Normalize a champion name for fuzzy matching between APIs */
function normalize(name) {
    return name.toLowerCase().replace(/[\s'`.&]/g, "");
}

/**
 * Display name overrides — when Data Dragon's name differs from
 * what we want to show in the app (e.g., "Nunu & Willump" → "Nunu").
 */
const DISPLAY_NAME_OVERRIDES = {
    "Nunu & Willump": "Nunu",
};

async function fetchJson(url, label) {
    console.log(`Fetching ${label}...`);
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to fetch ${label}: ${res.status} ${res.statusText}`);
    }
    return res.json();
}

async function main() {
    // 1. Get latest Data Dragon version
    const versions = await fetchJson(DDRAGON_VERSIONS_URL, "Data Dragon versions");
    const version = versions[0];
    console.log(`Latest Data Dragon version: ${version}`);

    // 2. Fetch Data Dragon champion list
    const ddragonData = await fetchJson(DDRAGON_CHAMPIONS_URL(version), "Data Dragon champions");
    const ddragonChamps = Object.values(ddragonData.data);
    console.log(`Data Dragon champions: ${ddragonChamps.length}`);

    // 3. Fetch Meraki position data
    const merakiData = await fetchJson(MERAKI_CHAMPIONS_URL, "Meraki Analytics champions");
    const merakiChamps = Object.values(merakiData);
    console.log(`Meraki champions: ${merakiChamps.length}`);

    // Build Meraki lookup by normalized name
    const merakiByName = new Map();
    for (const champ of merakiChamps) {
        merakiByName.set(normalize(champ.name), champ);
    }

    // 4. Merge: Data Dragon is canonical list, Meraki provides positions
    const missingFromMeraki = [];
    const champions = ddragonChamps
        .map((dd) => {
            const meraki = merakiByName.get(normalize(dd.name));
            if (!meraki) {
                missingFromMeraki.push(dd.name);
            }
            return {
                name: DISPLAY_NAME_OVERRIDES[dd.name] ?? dd.name,
                id: dd.id,
                positions: meraki?.positions ?? [],
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    // 5. Write output
    const output = {
        version,
        updatedAt: new Date().toISOString().split("T")[0],
        champions,
    };

    writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");
    console.log(`\nWrote ${OUTPUT_PATH}`);
    console.log(`  Version: ${version}`);
    console.log(`  Champions: ${champions.length}`);

    if (missingFromMeraki.length > 0) {
        console.log(`\n⚠ Missing from Meraki (no position data):`);
        for (const name of missingFromMeraki) {
            console.log(`  - ${name}`);
        }
    }

    // 6. Log position coverage
    const withPositions = champions.filter((c) => c.positions.length > 0).length;
    console.log(`\nPosition coverage: ${withPositions}/${champions.length}`);
}

main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
});
