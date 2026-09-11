// Local regression harness: node scripts/debug/canvas-reconnect-repro.cjs
// Uses real sockets, the actual Canvas handler/projection and backend adapter.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { once } = require("node:events");
const { createServer } = require("node:http");
const root = process.cwd();
const front = createRequire(`${root}/frontend/package.json`);
const back = createRequire(`${root}/backend/package.json`);
const { Server } = back("socket.io");
const { io: connect } = front("socket.io-client");
front("solid-js");
require.cache[front.resolve("solid-js")].exports = front(
  "solid-js/dist/solid.cjs",
);
const { createRoot, createSignal, createEffect, untrack, batch } =
  front("solid-js");
const { createStore } = front("solid-js/store/dist/store.cjs");
const ts = front("typescript");
const { setupCanvasHandlers } = back("./socketHandlers/canvasHandlers");
const source = readFileSync(`${root}/frontend/src/Canvas.tsx`, "utf8");
const provider = readFileSync(
  `${root}/frontend/src/providers/CanvasSocketProvider.tsx`,
  "utf8",
);
function between(text, begin, end) {
  const a = text.indexOf(begin);
  const b = text.indexOf(end, a + begin.length);
  assert(a >= 0 && b > a, `Missing source boundary: ${begin}`);
  return text.slice(a, b);
}
function compile(code) {
  return ts.transpile(code, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  });
}
const syncModule = { exports: {} };
new Function(
  "exports",
  compile(readFileSync(`${root}/frontend/src/utils/draftPickSync.ts`, "utf8")),
)(syncModule.exports);
const { createDraftPickSync } = syncModule.exports;
const handlerJS = compile(
  between(
    source,
    "    const handlePickChange =",
    "    const getRestrictedChampionsForDraft",
  ),
);
const projectionJS = between(
  source,
  "    createEffect(() => {\n        pickSyncVersion();",
  "    const [connections, setConnections]",
);

function reconnectCount() {
  const callbacks = new Map();
  const newSocket = {
    on: (name, callback) => callbacks.set(name, callback),
    io: { on: (name, callback) => callbacks.set(`manager:${name}`, callback) },
  };
  let refetches = 0;
  let dispose;
  createRoot((cleanup) => {
    dispose = cleanup;
    const [justReconnected, setJustReconnected] = createSignal(false);
    // Register the real connect/disconnect/Manager handlers. A reintroduced
    // Manager reconnect callback is included and makes the one-fetch check fail.
    const lifecycle = between(
      provider,
      '        newSocket.on("connect",',
      '        newSocket.io.on("reconnect_attempt",',
    );
    new Function(
      "newSocket",
      "setConnectionStatus",
      "setReconnectAttempts",
      "setJustReconnected",
      "pickSync",
      "let hasConnectedBefore = false;\nlet connectRetried = false;\n" +
        compile(lifecycle),
    )(
      newSocket,
      () => {},
      () => {},
      setJustReconnected,
      { setConnected() {} },
    );
    const reconnectEffect = between(
      source,
      "    // Sync canvas state after reconnection",
      "    // Live remote cursors",
    );
    new Function(
      "createEffect",
      "batch",
      "isLocalMode",
      "justReconnected",
      "setLoadedCanvasId",
      "canvasContext",
      "clearReconnected",
      reconnectEffect,
    )(
      createEffect,
      batch,
      () => false,
      justReconnected,
      () => {},
      {
        refetchCanvas: () => {
          refetches++;
        },
      },
      () => setJustReconnected(false),
    );
  });
  callbacks.get("connect")();
  assert.equal(refetches, 0);
  callbacks.get("manager:reconnect")?.();
  callbacks.get("connect")();
  assert.equal(refetches, 1);
  dispose();
  return { scenario: "automatic reconnect", refetches };
}

async function scenario(mode) {
  const http = createServer();
  const server = new Server(http, {
    pingInterval: 120,
    pingTimeout: 80,
    connectionStateRecovery: {},
  });
  const draftId = "7ebb27f4-2a62-478e-91d0-b056de9ba936";
  let saved = { id: draftId, picks: Array(20).fill(""), picksVersion: 0 };
  saved.picks[10] = "Ahri";
  let lastMutationId;
  let writes = 0;
  let serverSocket;
  let serverDisconnect;
  let dropped = 0;
  let sync, dispose;
  const requests = [];
  server.on("connection", (socket) => {
    serverSocket = socket;
    socket.user = { id: "owner" };
    socket.join(draftId);
    socket.on("disconnect", (reason) => {
      serverDisconnect = reason;
    });
    setupCanvasHandlers(
      socket,
      {
        async applyDraftPickMutation(request) {
          requests.push(request);
          if (lastMutationId !== request.mutationId) {
            assert.equal(request.baseVersion, saved.picksVersion);
            const picks = [...saved.picks];
            for (const change of request.changes)
              picks[change.index] = change.championId;
            saved = {
              id: draftId,
              picks,
              picksVersion: saved.picksVersion + 1,
            };
            lastMutationId = request.mutationId;
            writes++;
          }
          server.to(draftId).emit("draftUpdate", saved);
          return saved;
        },
      },
      (sock, event, handler) => sock.on(event, handler),
    );
  });
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const socket = connect(`http://127.0.0.1:${http.address().port}`, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 10,
    reconnectionDelayMax: 10,
    randomizationFactor: 0,
  });
  try {
    await once(socket, "connect");
    let cards, setCards, changePick;
    createRoot((cleanup) => {
      dispose = cleanup;
      [cards, setCards] = createStore([
        { Draft: { ...saved, type: "canvas", picks: [...saved.picks] } },
      ]);
      const [pickSyncVersion, setVersion] = createSignal(0);
      sync = createDraftPickSync({
        changed: () => setVersion((v) => v + 1),
        send: (request, reply) =>
          socket
            .timeout(100)
            .emit("updateDraftPicks", request, (error, result) =>
              reply(error ? undefined : result),
            ),
      });
      new Function(
        "createEffect",
        "untrack",
        "pickSyncVersion",
        "isLocalMode",
        "setCanvasDrafts",
        "pickSync",
        projectionJS,
      )(createEffect, untrack, pickSyncVersion, () => false, setCards, sync);
      changePick = new Function(
        "canEdit",
        "setCanvasDrafts",
        "isLocalMode",
        "canvasDrafts",
        "pickSync",
        handlerJS + "\nreturn handlePickChange;",
      )(
        () => true,
        setCards,
        () => false,
        cards,
        sync,
      );
    });
    sync.setConnected(true);
    socket.on("draftUpdate", (data) => sync.receive(data));
    socket.on("disconnect", () => sync.setConnected(false));
    socket.on("connect", () => {
      sync.setConnected(true);
      setCards(0, "Draft", sync.merge(saved));
    });
    const initial = structuredClone(saved);
    if (mode === "drop-message") {
      serverSocket.conn.transport.removeAllListeners("packet");
      serverSocket.conn.transport.on("packet", () => {
        dropped++;
      });
    }
    if (mode === "drop-ack") {
      const originalPacket = serverSocket.packet.bind(serverSocket);
      serverSocket.packet = (packet, ...args) => {
        if (packet.type === 3 && !dropped) {
          dropped++;
          return;
        }
        originalPacket(packet, ...args);
      };
    }
    changePick(draftId, 10, "Orianna");
    assert.equal(cards[0].Draft.picks[10], "Orianna");
    const deadline = Date.now() + 4000;
    while (sync.pendingCount() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      sync.pendingCount(),
      0,
      sync.error() ?? "Save never acknowledged",
    );
    // Replay a stale copy snapshot AFTER acknowledgement, then a fresh refetch.
    setCards(0, "Draft", sync.merge(initial));
    assert.equal(cards[0].Draft.picks[10], "Orianna");
    setCards(0, "Draft", sync.merge(saved));
    assert.equal(cards[0].Draft.picks[10], "Orianna");
    assert.equal(saved.picks[10], "Orianna");
    assert.equal(writes, 1);
    if (mode === "drop-message") assert.equal(serverDisconnect, "ping timeout");
    if (mode === "drop-ack") {
      assert.equal(requests.length, 2);
      assert.equal(requests[0].mutationId, requests[1].mutationId);
    }
    return {
      mode,
      afterReconnect: cards[0].Draft.picks[10],
      writes,
      dropped,
      serverDisconnect,
    };
  } finally {
    sync?.reset();
    dispose?.();
    socket.disconnect();
    await new Promise((resolve) => server.close(resolve));
  }
}
(async () => {
  console.log(JSON.stringify(await scenario("healthy")));
  for (let i = 0; i < 3; i++)
    console.log(JSON.stringify(await scenario("drop-message")));
  console.log(JSON.stringify(await scenario("drop-ack")));
  console.log(JSON.stringify(reconnectCount()));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
