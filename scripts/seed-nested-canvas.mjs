#!/usr/bin/env node
// scripts/seed-nested-canvas.mjs
//
// Seeds the perf fixture for the recursive-groups container-drag gate
// (design §12, plan 5a-2): one container holding N nested child Groups, each
// holding a Card. §12's stated worst case is depth 1, breadth 20–40.
//
// Scripted rather than hand-built on purpose — the gate is meaningless if the
// fixture is not reproducible, and 40 containers is not a thing to build by
// hand twice.
//
// Usage:
//   node scripts/seed-nested-canvas.mjs --canvas=<canvasId>          # 40 children
//   node scripts/seed-nested-canvas.mjs --canvas=<id> --children=20
//   node scripts/seed-nested-canvas.mjs --canvas=<id> --url=postgres://…
//   node scripts/seed-nested-canvas.mjs --canvas=<id> --clean        # remove them
//
// DATABASE_URL is read from the environment when --url is absent. Point this at
// a DEV database: it writes rows.

import { createRequire } from "module";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// pg is a backend dependency and pnpm does not hoist it to the root.
const require = createRequire(join(ROOT, "backend", "package.json"));
const { Client } = require("pg");

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const canvasId = arg("canvas");
const children = Number(arg("children", "40"));
const databaseUrl = arg("url", process.env.DATABASE_URL);

// The container is named distinctively so --clean can find its subtree without
// a manifest file.
const FIXTURE_NAME = "perf-fixture-container";

if (!canvasId) {
    console.error("Missing --canvas=<canvasId>.");
    process.exit(1);
}
if (!databaseUrl) {
    console.error("Missing --url=<postgres url> or DATABASE_URL.");
    process.exit(1);
}
if (!Number.isInteger(children) || children < 1 || children > 200) {
    console.error("--children must be an integer in [1, 200].");
    process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });

const clean = async () => {
    const { rows } = await client.query(
        `SELECT id FROM "CanvasGroups" WHERE canvas_id = $1 AND name = $2`,
        [canvasId, FIXTURE_NAME]
    );
    if (rows.length === 0) {
        console.log("No fixture container on this canvas.");
        return;
    }
    const containerIds = rows.map((r) => r.id);
    // Children first: parent_group_id is NO ACTION, so the container cannot go
    // while anything still points at it.
    const { rows: childRows } = await client.query(
        `SELECT id FROM "CanvasGroups" WHERE parent_group_id = ANY($1)`,
        [containerIds]
    );
    const childIds = childRows.map((r) => r.id);
    const groupIds = [...containerIds, ...childIds];
    const { rows: cardRows } = await client.query(
        `SELECT draft_id FROM "CanvasDrafts" WHERE group_id = ANY($1)`,
        [groupIds]
    );
    await client.query(`DELETE FROM "CanvasDrafts" WHERE group_id = ANY($1)`, [
        groupIds
    ]);
    if (cardRows.length > 0) {
        await client.query(`DELETE FROM "Drafts" WHERE id = ANY($1)`, [
            cardRows.map((r) => r.draft_id)
        ]);
    }
    await client.query(`DELETE FROM "CanvasGroups" WHERE id = ANY($1)`, [childIds]);
    await client.query(`DELETE FROM "CanvasGroups" WHERE id = ANY($1)`, [containerIds]);
    console.log(
        `Removed ${containerIds.length} container(s), ${childIds.length} child group(s), ${cardRows.length} card(s).`
    );
};

const seed = async () => {
    const now = new Date();
    const containerId = randomUUID();
    // Wide enough that every child sits inside it, so the container-sizing memo
    // has the whole subtree to union rather than clamping most of it out.
    const cols = 8;
    const cellW = 440;
    const cellH = 260;
    const rowsNeeded = Math.ceil(children / cols);

    await client.query(
        `INSERT INTO "CanvasGroups"
           (id, canvas_id, name, type, "positionX", "positionY", width, height,
            parent_group_id, metadata, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, 'custom', 0, 0, $4, $5, NULL, $6, $7, $7)`,
        [
            containerId,
            canvasId,
            FIXTURE_NAME,
            cols * cellW + 32,
            rowsNeeded * cellH + 80,
            JSON.stringify({ layout: "free" }),
            now
        ]
    );

    for (let i = 0; i < children; i++) {
        const childId = randomUUID();
        const draftId = randomUUID();
        // ADR-0006: a Group's position is ABSOLUTE world at every depth, so a
        // child of a container at (0,0) is at its own world coordinates.
        const x = 16 + (i % cols) * cellW;
        const y = 60 + Math.floor(i / cols) * cellH;
        await client.query(
            `INSERT INTO "CanvasGroups"
               (id, canvas_id, name, type, "positionX", "positionY", width, height,
                parent_group_id, metadata, "createdAt", "updatedAt")
             VALUES ($1, $2, $3, 'custom', $4, $5, 400, 200, $6, $7, $8, $8)`,
            [
                childId,
                canvasId,
                `perf-child-${i}`,
                x,
                y,
                containerId,
                JSON.stringify({ layout: "free" }),
                now
            ]
        );
        // One Card per child, so the fan-out has Card subtrees to relay out —
        // §12 names the receiving client's Card repositioning as the cost to
        // measure, and an empty child would not exercise it.
        await client.query(
            `INSERT INTO "Drafts" (id, name, public, picks, type, "firstPick",
                                   "blueSideTeam", "createdAt", "updatedAt")
             VALUES ($1, $2, false, $3, 'canvas', 'blue', 1, $4, $4)`,
            [draftId, `perf-card-${i}`, new Array(20).fill(""), now]
        );
        await client.query(
            `INSERT INTO "CanvasDrafts"
               (draft_id, canvas_id, "positionX", "positionY", group_id,
                source_type, is_locked, "createdAt", "updatedAt")
             VALUES ($1, $2, 16, 16, $3, 'canvas', false, $4, $4)`,
            [draftId, canvasId, childId, now]
        );
    }

    console.log(
        `Seeded ${FIXTURE_NAME} (${containerId}) with ${children} nested groups, one card each.`
    );
    console.log("Drag the container and take a performance trace; re-run with");
    console.log("--clean to remove it.");
};

await client.connect();
try {
    await client.query("BEGIN");
    if (flag("clean")) await clean();
    else await seed();
    await client.query("COMMIT");
} catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    process.exitCode = 1;
} finally {
    await client.end();
}
