#!/usr/bin/env node

/**
 * Downloads champion square images from Data Dragon and converts to optimized WebP.
 * Reads champion list from frontend/src/data/champions.json (run update-champions first).
 *
 * Usage: pnpm update-images
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, "..", "frontend", "src", "assets");
const CHAMPIONS_JSON = join(__dirname, "..", "frontend", "src", "data", "champions.json");

const CONSTANTS_PATH = join(__dirname, "..", "frontend", "src", "utils", "constants.ts");

const DDRAGON_SQUARE_URL = (version, id) =>
    `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${id}.png`;

// Files in assets/ that are NOT champion squares — never delete these
const PRESERVED_FILES = new Set([
    "BlankSquare.webp",
    "favicon.ico",
    "icon-position-bottom.webp",
    "icon-position-jungle.webp",
    "icon-position-middle.webp",
    "icon-position-support.webp",
    "icon-position-top.webp",
]);

const CONCURRENCY = 10;

async function downloadAndConvert(version, champion) {
    const url = DDRAGON_SQUARE_URL(version, champion.id);
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to fetch ${champion.id}: ${res.status}`);
    }
    const pngBuffer = Buffer.from(await res.arrayBuffer());
    const webpBuffer = await sharp(pngBuffer)
        .resize(120, 120)
        .webp({ quality: 80 })
        .toBuffer();
    const outPath = join(ASSETS_DIR, `${champion.id}Square.webp`);
    writeFileSync(outPath, webpBuffer);
    return { id: champion.id, size: webpBuffer.length };
}

/** Run promises with a concurrency limit */
async function pooled(items, concurrency, fn) {
    const results = [];
    let index = 0;

    async function worker() {
        while (index < items.length) {
            const i = index++;
            results[i] = await fn(items[i], i);
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
}

function cleanOldSquares() {
    const files = readdirSync(ASSETS_DIR);
    let removed = 0;
    for (const file of files) {
        if (PRESERVED_FILES.has(file)) continue;
        if (file.endsWith("Square.webp") || file.endsWith("Square.png")) {
            unlinkSync(join(ASSETS_DIR, file));
            removed++;
        }
    }
    return removed;
}

function generateConstants(champions) {
    // Read existing constants.ts to extract current champion order
    const existingContent = readFileSync(CONSTANTS_PATH, "utf-8");

    // Extract existing champion names in order from the array
    const namePattern = /\{ name: "([^"]+)"/g;
    const existingNames = [];
    // Only match within the champions array section
    const arraySection = existingContent.match(
        /export const champions = \[([\s\S]*?)\]\.map/
    );
    if (arraySection) {
        let match;
        while ((match = namePattern.exec(arraySection[1])) !== null) {
            existingNames.push(match[1]);
        }
    }

    // Build name->champion lookup from champions.json
    const champByName = new Map(champions.map((c) => [c.name, c]));

    // Preserve existing order, filter out removed champions
    const ordered = existingNames
        .filter((name) => champByName.has(name))
        .map((name) => champByName.get(name));

    // Append new champions (not in existing order) alphabetically
    const existingSet = new Set(existingNames);
    const newChamps = champions
        .filter((c) => !existingSet.has(c.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    ordered.push(...newChamps);

    if (newChamps.length > 0) {
        console.log(`\nNew champions appended: ${newChamps.map((c) => c.name).join(", ")}`);
    }

    // Generate import lines
    const imports = ordered
        .map((c) => `import ${c.id} from "/src/assets/${c.id}Square.webp";`)
        .join("\n");

    // Generate champions array
    const entries = ordered
        .map((c) => `    { name: "${c.name}", img: ${c.id} }`)
        .join(",\n");

    // Find manual section (everything after the marker or after sortOptions)
    const marker = "// --- GENERATED ABOVE / MANUAL BELOW ---";
    let manualSection;
    const markerIndex = existingContent.indexOf(marker);
    if (markerIndex !== -1) {
        manualSection = existingContent.slice(markerIndex + marker.length).trimStart();
    } else {
        // First run: find sortOptions as the boundary
        const sortIndex = existingContent.indexOf("export const sortOptions");
        if (sortIndex === -1) {
            throw new Error("Cannot find manual section boundary in constants.ts");
        }
        manualSection = existingContent.slice(sortIndex);
    }

    // Assemble
    const generated = `${imports}

import championData from "../data/champions.json";

// Build name->positions lookup from generated data
const positionsByName = new Map<string, string[]>(
    championData.champions.map((c) => [c.name, c.positions])
);

export const champions = [
${entries}
].map((c) => ({ ...c, positions: positionsByName.get(c.name) ?? [] }));

${marker}

${manualSection}`;

    writeFileSync(CONSTANTS_PATH, generated);
    console.log(`\nGenerated ${CONSTANTS_PATH}`);
    console.log(`  ${ordered.length} champions (${newChamps.length} new)`);
}

async function main() {
    // 1. Read champion data
    const data = JSON.parse(readFileSync(CHAMPIONS_JSON, "utf-8"));
    const { version, champions } = data;
    console.log(`Data Dragon version: ${version}`);
    console.log(`Champions to download: ${champions.length}`);

    // 2. Clean old champion square files
    const removed = cleanOldSquares();
    console.log(`Removed ${removed} old square files`);

    // 3. Download and convert
    console.log(`Downloading from DDragon (concurrency: ${CONCURRENCY})...`);
    const results = await pooled(champions, CONCURRENCY, async (champ, i) => {
        const result = await downloadAndConvert(version, champ);
        // Progress indicator every 20 champions
        if ((i + 1) % 20 === 0 || i + 1 === champions.length) {
            console.log(`  ${i + 1}/${champions.length}`);
        }
        return result;
    });

    // 4. Summary
    const totalBytes = results.reduce((sum, r) => sum + r.size, 0);
    const sorted = [...results].sort((a, b) => b.size - a.size);
    console.log(`\nDone!`);
    console.log(`  Total: ${(totalBytes / 1024).toFixed(0)} KB (${results.length} images)`);
    console.log(`  Average: ${(totalBytes / results.length / 1024).toFixed(1)} KB`);
    console.log(`  Largest: ${sorted[0].id} (${(sorted[0].size / 1024).toFixed(1)} KB)`);
    console.log(`  Smallest: ${sorted[sorted.length - 1].id} (${(sorted[sorted.length - 1].size / 1024).toFixed(1)} KB)`);

    // 5. Generate constants.ts
    generateConstants(champions);
}

main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
});
