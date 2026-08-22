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
