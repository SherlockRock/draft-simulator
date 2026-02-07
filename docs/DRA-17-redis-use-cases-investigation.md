# DRA-17: Redis Use Cases Investigation

**Issue**: Identify where Redis could optimize flows to minimize costs ahead of release
**Status**: Investigation complete
**Linear**: [DRA-17](https://linear.app/draft-simulator/issue/DRA-17/investigate-redis-use-cases)

---

## Current Architecture Summary

The backend is a single Express + Socket.io instance backed by PostgreSQL. All real-time state lives in JavaScript `Map` objects — if the process restarts, active versus sessions, draft states, and heartbeat tracking are lost. Every authenticated request performs a `User.findByPk()` database query. There is no caching layer, no rate limiting, and no support for running multiple backend instances.

---

## Finding 1: In-Memory State Has No Persistence or Scaling Path

**Severity: High**

Three services store critical real-time state in JavaScript Maps that are lost on process restart and cannot be shared across instances:

### `backend/services/versusStateManager.js`
- **`versusStates` Map** (line 5): Stores per-draft state — current pick index, timer, pause state, ready status, hovered champions, pick change requests
- All of this is lost on server restart mid-draft — users would see the draft freeze with no recovery

### `backend/services/versusSessionManager.js`
- **`sessions` Map** (line 13): Stores who is connected to each versus draft, their roles, and socket mappings
- Role assignments (who is blue/red captain) exist only in memory — a restart during a draft means roles must be re-claimed

### `backend/services/heartbeatManager.js`
- **Three Maps** (lines 5-7): `clients` (socket data), `usersByRole` (role tracking), `userSockets` (multi-tab tracking)
- A 10-second interval checks for stale connections (line 11), iterating all entries
- This is the most volatile — entirely socket-lifecycle dependent

**Redis opportunity**: Store all three as Redis hashes/keys with TTLs. Drafts auto-expire when abandoned. State survives restarts. Multiple instances can read/write the same state.

```
versus:state:{draftId}         -> JSON of draft state (TTL: 2h)
versus:session:{draftId}       -> JSON of participants + roles (TTL: 2h)
heartbeat:{socketId}           -> JSON {userId, role, lastHeartbeat} (TTL: 5m)
heartbeat:user:{userId}:socks  -> Set of socketIds
```

---

## Finding 2: Every Auth Check Hits the Database

**Severity: High**

`backend/middleware/auth.js` (line 15) calls `User.findByPk(decoded.id)` on every request that uses `protect` or `optionalAuth`. The JWT is already verified at that point — the DB query is just fetching the user profile.

This affects every authenticated API call and every socket connection handshake. In a draft with active participants, this means repeated identical queries for the same small set of users.

**Quantifying the cost**: In an active versus session, each user's browser makes API calls for draft state, participant lists, and activity. With 2 captains + spectators, this could be 10-20+ `User.findByPk` calls per minute per draft — all returning the same rows.

**Redis opportunity**: Cache user profiles after JWT verification with a short TTL.

```
user:{userId} -> JSON user profile (TTL: 5 min)
```

Invalidate on profile update (rare). This would eliminate ~90% of user table reads. Implementation is straightforward — add a cache check before `User.findByPk` in `getUserFromRequest()`.

---

## Finding 3: Timer Service Polls All Active Drafts Every Second

**Severity: Medium**

`backend/services/versusTimerService.js` runs a `setInterval` every 1 second (line 20) that iterates all active draft IDs and checks if any timer has expired (lines 28-56). With many concurrent drafts, this becomes an O(n) operation running 60 times per minute.

The timer also can't coordinate across instances — if two backend instances are running, both would try to auto-lock the same expired pick.

**Redis opportunity**: Use Redis key expiration + keyspace notifications instead of polling. Set a key with a TTL equal to the remaining pick time. When Redis expires it, a notification triggers the auto-lock — no polling needed.

```
versus:timer:{draftId} -> {team, pickIndex} (TTL: remaining seconds)
```

Alternatively, use a Redis sorted set with expiration timestamps as scores and poll that instead — one `ZRANGEBYSCORE` vs iterating all states.

---

## Finding 4: No Rate Limiting Exists

**Severity: Medium**

There is zero rate limiting on any endpoint or socket event. High-risk targets include:

- **`POST /api/auth/google/callback`** — OAuth token exchange, no IP-based throttle
- **Socket events** (`lockInPick`, `versusPick`, `requestPause`) — could be spammed by a malicious client
- **`POST /api/versus-drafts`** — draft creation has no throttle
- **`POST /api/canvas/:id/import/series`** — heavy import operation

**Redis opportunity**: Redis is the standard backing store for rate limiters. A simple sliding-window counter per user/IP:

```
ratelimit:{userId}:{action} -> count (TTL: window duration)
```

Libraries like `rate-limiter-flexible` support Redis out of the box and integrate as Express middleware.

---

## Finding 5: Socket.io Can't Scale to Multiple Instances

**Severity: Medium (becomes High at scale)**

Socket.io room broadcasts (e.g., canvas updates, versus state changes) only reach sockets connected to the current process. If the backend scaled to 2+ instances behind a load balancer, users on different instances would not receive each other's events.

**Redis opportunity**: The `@socket.io/redis-adapter` package is a drop-in solution. It uses Redis Pub/Sub so that `io.to(room).emit(...)` broadcasts across all instances. This is the standard approach and requires minimal code changes — just configure the adapter in `backend/index.js`.

```js
const { createAdapter } = require("@socket.io/redis-adapter");
io.adapter(createAdapter(pubClient, subClient));
```

---

## Finding 6: Repeated Query Patterns Could Benefit From Caching

**Severity: Low-Medium**

Several queries are repeated frequently with the same parameters:

| Query | Location | Trigger |
|-------|----------|---------|
| `VersusDraft.findAll` for user's drafts | `routes/versus.js:14-24` | Every time user visits dashboard |
| Canvas with all drafts/connections/groups | `routes/canvas.js:95-113` | Every canvas page load (3 queries) |
| `VersusDraft.findOne` with includes | `socketHandlers/versusHandlers.js:34-43` | Every `versusJoin` event |
| Full draft lookup during pick validation | `socketHandlers/versusHandlers.js:722-764` | Every pick attempt |

These are read-heavy and change infrequently relative to how often they're read. Canvas data in particular requires 3 separate queries (drafts, connections, groups) on every load.

**Redis opportunity**: Cache query results with short TTLs and invalidate on writes.

```
cache:user:{userId}:versus-drafts  -> JSON array (TTL: 2 min)
cache:canvas:{canvasId}:full       -> JSON bundle (TTL: 1 min)
cache:versus-draft:{id}:full       -> JSON with includes (TTL: 1 min)
```

The invalidation logic adds complexity. This is lower priority than the other findings — only worth it if DB load becomes a measured bottleneck.

---

## Cost-Benefit Analysis

### Redis Hosting Cost

A managed Redis instance (e.g., AWS ElastiCache `cache.t3.micro`) runs ~$12-15/month. A self-hosted Redis on the same server as the app costs nothing beyond memory (the data set here would be <50MB even with hundreds of concurrent users).

### What Redis Buys

| Capability | Without Redis | With Redis |
|------------|--------------|------------|
| Server restart during draft | State lost, draft breaks | State recovered, draft continues |
| Multiple backend instances | Not possible | Fully supported via adapter + shared state |
| Auth DB load | 1 query per request | ~90% cache hits |
| Rate limiting | None (abuse possible) | Per-user/IP throttling |
| Timer coordination | Single-instance polling | Distributed, event-driven |
| Draft state durability | In-memory only | Persisted with auto-expiry |

### What Redis Costs (beyond hosting)

- New infrastructure dependency to manage
- Cache invalidation complexity for query caching (Finding 6)
- Serialization overhead for state objects (Findings 1, 2)
- Need to handle Redis connection failures gracefully (fallback to direct DB)

---

## Recommended Priority Order

### Tier 1 — High Impact, Low Complexity
1. **Socket.io Redis adapter** (Finding 5) — near zero code changes, unlocks horizontal scaling
2. **User profile caching in auth middleware** (Finding 2) — single file change, large DB load reduction

### Tier 2 — High Impact, Medium Complexity
3. **Versus state persistence** (Finding 1) — replace Map-based stores with Redis-backed equivalents. Most complex change but eliminates the biggest reliability gap (state loss on restart)
4. **Rate limiting** (Finding 4) — use `rate-limiter-flexible` with Redis store, add as Express middleware

### Tier 3 — Medium Impact, Higher Complexity
5. **Timer service redesign** (Finding 3) — replace polling with Redis key expiration. Worth doing when Tier 1-2 are in place
6. **Query result caching** (Finding 6) — only if DB performance becomes a measured problem. Adds cache invalidation complexity that may not be justified yet

---

## Decision Point

The core question is whether Redis is worth adding as a dependency **now** vs later:

- **If the app will remain single-instance for the foreseeable future**: Tier 1 item #2 (auth caching) could be done with a simple in-memory LRU cache (e.g., `Map` with TTL) instead of Redis. The state loss on restart (Finding 1) is annoying but not catastrophic for a small user base.
- **If multi-instance deployment or reliability matters**: Redis is effectively required. Findings 1, 2, 4, and 5 all point to it, and the alternative (sticky sessions + graceful shutdown + in-memory caching) is more complex than just adding Redis.

For a release-ready product, Redis earns its keep primarily through Finding 5 (scaling) and Finding 1 (state durability). These aren't optimizations — they're reliability requirements.
