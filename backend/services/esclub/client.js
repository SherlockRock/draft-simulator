/**
 * The transport of the esclub adapter: one guest websocket, the spike's
 * envelope and `\u0004` framing, one request in flight, a minimum gap between
 * sends, and a kill switch. Ported from docs/spikes/esclub/probe.mjs.
 *
 * Deliberately has no retries: a failure is a typed error and the caller
 * decides. Time (`now`, `sleep`) and the socket class are injectable so tests
 * touch neither the clock nor the network.
 */

const {
  EsclubDisabled,
  EsclubUnavailable,
  EsclubProtocolChanged,
} = require("./errors");

const SEP = "\u0004";

const GUEST_CONTEXT = () => ({
  client: { pool: { id_parent: "", credentials: null }, type: "Guest", access_token: null, refresh_token: null },
});

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envelope(request, context, payloadId) {
  return {
    payload_id: payloadId,
    payload: {
      id_correlation: "", auth_level: 1, mode_read: "Strong", request, context,
      route: null, id_client: null, id_parent: null, auth: null, time_expire: null,
    },
    mode: { Question: "" },
  };
}

class EsclubClient {
  /**
   * @param {object} [options]
   * @param {Function} [options.WebSocketImpl] WebSocket class (default `globalThis.WebSocket`).
   * @param {string} [options.url]
   * @param {number} [options.timeoutMs] per connect and per request.
   * @param {number} [options.minGapMs] minimum time between two sends, send to send.
   * @param {object} [options.env] where `ESCLUB_SYNC_ENABLED` is read.
   * @param {() => number} [options.now]
   * @param {(ms: number) => Promise<void>} [options.sleep]
   * @param {(name: string, count: number) => void} [options.onRequest] called BEFORE each send, the handshake included.
   */
  constructor({
    WebSocketImpl = globalThis.WebSocket,
    url = "wss://ws.esclub.gg",
    timeoutMs = 15000,
    minGapMs = 1000,
    env = process.env,
    now = Date.now,
    sleep = defaultSleep,
    onRequest,
  } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.minGapMs = minGapMs;
    this.env = env;
    this.now = now;
    this.sleep = sleep;
    this.onRequest = onRequest;
    this.ws = null;
    this.connected = false;
    this.nextId = 1;
    this.count = 0;
    this.lastSendAt = null;
    this.buffer = "";
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.inbound = Promise.resolve();
    this.failure = null;
  }

  /**
   * Opens the socket and performs the guest `fetch-client` handshake.
   * @returns {Promise<void>}
   * @throws {EsclubDisabled} unless `env.ESCLUB_SYNC_ENABLED === "true"`; no socket is constructed.
   * @throws {EsclubUnavailable} on connect failure, close, timeout or an error reply.
   */
  async connect() {
    if (this.env.ESCLUB_SYNC_ENABLED !== "true") {
      throw new EsclubDisabled("esclub sync is disabled (ESCLUB_SYNC_ENABLED is not \"true\")");
    }
    if (this.ws) throw new EsclubUnavailable("esclub client already connected");
    // A client that has failed stays failed: never open a second socket on it.
    if (this.failure) throw this.failure;
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch (err) {
      throw new EsclubUnavailable(`esclub socket could not be created: ${err.message}`);
    }
    this.ws = ws;
    ws.onmessage = (ev) => this._onMessage(ev);
    ws.onerror = () => this._fail(new EsclubUnavailable("esclub socket error"));
    ws.onclose = () => this._fail(new EsclubUnavailable("esclub socket closed"));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._fail(new EsclubUnavailable(`esclub connect timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
        this._connectReject = (err) => { clearTimeout(timer); reject(err); };
        ws.onopen = () => { clearTimeout(timer); this._connectReject = null; resolve(); };
      });
      await this._exchange("fetch-client", GUEST_CONTEXT(), true);
    } catch (err) {
      this.close();
      throw err;
    }
    this.connected = true;
  }

  /**
   * One request, one reply. Requests are serialised and spaced by `minGapMs`.
   * Module-private use: typed callers live in requests.js.
   * @param {string} name esclub request name.
   * @param {object} context
   * @returns {Promise<object>} the reply's `context`.
   * @throws {EsclubUnavailable} not connected, timeout, close/error, error or missing context.
   */
  request(name, context) {
    const run = this.queue.then(() => this._exchange(name, context));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Closes the socket; anything still pending fails with EsclubUnavailable. */
  close() {
    this._fail(new EsclubUnavailable("esclub client closed"));
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws) {
      ws.onmessage = ws.onerror = ws.onclose = ws.onopen = null;
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  async _exchange(name, context, handshake = false) {
    if (this.failure) throw this.failure;
    if (!this.ws || (!this.connected && !handshake)) {
      throw new EsclubUnavailable(`esclub ${name}: not connected`);
    }
    if (this.lastSendAt !== null) {
      const wait = this.minGapMs - (this.now() - this.lastSendAt);
      if (wait > 0) await this.sleep(wait);
    }
    if (this.failure) throw this.failure;
    // onRequest may throw (a budget, a failing log): run it before any pending
    // entry or timer exists, so a throw leaves nothing behind and sends nothing.
    if (this.onRequest) this.onRequest(name, this.count + 1);
    this.count += 1;
    const id = this.nextId++;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out request poisons the client: the server may still answer it.
        this._fail(new EsclubUnavailable(`no reply within ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        name,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
    this.lastSendAt = this.now();
    try {
      this.ws.send(JSON.stringify(envelope(name, context, id)) + SEP);
    } catch (err) {
      this._fail(new EsclubUnavailable(`send failed: ${err.message}`));
    }
    const payload = await reply;
    const ctx = payload && payload.context;
    if (!ctx || typeof ctx !== "object" || "error" in ctx) {
      throw new EsclubUnavailable(`esclub ${name}: error reply or missing context`);
    }
    return ctx;
  }

  _fail(err) {
    if (!this.failure) this.failure = err;
    if (this._connectReject) { const r = this._connectReject; this._connectReject = null; r(err); }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(new err.constructor(`esclub ${p.name}: ${err.message}`));
  }

  _onMessage(ev) {
    // Keep arrival order even when a frame arrives as a Blob (async decode).
    this.inbound = this.inbound.then(async () => {
      const data = ev.data;
      const text = typeof data === "string"
        ? data
        : data && typeof data.arrayBuffer === "function"
          ? Buffer.from(await data.arrayBuffer()).toString()
          : Buffer.from(data).toString();
      this.buffer += text;
      const parts = this.buffer.split(SEP);
      this.buffer = parts.pop();
      for (const part of parts) this._safeHandle(part);
      // As the spike's probe does: a message may end without the separator.
      // A trailing buffer that parses as a whole frame is one; anything else
      // is a partial frame and waits for the next chunk.
      if (this.buffer.trim()) {
        let complete = false;
        try { JSON.parse(this.buffer); complete = true; } catch { /* partial */ }
        if (complete) {
          const whole = this.buffer;
          this.buffer = "";
          this._safeHandle(whole);
        }
      }
    }).catch(() => {});
  }

  _safeHandle(text) {
    try {
      this._handle(text);
    } catch (err) {
      this._fail(new EsclubProtocolChanged(`unreadable frame: ${err.message}`));
    }
  }

  _handle(text) {
    if (!text.trim()) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this._fail(new EsclubProtocolChanged("sent a frame that is not JSON"));
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      this._fail(new EsclubProtocolChanged("sent a frame that is not an object"));
      return;
    }
    const p = this.pending.get(msg.payload_id);
    if (p) {
      this.pending.delete(msg.payload_id);
      p.resolve(msg.payload);
      return;
    }
    if (!this.failure && msg.mode && typeof msg.mode === "object" && "Question" in msg.mode) {
      // Server-initiated (heartbeat): echo back as an answer.
      msg.mode = { Answer: "" };
      try { this.ws.send(JSON.stringify(msg) + SEP); } catch { /* socket gone; close handler fails pending */ }
    }
  }
}

let tail = Promise.resolve();

/**
 * Process-wide: runs `fn(client)` with one connected client; a second call
 * waits for the first. The socket is closed after each call, success or not.
 * @template T
 * @param {(client: EsclubClient) => Promise<T>} fn
 * @param {object} [options] EsclubClient constructor options.
 * @returns {Promise<T>}
 */
function withEsclubSession(fn, options) {
  const run = tail.then(async () => {
    const client = new EsclubClient(options);
    try {
      await client.connect();
      return await fn(client);
    } finally {
      client.close();
    }
  });
  tail = run.catch(() => {});
  return run;
}

module.exports = { EsclubClient, withEsclubSession };
