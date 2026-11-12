import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { EsclubClient, withEsclubSession } = require("../../../services/esclub/client");
const {
  EsclubError,
  EsclubDisabled,
  EsclubUnavailable,
  EsclubProtocolChanged,
} = require("../../../services/esclub/errors");

const SEP = "\u0004";

/** A fake WebSocket: nothing here touches the network. */
function makeFake() {
  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      instances.push(this);
    }
    send(text) {
      this.sent.push(text);
      this.onSend?.(this.sent.length - 1);
    }
    close() {
      this.closed = true;
    }
    open() {
      this.onopen?.({});
    }
    deliver(text) {
      this.onmessage?.({ data: text });
    }
    reply(id, context) {
      this.deliver(JSON.stringify({ payload_id: id, payload: { context }, mode: { Answer: "" } }) + SEP);
    }
    frames() {
      return this.sent.map((s) => JSON.parse(s.slice(0, -1)));
    }
  }
  return { FakeWebSocket, instances };
}

const flush = () => new Promise((r) => setImmediate(r));
const ENABLED = { ESCLUB_SYNC_ENABLED: "true" };

/** A client whose fake socket auto-answers every send with `{ok:true}`. */
function setup(opts = {}) {
  const { FakeWebSocket, instances } = makeFake();
  let t = 0;
  const sleeps = [];
  const calls = [];
  const client = new EsclubClient({
    WebSocketImpl: FakeWebSocket,
    env: ENABLED,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    onRequest: (name, count) => calls.push([name, count]),
    ...opts,
  });
  const advance = (ms) => { t += ms; };
  const connect = async (autoReply = true) => {
    const p = client.connect();
    await flush();
    const ws = instances[0];
    ws.onSend = (i) => ws.reply(ws.frames()[i].payload_id, { ok: true });
    ws.open();
    await p;
    if (!autoReply) ws.onSend = null;
    return ws;
  };
  return { client, instances, sleeps, calls, advance, connect, FakeWebSocket };
}

afterEach(() => vi.useRealTimers());

describe("kill switch", () => {
  for (const env of [{}, { ESCLUB_SYNC_ENABLED: "1" }, { ESCLUB_SYNC_ENABLED: "yes" }, { ESCLUB_SYNC_ENABLED: "TRUE" }]) {
    it(`refuses before constructing a socket with ${JSON.stringify(env)}`, async () => {
      const { client, instances } = setup({ env });
      await expect(client.connect()).rejects.toBeInstanceOf(EsclubDisabled);
      expect(instances).toHaveLength(0);
    });
  }
});

describe("handshake", () => {
  it("sends fetch-client with the guest context first, and reports it", async () => {
    const { client, connect, calls } = setup();
    const ws = await connect();
    const [hs] = ws.frames();
    expect(ws.url).toBe("wss://ws.esclub.gg");
    expect(hs.payload.request).toBe("fetch-client");
    expect(hs.payload.context).toEqual({
      client: { pool: { id_parent: "", credentials: null }, type: "Guest", access_token: null, refresh_token: null },
    });
    expect(hs.payload).toMatchObject({ auth_level: 1, mode_read: "Strong", id_correlation: "" });
    expect(hs.mode).toEqual({ Question: "" });
    expect(calls).toEqual([["fetch-client", 1]]);
    client.close();
    expect(ws.closed).toBe(true);
  });

  it("an error reply to the handshake is EsclubUnavailable", async () => {
    const { client, instances } = setup();
    const p = client.connect();
    await flush();
    const ws = instances[0];
    ws.onSend = (i) => ws.reply(ws.frames()[i].payload_id, { error: "nope" });
    ws.open();
    await expect(p).rejects.toBeInstanceOf(EsclubUnavailable);
  });

  it("a socket error before open is EsclubUnavailable", async () => {
    const { client, instances } = setup();
    const p = client.connect();
    await flush();
    instances[0].onerror?.({});
    await expect(p).rejects.toBeInstanceOf(EsclubUnavailable);
  });
});

describe("request", () => {
  it("returns the reply context, matched by payload_id", async () => {
    const { client, connect } = setup();
    const ws = await connect(false);
    const p = client.request("fetch-event-active", { id_event_active: "x" });
    await flush();
    const frame = ws.frames().at(-1);
    expect(frame.payload.request).toBe("fetch-event-active");
    expect(frame.payload.context).toEqual({ id_event_active: "x" });
    // a stray reply with another id is ignored
    ws.reply(9999, { events: ["stray"] });
    ws.reply(frame.payload_id, { events: [1] });
    await expect(p).resolves.toEqual({ events: [1] });
  });

  it("buffers a frame split across chunks and handles two frames in one chunk", async () => {
    const { client, connect } = setup();
    const ws = await connect();
    ws.onSend = null;
    const p = client.request("a", {});
    await flush();
    const id = ws.frames().at(-1).payload_id;
    const full = JSON.stringify({ payload_id: id, payload: { context: { v: 1 } }, mode: { Answer: "" } }) + SEP;
    ws.deliver(full.slice(0, 15));
    ws.deliver(full.slice(15));
    await expect(p).resolves.toEqual({ v: 1 });

    const p2 = client.request("b", {});
    await flush();
    const id2 = ws.frames().at(-1).payload_id;
    const hb = JSON.stringify({ payload_id: 777, payload: {}, mode: { Question: "" } }) + SEP;
    const rep = JSON.stringify({ payload_id: id2, payload: { context: { v: 2 } }, mode: { Answer: "" } }) + SEP;
    ws.deliver(hb + rep);
    await expect(p2).resolves.toEqual({ v: 2 });
  });

  it("handles a frame that arrives without the separator, as the probe does", async () => {
    const { client, connect } = setup();
    const ws = await connect();
    ws.onSend = null;
    const p = client.request("a", {});
    await flush();
    const id = ws.frames().at(-1).payload_id;
    ws.deliver(JSON.stringify({ payload_id: id, payload: { context: { v: 3 } }, mode: { Answer: "" } }));
    await expect(p).resolves.toEqual({ v: 3 });
  });

  it("echoes a server Question back as an Answer", async () => {
    const { client, connect } = setup();
    const ws = await connect();
    const before = ws.sent.length;
    ws.deliver(JSON.stringify({ payload_id: 55, payload: { request: "ping" }, mode: { Question: "" } }) + SEP);
    await flush();
    expect(ws.sent).toHaveLength(before + 1);
    expect(ws.frames().at(-1)).toMatchObject({ payload_id: 55, mode: { Answer: "" } });
    client.close();
  });

  it("an error reply or a missing context is EsclubUnavailable naming the request", async () => {
    const { client, connect } = setup();
    const ws = await connect(false);
    const p = client.request("fetch-serie", {});
    await flush();
    ws.reply(ws.frames().at(-1).payload_id, { error: "boom" });
    await expect(p).rejects.toThrow(/fetch-serie/);
    const p2 = client.request("fetch-round", {});
    await flush();
    ws.deliver(JSON.stringify({ payload_id: ws.frames().at(-1).payload_id, payload: {}, mode: { Answer: "" } }) + SEP);
    const e = await p2.catch((x) => x);
    expect(e).toBeInstanceOf(EsclubUnavailable);
    expect(e.message).toMatch(/fetch-round/);
  });

  it("garbage JSON is EsclubProtocolChanged for the pending request", async () => {
    const { client, connect } = setup();
    const ws = await connect(false);
    const p = client.request("x", {});
    await flush();
    ws.deliver("not json" + SEP);
    await expect(p).rejects.toBeInstanceOf(EsclubProtocolChanged);
  });

  it("enforces minGapMs from send to send, and onRequest runs before each send with a running count", async () => {
    const { client, connect, sleeps, calls, advance } = setup({ minGapMs: 1000 });
    const ws = await connect();
    const order = [];
    const origSend = ws.send.bind(ws);
    ws.send = (t) => { order.push("send:" + JSON.parse(t.slice(0, -1)).payload.request); origSend(t); };
    advance(400);
    await client.request("one", {});
    expect(sleeps).toEqual([600]); // handshake sent at t=0, so 600 remain
    await client.request("two", {});
    expect(sleeps).toEqual([600, 1000]); // sent at t=1000, next at once: full gap
    advance(5000);
    await client.request("three", {});
    expect(sleeps).toEqual([600, 1000]); // already past the gap: no sleep
    expect(calls).toEqual([["fetch-client", 1], ["one", 2], ["two", 3], ["three", 4]]);
    expect(order).toEqual(["send:one", "send:two", "send:three"]);
  });

  it("calls onRequest before the send", async () => {
    const log = [];
    const { client, connect } = setup({ onRequest: (n, c) => log.push(`req:${n}:${c}`) });
    const ws = await connect(false);
    const origSend = ws.send.bind(ws);
    ws.send = (t) => { log.push("send"); origSend(t); };
    ws.sent.length = 0;
    const p = client.request("q", {});
    await flush();
    ws.reply(ws.frames().at(-1).payload_id, { ok: 1 });
    await p;
    expect(log.slice(-2)).toEqual(["req:q:2", "send"]);
  });

  it("keeps one request in flight: the second is not sent until the first is answered", async () => {
    const { client, connect } = setup();
    const ws = await connect(false);
    const before = ws.sent.length;
    const p1 = client.request("a", {});
    const p2 = client.request("b", {});
    await flush();
    expect(ws.sent.length).toBe(before + 1);
    ws.reply(ws.frames().at(-1).payload_id, { n: 1 });
    await p1;
    await flush();
    expect(ws.sent.length).toBe(before + 2);
    ws.reply(ws.frames().at(-1).payload_id, { n: 2 });
    await expect(p2).resolves.toEqual({ n: 2 });
  });

  it("times out with EsclubUnavailable, and does not retry", async () => {
    vi.useFakeTimers();
    const { client, instances } = setup({ timeoutMs: 15000 });
    const p = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = instances[0];
    ws.onSend = (i) => ws.reply(ws.frames()[i].payload_id, { ok: true });
    ws.open();
    await p;
    ws.onSend = null;
    const r = client.request("slow", {}).catch((e) => e);
    await vi.advanceTimersByTimeAsync(15001);
    const e = await r;
    expect(e).toBeInstanceOf(EsclubUnavailable);
    expect(e.message).toMatch(/slow/);
    expect(ws.sent).toHaveLength(2); // handshake + the one try
  });

  it("a close mid-request is EsclubUnavailable", async () => {
    const { client, connect } = setup();
    const ws = await connect(false);
    const p = client.request("x", {});
    await flush();
    ws.onclose?.({});
    await expect(p).rejects.toBeInstanceOf(EsclubUnavailable);
  });

  it("an error event mid-request is EsclubUnavailable", async () => {
    const { client, connect } = setup();
    const ws = await connect(false);
    const p = client.request("x", {});
    await flush();
    ws.onerror?.({});
    await expect(p).rejects.toBeInstanceOf(EsclubUnavailable);
  });

  it("a request on a client that is not connected is EsclubUnavailable", async () => {
    const { client } = setup();
    await expect(client.request("x", {})).rejects.toBeInstanceOf(EsclubUnavailable);
  });
});

describe("fix round 1", () => {
  it("a throwing onRequest sends nothing and leaks no timer or pending promise", async () => {
    vi.useFakeTimers();
    const { client, instances } = setup();
    const p = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = instances[0];
    ws.onSend = (i) => ws.reply(ws.frames()[i].payload_id, { ok: true });
    ws.open();
    await p;
    ws.onSend = null;
    expect(vi.getTimerCount()).toBe(0);
    client.onRequest = () => { throw new Error("budget"); };
    const sent = ws.sent.length;
    await expect(client.request("x", {})).rejects.toThrow("budget");
    expect(ws.sent).toHaveLength(sent);
    expect(vi.getTimerCount()).toBe(0);
    client.close(); // would raise an unhandled rejection if a reply promise were left over
    await vi.advanceTimersByTimeAsync(20000);
  });

  it("a timeout marks the client failed: a later request is refused without a send", async () => {
    vi.useFakeTimers();
    const { client, instances } = setup({ timeoutMs: 1000 });
    const p = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = instances[0];
    ws.onSend = (i) => ws.reply(ws.frames()[i].payload_id, { ok: true });
    ws.open();
    await p;
    ws.onSend = null;
    const r = client.request("slow", {}).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await r).toBeInstanceOf(EsclubUnavailable);
    const sent = ws.sent.length;
    await expect(client.request("again", {})).rejects.toBeInstanceOf(EsclubUnavailable);
    expect(ws.sent).toHaveLength(sent);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a non-JSON frame marks the client failed", async () => {
    const { client, connect } = setup();
    const ws = await connect(false);
    const p = client.request("x", {});
    await flush();
    ws.deliver("not json" + SEP);
    await expect(p).rejects.toBeInstanceOf(EsclubProtocolChanged);
    const sent = ws.sent.length;
    await expect(client.request("y", {})).rejects.toBeInstanceOf(EsclubError);
    expect(ws.sent).toHaveLength(sent);
  });

  for (const [label, frame] of [["null", "null"], ["a number", "5"], ["a string mode", '{"payload_id":1,"mode":"Question"}']]) {
    it(`${label} frame: ProtocolChanged for the pending request, rest of the chunk handled safely`, async () => {
      const { client, connect } = setup();
      const ws = await connect(false);
      const p = client.request("x", {});
      await flush();
      const id = ws.frames().at(-1).payload_id;
      const good = JSON.stringify({ payload_id: id, payload: { context: { v: 1 } }, mode: { Answer: "" } }) + SEP;
      // for the string-mode frame use an id that is not pending so it reaches the mode check
      ws.deliver(frame.replace('"payload_id":1', '"payload_id":4242') + SEP + good);
      const e = await p.then((v) => v, (x) => x);
      if (label === "a string mode") {
        // not a pending id and no usable mode: ignored, and the real reply still resolves
        expect(e).toEqual({ v: 1 });
      } else {
        expect(e).toBeInstanceOf(EsclubProtocolChanged);
        const sent = ws.sent.length;
        await expect(client.request("y", {})).rejects.toBeInstanceOf(EsclubError);
        expect(ws.sent).toHaveLength(sent);
      }
    });
  }

  it("a request made while connect() is pending does not overlap the handshake", async () => {
    const { client, instances } = setup();
    const c = client.connect();
    await flush();
    const ws = instances[0];
    ws.onSend = (i) => ws.reply(ws.frames()[i].payload_id, { ok: true });
    const early = client.request("early", {});
    ws.open();
    await c;
    await expect(early).rejects.toBeInstanceOf(EsclubUnavailable);
    expect(ws.frames().map((f) => f.payload.request)).toEqual(["fetch-client"]);
  });

  it("a connect timeout closes the socket and rejects EsclubUnavailable", async () => {
    vi.useFakeTimers();
    const { client, instances } = setup({ timeoutMs: 500 });
    const p = client.connect().catch((e) => e);
    await vi.advanceTimersByTimeAsync(501);
    expect(await p).toBeInstanceOf(EsclubUnavailable);
    expect(instances[0].closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failed handshake closes the socket", async () => {
    const { client, instances } = setup();
    const p = client.connect();
    await flush();
    const ws = instances[0];
    ws.onSend = (i) => ws.reply(ws.frames()[i].payload_id, { error: "no" });
    ws.open();
    await expect(p).rejects.toBeInstanceOf(EsclubUnavailable);
    expect(ws.closed).toBe(true);
  });

  it("a throwing WebSocketImpl constructor becomes EsclubUnavailable", async () => {
    const { client } = setup({ WebSocketImpl: class { constructor() { throw new TypeError("nope"); } } });
    await expect(client.connect()).rejects.toBeInstanceOf(EsclubUnavailable);
  });

  it("nothing is sent after close", async () => {
    const { client, connect } = setup();
    const ws = await connect();
    client.close();
    const sent = ws.sent.length;
    await expect(client.request("x", {})).rejects.toBeInstanceOf(EsclubUnavailable);
    expect(ws.sent).toHaveLength(sent);
  });

  it("a session whose connect fails still releases the next session", async () => {
    const { FakeWebSocket, instances } = makeFake();
    let n = 0;
    const Impl = class extends FakeWebSocket {
      constructor(url) {
        super(url);
        const first = n++ === 0;
        this.onSend = (i) => this.reply(this.frames()[i].payload_id, first ? { error: "no" } : { ok: true });
        setTimeout(() => this.open(), 0);
      }
    };
    const opts = { WebSocketImpl: Impl, env: ENABLED, sleep: async () => {}, now: () => 0 };
    const a = withEsclubSession(async () => 1, opts);
    const b = withEsclubSession(async () => 2, opts);
    await expect(a).rejects.toBeInstanceOf(EsclubUnavailable);
    await expect(b).resolves.toBe(2);
    expect(instances.every((w) => w.closed)).toBe(true);
  });
});

describe("withEsclubSession", () => {
  it("runs two callers one after the other and closes the socket after each", async () => {
    const { FakeWebSocket, instances } = makeFake();
    const autoOpen = class extends FakeWebSocket {
      constructor(url) {
        super(url);
        this.onSend = (i) => this.reply(this.frames()[i].payload_id, { ok: true });
        queueMicrotask(() => setTimeout(() => this.open(), 0));
      }
    };
    const opts = { WebSocketImpl: autoOpen, env: ENABLED, sleep: async () => {}, now: () => 0 };
    const log = [];
    const a = withEsclubSession(async (c) => {
      log.push("a:start");
      await c.request("x", {});
      await new Promise((r) => setTimeout(r, 10));
      log.push("a:end");
      return "A";
    }, opts);
    const b = withEsclubSession(async (c) => {
      log.push("b:start");
      await c.request("y", {});
      log.push("b:end");
      return "B";
    }, opts);
    await expect(Promise.all([a, b])).resolves.toEqual(["A", "B"]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
    expect(instances).toHaveLength(2);
    expect(instances.every((w) => w.closed)).toBe(true);
  });

  it("closes the socket and lets the next caller run when fn throws", async () => {
    const { FakeWebSocket, instances } = makeFake();
    const autoOpen = class extends FakeWebSocket {
      constructor(url) {
        super(url);
        this.onSend = (i) => this.reply(this.frames()[i].payload_id, { ok: true });
        setTimeout(() => this.open(), 0);
      }
    };
    const opts = { WebSocketImpl: autoOpen, env: ENABLED, sleep: async () => {}, now: () => 0 };
    await expect(withEsclubSession(async () => { throw new Error("x"); }, opts)).rejects.toThrow("x");
    await expect(withEsclubSession(async () => 2, opts)).resolves.toBe(2);
    expect(instances.every((w) => w.closed)).toBe(true);
  });

  it("is refused by the kill switch without a socket", async () => {
    const { FakeWebSocket, instances } = makeFake();
    await expect(withEsclubSession(async () => 1, { WebSocketImpl: FakeWebSocket, env: {} })).rejects.toBeInstanceOf(EsclubDisabled);
    expect(instances).toHaveLength(0);
  });
});

describe("a failed client", () => {
  it("refuses connect() again without constructing a socket", async () => {
    const { client, connect, instances } = setup();
    await connect();
    client.close();
    await expect(client.connect()).rejects.toBeInstanceOf(EsclubUnavailable);
    expect(instances).toHaveLength(1);
  });
});

