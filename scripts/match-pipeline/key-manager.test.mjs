import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile, KeyManager, wrapClientWithKeyRotation } from "./key-manager.mjs";
import { silentLogger } from "./test-support.mjs";

test("parseEnvFile parses KEY=value lines, ignoring comments, blanks, and quotes", () => {
  const parsed = parseEnvFile(
    '# collector secrets\nRIOT_API_KEY=RGAPI-abc\n\nDATABASE_URL="postgresql://x"\nEXPORT_DIR=\'/tmp\'\n',
  );
  assert.deepEqual(parsed, {
    RIOT_API_KEY: "RGAPI-abc",
    DATABASE_URL: "postgresql://x",
    EXPORT_DIR: "/tmp",
  });
});

/** In-memory env file the tests can rewrite mid-poll. */
function fakeEnvFile(initialKey) {
  const state = { content: `RIOT_API_KEY=${initialKey}\n` };
  return {
    state,
    setKey: (k) => {
      state.content = `RIOT_API_KEY=${k}\n`;
    },
    readFile: async () => state.content,
  };
}

test("loadKey reads the key from the env file", async () => {
  const file = fakeEnvFile("RGAPI-one");
  const km = new KeyManager({
    envFilePath: "/fake",
    readFile: file.readFile,
    sleep: async () => {},
    logger: silentLogger,
  });
  assert.equal(await km.loadKey(), "RGAPI-one");
  assert.equal(km.state, "ok");
});

test("waitForNewKey polls until the key changes, then resumes", async () => {
  const file = fakeEnvFile("RGAPI-old");
  let polls = 0;
  const km = new KeyManager({
    envFilePath: "/fake",
    readFile: file.readFile,
    sleep: async () => {
      polls++;
      if (polls === 3) file.setKey("RGAPI-new");
    },
    logger: silentLogger,
  });
  await km.loadKey();
  const key = await km.waitForNewKey("RGAPI-old");
  assert.equal(key, "RGAPI-new");
  assert.equal(polls, 3);
  assert.equal(km.state, "ok");
});

test("waitForNewKey reports KEY_EXPIRED state while waiting", async () => {
  const file = fakeEnvFile("RGAPI-old");
  let observedState;
  const km = new KeyManager({
    envFilePath: "/fake",
    readFile: file.readFile,
    sleep: async () => {
      observedState = km.state;
      file.setKey("RGAPI-new");
    },
    logger: silentLogger,
  });
  await km.loadKey();
  await km.waitForNewKey("RGAPI-old");
  assert.equal(observedState, "KEY_EXPIRED");
});

test("waitForNewKey returns immediately when the key already rotated", async () => {
  const file = fakeEnvFile("RGAPI-current");
  let polls = 0;
  const km = new KeyManager({
    envFilePath: "/fake",
    readFile: file.readFile,
    sleep: async () => {
      polls++;
    },
    logger: silentLogger,
  });
  await km.loadKey();
  const key = await km.waitForNewKey("RGAPI-stale-from-before");
  assert.equal(key, "RGAPI-current");
  assert.equal(polls, 0);
});

test("concurrent waiters share one poll loop and both resume", async () => {
  const file = fakeEnvFile("RGAPI-old");
  let polls = 0;
  const km = new KeyManager({
    envFilePath: "/fake",
    readFile: file.readFile,
    sleep: async () => {
      polls++;
      file.setKey("RGAPI-new");
    },
    logger: silentLogger,
  });
  await km.loadKey();
  const [a, b] = await Promise.all([
    km.waitForNewKey("RGAPI-old"),
    km.waitForNewKey("RGAPI-old"),
  ]);
  assert.equal(a, "RGAPI-new");
  assert.equal(b, "RGAPI-new");
  assert.equal(polls, 1);
});

test("abort() rejects a pending waitForNewKey so shutdown never hangs in KEY_EXPIRED", async () => {
  const file = fakeEnvFile("RGAPI-old");
  const km = new KeyManager({
    envFilePath: "/fake",
    readFile: file.readFile,
    // Real-length sleep: without abort this would park forever. Unref'd so
    // the dangling timer doesn't hold the test process open after abort.
    sleep: () => new Promise((r) => setTimeout(r, 60_000).unref()),
    logger: silentLogger,
  });
  await km.loadKey();
  const pending = km.waitForNewKey("RGAPI-old");
  km.abort();
  await assert.rejects(() => pending, /aborted/);
});

test("wrapClientWithKeyRotation retries a 403 with the fresh key", async () => {
  const file = fakeEnvFile("RGAPI-old");
  const km = new KeyManager({
    envFilePath: "/fake",
    readFile: file.readFile,
    sleep: async () => file.setKey("RGAPI-new"),
    logger: silentLogger,
  });
  await km.loadKey();

  const seenKeys = [];
  const raw = {
    apiKey: "RGAPI-old",
    async getMatch(matchId) {
      seenKeys.push(this.apiKey);
      if (this.apiKey === "RGAPI-old") {
        throw new Error("Riot API 403 from https://x: forbidden");
      }
      return { matchId };
    },
  };
  const client = wrapClientWithKeyRotation(raw, km, silentLogger);
  const result = await client.getMatch("NA1_1", "americas");
  assert.deepEqual(result, { matchId: "NA1_1" });
  assert.deepEqual(seenKeys, ["RGAPI-old", "RGAPI-new"]);
  assert.equal(raw.apiKey, "RGAPI-new");
});

test("wrapClientWithKeyRotation passes non-auth errors through", async () => {
  const file = fakeEnvFile("RGAPI-x");
  const km = new KeyManager({
    envFilePath: "/fake",
    readFile: file.readFile,
    sleep: async () => {},
    logger: silentLogger,
  });
  await km.loadKey();
  const raw = {
    apiKey: "RGAPI-x",
    async getMatch() {
      throw new Error("Riot API 404 from https://x");
    },
  };
  const client = wrapClientWithKeyRotation(raw, km, silentLogger);
  await assert.rejects(() => client.getMatch("NA1_1"), /404/);
});

// ---- re-probing a rejected key (a freshly regenerated key can be "Unknown
// apikey" at Riot for its first seconds; the file never changes, so polling
// for a *different* key stranded the collectors on a valid key) ----

test("waitForNewKey resumes with the SAME key once probeKey accepts it", async () => {
  const file = fakeEnvFile("RGAPI-fresh");
  const probeResults = [false, false, true];
  const probed = [];
  const km = new KeyManager({
    envFilePath: "/fake",
    readFile: file.readFile,
    sleep: async () => {},
    probeKey: async (key) => {
      probed.push(key);
      return probeResults.shift();
    },
    logger: silentLogger,
  });
  await km.loadKey();
  const key = await km.waitForNewKey("RGAPI-fresh");
  assert.equal(key, "RGAPI-fresh");
  assert.deepEqual(probed, ["RGAPI-fresh", "RGAPI-fresh", "RGAPI-fresh"]);
  assert.equal(km.state, "ok");
});

test("waitForNewKey prefers a changed key and does not probe it", async () => {
  const file = fakeEnvFile("RGAPI-old");
  let probes = 0;
  const km = new KeyManager({
    envFilePath: "/fake",
    readFile: file.readFile,
    sleep: async () => file.setKey("RGAPI-new"),
    probeKey: async () => {
      probes++;
      return false;
    },
    logger: silentLogger,
  });
  await km.loadKey();
  assert.equal(await km.waitForNewKey("RGAPI-old"), "RGAPI-new");
  assert.equal(probes, 0);
});

test("waitForNewKey treats a probe that throws as not-yet-accepted and keeps polling", async () => {
  const file = fakeEnvFile("RGAPI-fresh");
  let probes = 0;
  const warnings = [];
  const km = new KeyManager({
    envFilePath: "/fake",
    readFile: file.readFile,
    sleep: async () => {},
    probeKey: async () => {
      probes++;
      if (probes === 1) throw new Error("fetch failed: ENOTFOUND");
      return true;
    },
    logger: { ...silentLogger, warn: (m) => warnings.push(m) },
  });
  await km.loadKey();
  assert.equal(await km.waitForNewKey("RGAPI-fresh"), "RGAPI-fresh");
  assert.equal(probes, 2);
  assert.ok(warnings.some((w) => /probe.*ENOTFOUND/.test(w)), warnings.join("\n"));
});

test("makeKeyProbe issues one platform-data GET with the candidate key and maps 401/403 to false", async () => {
  const { makeKeyProbe } = await import("./key-manager.mjs");
  const calls = [];
  const raw = {
    apiKey: "RGAPI-current",
    async get(path, opts) {
      calls.push({ path, opts, key: this.apiKey });
      if (this.apiKey === "RGAPI-dead") throw new Error("Riot API 401 from https://x: Unknown apikey");
      if (this.apiKey === "RGAPI-net") throw new Error("fetch failed");
      return { id: "NA1" };
    },
  };
  const probe = makeKeyProbe(raw, "na1");
  assert.equal(await probe("RGAPI-live"), true);
  assert.equal(await probe("RGAPI-dead"), false);
  await assert.rejects(() => probe("RGAPI-net"), /fetch failed/);
  assert.deepEqual(
    calls.map((c) => [c.path, c.opts.routing, c.opts.region, c.key]),
    [
      ["/lol/status/v4/platform-data", "platform", "na1", "RGAPI-live"],
      ["/lol/status/v4/platform-data", "platform", "na1", "RGAPI-dead"],
      ["/lol/status/v4/platform-data", "platform", "na1", "RGAPI-net"],
    ],
  );
  // The probe must not leave the client on the candidate key.
  assert.equal(raw.apiKey, "RGAPI-current");
});

test("wrapClientWithKeyRotation logs Riot's actual status and body on an auth failure", async () => {
  const file = fakeEnvFile("RGAPI-old");
  const km = new KeyManager({
    envFilePath: "/fake",
    readFile: file.readFile,
    sleep: async () => file.setKey("RGAPI-new"),
    logger: silentLogger,
  });
  await km.loadKey();
  const warnings = [];
  const raw = {
    apiKey: "RGAPI-old",
    async getMatch() {
      if (this.apiKey === "RGAPI-old") {
        throw new Error('Riot API 401 from https://x: {"status":{"message":"Unknown apikey"}}');
      }
      return {};
    },
  };
  const client = wrapClientWithKeyRotation(raw, km, { ...silentLogger, warn: (m) => warnings.push(m) });
  await client.getMatch("NA1_1");
  assert.ok(warnings.some((w) => /401/.test(w) && /Unknown apikey/.test(w)), warnings.join("\n"));
});
