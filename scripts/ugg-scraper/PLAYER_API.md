# u.gg Per-Player GraphQL — Decode Notes & Gate Verdict

**Decoded:** 2026-06-28 against live u.gg, profile `aeon#na3` (region `na1`).
**Endpoint:** `POST https://u.gg/api` (GraphQL). DIFFERENT API from the meta
scraper (`constants.mjs`/`schema.mjs`, which read static positional JSON from
`stats2.u.gg`). Reuses only `UggFetcher`'s HTTP conventions (via `postJson`).

## GATE VERDICT: **GO** (per-role-query model; recency deferred)

Slice 1's risk is retired. The favorable "role is a single output field, one
request" shape is **FALSE** — but a clean alternative exists and is adopted.

| Success criterion (plan Task 1 §2) | Result |
|---|---|
| Per-champ **role** is an output field | ❌ → **mitigated.** `role` is a SCALAR query input (1..5). Querying role 1..5 (5 requests) yields each role's champ block; flex champs split across roles with role-scoped games/wins. Equivalent outcome at 5 cached/throttled requests. |
| Per-**season** win-rate keying | ✅ `seasonId` scalar input; `totalMatches`/`wins` are season+role scoped. |
| Numeric **region-id** mapping | ✅ *N/A — simpler.* `regionId` is the platform STRING (`"na1"`), passed through. No numeric table. |
| **Recency** derivable | ❌ No per-champ timestamp on this endpoint → **recency dropped from v1** (`lastPlayed: null`, slider inert). Recoverable later by joining `fetchPlayerMatchSummaries` (`matchCreationTime`). |

## Request contract (`operationName: getPlayerStats`)

```
variables: {
  riotUserName: string,   // lowercased gameName
  riotTagLine:  string,   // lowercased tagLine
  regionId:     string,   // platform id, lowercased ("na1","euw1","kr",...)
  role:         Int,      // SCALAR 1..5  → 5 requests for the full pool
  seasonId:     Int,      // current season (26 as of 2026-06-28)
  queueType:    [Int]     // [420] ranked solo (440 = flex; we drop it)
}
```

## Response shape

```
data.fetchPlayerStatistics[]            // one block PER queueType
  queueType: 420 | 440                  // scalar (echoes each requested queue)
  role: 1                               // scalar — the queried role
  seasonId: 26
  basicChampionPerformances[]:
    { championId: <numeric>, totalMatches: <games>, wins: <int>, ... }
```

The extractor keeps the block whose `queueType === 420`, reads that block's
`role`, and maps each performance → `{ numericChampionId, roleId, games, wins }`.
An empty/private profile (or a role the player never plays) returns
`basicChampionPerformances: []`.

## Role enum (confirmed from match-summary cross-reference)

`1 JUNGLE · 2 SUPPORT · 3 BOTTOM→adc · 4 TOP · 5 MIDDLE · 7 ALL` — identical to
`constants.mjs` `ROLE_INDEX`. Canonicalize 3→`adc`, 5→`mid`, etc. to engine roles.

## Filtering proof (role 7 "all" vs role 1 "jungle")

| championId | role 7 (all) | role 1 (jungle) | reading |
|---|---|---|---|
| 64 LeeSin | 133/69 | 133/69 | pure jungle |
| 799 Ambessa | 81/40 | 78/38 | flex — 3 games another role |
| 13 Ryze | 32/12 | absent | mid → filtered out |
| 202 Jhin | 5/1 | absent | adc → filtered out |
| 111 Nautilus | 5/3 | absent | support → filtered out |

## Notes / maintenance

- Format-drift posture identical to the meta scraper (unofficial endpoint).
- Riot id / region are lowercased before sending (u.gg's own client does this).
- `seasonId` and `RANKED_SOLO_QUEUE` are the season/patch-style knobs to bump.
