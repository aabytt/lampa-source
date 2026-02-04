"use strict";

const Service = require("webos-service");
const WebSocket = require("ws");

const service = new Service("com.lampa.tv.kodibridge");

// -------------------------
// Global: one active session (preempt previous)
// -------------------------
let ACTIVE_SESSION = null; // { stop(reason) }

// -------------------------
// Helpers
// -------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toSecondsFromKodiTime(t) {
  if (!t) return 0;
  const h = Number(t.hours || 0);
  const m = Number(t.minutes || 0);
  const s = Number(t.seconds || 0);
  const ms = Number(t.milliseconds || 0);
  return h * 3600 + m * 60 + s + ms / 1000;
}

function pick(v, fallback) {
  return v === undefined || v === null ? fallback : v;
}

function lunaCall(uri, payload) {
  return new Promise((resolve, reject) => {
    service.call(uri, payload, (res) => {
      if (!res) return reject(new Error("Empty Luna response"));
      if (res.returnValue === false) {
        const msg = res.errorText || res.errorMessage || "Luna call failed";
        const err = new Error(msg);
        err.code = res.errorCode;
        return reject(err);
      }
      resolve(res);
    });
  });
}

async function launchApp(appId, params = {}) {
  return lunaCall("luna://com.webos.service.applicationmanager/launch", {
    id: appId,
    params,
  });
}

// -------------------------
// Kodi JSON-RPC over WS
// -------------------------

class KodiWsClient {
  constructor({ host, port, pingTimeoutMs }) {
    this.host = host;
    this.port = port;
    this.pingTimeoutMs = pingTimeoutMs;

    this.ws = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve,reject,timeout}
    this.lastActivityTs = Date.now();

    this.pingInterval = null;
    this.pingWatchdog = null;

    this.onNotification = null; // (method, params) => void
    this.onClose = null; // () => void
  }

  async connectWithRetry(totalTimeoutMs) {
    const start = Date.now();
    let attempt = 0;
    let lastErr = null;

    while (Date.now() - start < totalTimeoutMs) {
      attempt++;
      try {
        // per-attempt timeout: small and grows a bit
        const perAttempt = Math.min(1500 + attempt * 250, 4000);
        await this.connectOnce(perAttempt);
        return;
      } catch (err) {
        lastErr = err;
        // backoff
        const wait = Math.min(150 + attempt * 150, 800);
        await sleep(wait);
      }
    }

    const e = new Error(
      lastErr ? `${lastErr.message}` : `Kodi WS connect failed within ${totalTimeoutMs}ms`
    );
    e.code = "KODI_WS_CONNECT_FAILED";
    throw e;
  }

  connectOnce(timeoutMs) {
    return new Promise((resolve, reject) => {
      const url = `ws://${this.host}:${this.port}/jsonrpc`;
      const ws = new WebSocket(url);

      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        try { ws.terminate(); } catch (_) {}
        reject(new Error(`Kodi WS connect timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      ws.on("open", () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        this.ws = ws;
        this.lastActivityTs = Date.now();
        this._setupWsHandlers();
        this._startPing();
        resolve();
      });

      ws.on("error", (err) => {
        if (!done) {
          done = true;
          clearTimeout(t);
          reject(err);
        }
      });
    });
  }

  _setupWsHandlers() {
    this.ws.on("message", (data) => {
      this.lastActivityTs = Date.now();

      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch (_) {
        return;
      }

      // response
      if (msg && msg.id !== undefined) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          clearTimeout(pending.timeout);
          if (msg.error) {
            const err = new Error(msg.error.message || "Kodi RPC error");
            err.code = msg.error.code;
            pending.reject(err);
          } else {
            pending.resolve(msg.result);
          }
        }
        return;
      }

      // notification
      if (msg && msg.method && msg.params && typeof this.onNotification === "function") {
        this.onNotification(msg.method, msg.params);
      }
    });

    this.ws.on("pong", () => {
      this.lastActivityTs = Date.now();
    });

    this.ws.on("close", () => {
      this._stopPing();

      for (const [id, pending] of this.pending.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Kodi WS closed"));
      }
      this.pending.clear();

      if (typeof this.onClose === "function") this.onClose();
    });

    this.ws.on("error", () => {});
  }

  _startPing() {
    this.pingInterval = setInterval(() => {
      if (!this.ws) return;
      try { this.ws.ping(); } catch (_) {}
    }, 5000);

    this.pingWatchdog = setInterval(() => {
      const silentMs = Date.now() - this.lastActivityTs;
      if (silentMs > this.pingTimeoutMs) {
        try { this.ws.terminate(); } catch (_) {}
      }
    }, 1000);
  }

  _stopPing() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.pingWatchdog) clearInterval(this.pingWatchdog);
    this.pingInterval = null;
    this.pingWatchdog = null;
  }

  request(method, params, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("Kodi WS not connected"));
      }

      const id = this.nextId++;
      const payload = { jsonrpc: "2.0", id, method, params: params || {} };

      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Kodi RPC timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });

      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  close() {
    this._stopPing();
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
  }
}

// -------------------------
// Main method: playAsync
// -------------------------

service.register("playAsync", async (msg) => {
  if (!msg.isSubscription) {
    msg.respond({ returnValue: false, errorText: "subscribe:true is required" });
    return;
  }

  // ---- preempt any existing session (prevents races/leaks)
  if (ACTIVE_SESSION && typeof ACTIVE_SESSION.stop === "function") {
    try { ACTIVE_SESSION.stop("preempted"); } catch (_) {}
  }

  const p = msg.payload || {};

  const kodiAppId = pick(p.need, "org.xbmc.kodi");
  const lampaAppId = "com.lampa.tv";

  // Defaults (same-device)
  const kodiHost = pick(p.kodiHost, "127.0.0.1");
  const kodiWsPort = pick(p.kodiWsPort, 9090);

  const intervalMs = Math.max(100, pick(p.intervalMs, 250));
  const timeoutMs = Math.max(1000, pick(p.timeoutMs, 20000));
  const pingTimeoutMs = Math.max(1000, pick(p.pingTimeoutMs, 20000));

  // launch first (your requirement)
  let ended = false;
  let cancelled = false;

  // last known values
  let playerId = null;
  let pollTimer = null;
  let lastKnownPos = 0;
  let lastKnownDur = 0;
  let lastKnownSpeed = 0;

  const respond = (obj) => {
    if (ended || cancelled) return;
    try {
      msg.respond({ returnValue: true, subscribed: true, ...obj });
    } catch (_) {
      // if respond throws, treat as cancelled to stop leaks
      cancelled = true;
    }
  };

  const cleanup = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const bringFocusBackToLampa = async (extra = {}) => {
    try {
      await launchApp(lampaAppId, { from: "kodibridge", ...extra });
    } catch (_) {}
  };

  const endSession = async (kind, payload) => {
    if (ended) return;
    ended = true;

    cleanup();

    // clear global active session if it's us
    if (ACTIVE_SESSION && ACTIVE_SESSION._msg === msg) {
      ACTIVE_SESSION = null;
    }

    // do not force focus on "cancel" (UI closed/unsubscribed)
    if (kind !== "cancel") {
      await bringFocusBackToLampa(payload && payload.focusExtra ? payload.focusExtra : {});
    }

    // for cancel we do not send any final respond (subscription is gone)
    if (kind === "cancel") return;

    respond(payload);
  };

  const fail = async (message, code) => {
    await endSession("error", {
      type: "error",
      message,
      code: code || "ERR",
      position: lastKnownPos,
      duration: lastKnownDur,
      speed: lastKnownSpeed,
      focusExtra: { error: message, position: lastKnownPos },
    });
  };

  // subscription cancel handler (best-effort; varies by platform)
  try {
    if (typeof msg.on === "function") {
      msg.on("cancel", () => {
        cancelled = true;
        cleanup();
        if (ACTIVE_SESSION && ACTIVE_SESSION._msg === msg) {
          try { ACTIVE_SESSION.stop("cancel"); } catch (_) {}
          ACTIVE_SESSION = null;
        }
      });
    }
  } catch (_) {}

  // create session handle so future calls can preempt us
  const kodi = new KodiWsClient({ host: kodiHost, port: kodiWsPort, pingTimeoutMs });
  ACTIVE_SESSION = {
    _msg: msg,
    stop: (reason) => {
      // stop everything quickly
      cancelled = reason === "cancel";
      cleanup();
      try { kodi.close(); } catch (_) {}
    },
  };

  // 1) Launch Kodi immediately
  try {
    await launchApp(kodiAppId, { from: "kodibridge" });
    respond({ type: "launched", appId: kodiAppId });
  } catch (_) {
    await fail(`Kodi not available (${kodiAppId})`, "KODI_LAUNCH_FAILED");
    return true;
  }

  // 2) Validate args after launch
  const url = p.url;
  const name = pick(p.name, "");
  const position = Number.isFinite(p.position) ? p.position : -1;

  if (!url || typeof url !== "string") {
    await fail("Missing parameters.url", "BAD_ARGS");
    return true;
  }

  // 3) Connect WS with retry (Kodi may not be ready yet)
  kodi.onClose = async () => {
    // if not already ended/cancelled, treat as error
    if (!ended && !cancelled) {
      await fail("Kodi connection closed", "KODI_WS_CLOSED");
    }
  };

  try {
    await kodi.connectWithRetry(timeoutMs);
  } catch (err) {
    kodi.close();
    await fail(
      `Cannot connect to Kodi JSON-RPC WS at ${kodiHost}:${kodiWsPort} (${err.message})`,
      "KODI_WS_CONNECT_FAILED"
    );
    return true;
  }

  const getFinalPropsSafe = async () => {
    if (!kodi || playerId === null || playerId === undefined) {
      return { position: lastKnownPos, duration: lastKnownDur, speed: lastKnownSpeed };
    }
    try {
      const props = await kodi.request(
        "Player.GetProperties",
        { playerid: playerId, properties: ["time", "totaltime", "speed"] },
        2500
      );
      const pos = toSecondsFromKodiTime(props.time);
      const dur = toSecondsFromKodiTime(props.totaltime);
      const speed = Number(props.speed || 0);

      lastKnownPos = pos;
      lastKnownDur = dur;
      lastKnownSpeed = speed;

      return { position: pos, duration: dur, speed };
    } catch (_) {
      return { position: lastKnownPos, duration: lastKnownDur, speed: lastKnownSpeed };
    }
  };

  // 4) Notifications
  kodi.onNotification = async (method, params) => {
    if (ended || cancelled) return;

    if (method === "Player.OnAVStart") return respond({ type: "avstart" });
    if (method === "Player.OnPause") return respond({ type: "paused" });
    if (method === "Player.OnResume") return respond({ type: "resumed" });

    if (method === "Player.OnSeek") {
      return respond({
        type: "seek",
        position: lastKnownPos,
        duration: lastKnownDur,
        speed: lastKnownSpeed,
      });
    }

    if (method === "Player.OnStop") {
      const end = !!(params && params.data && params.data.end);
      const finalProps = await getFinalPropsSafe();
      try { kodi.close(); } catch (_) {}

      await endSession("stopped", {
        type: "stopped",
        position: finalProps.position,
        duration: finalProps.duration,
        end,
        focusExtra: {
          stopped: true,
          position: finalProps.position,
          duration: finalProps.duration,
          end,
        },
      });
    }
  };

  // 5) Start playback
  try {
    await kodi.request("Player.Open", { item: { file: url }, options: { resume: false } }, timeoutMs);

    // detect active player (retry)
    for (let i = 0; i < 14; i++) {
      const active = await kodi.request("Player.GetActivePlayers", {}, 3000);
      if (Array.isArray(active) && active.length > 0) {
        playerId = active[0].playerid;
        break;
      }
      await sleep(120);
    }

    if (playerId === null || playerId === undefined) {
      throw new Error("No active player after Player.Open");
    }

    if (Number.isFinite(position) && position >= 0) {
      await kodi.request("Player.Seek", { playerid: playerId, value: position }, 8000);
    }

    respond({ type: "playing", name, position: Math.max(0, position) });
  } catch (err) {
    try { kodi.close(); } catch (_) {}
    await fail(`Kodi play failed: ${err.message}`, "KODI_PLAY_FAILED");
    return true;
  }

  // 6) Poll progress with tolerance (avoid false errors)
  let pollFailStreak = 0;
  const MAX_POLL_FAILS = 3;

  pollTimer = setInterval(async () => {
    if (ended || cancelled) return;
    try {
      const props = await kodi.request(
        "Player.GetProperties",
        { playerid: playerId, properties: ["time", "totaltime", "speed"] },
        5000
      );

      pollFailStreak = 0;

      const pos = toSecondsFromKodiTime(props.time);
      const dur = toSecondsFromKodiTime(props.totaltime);
      const speed = Number(props.speed || 0);

      lastKnownPos = pos;
      lastKnownDur = dur;
      lastKnownSpeed = speed;

      respond({ type: "progress", position: pos, duration: dur, speed });
    } catch (err) {
      pollFailStreak += 1;
      if (pollFailStreak >= MAX_POLL_FAILS) {
        try { kodi.close(); } catch (_) {}
        await fail(`Kodi tracking failed: ${err.message}`, "KODI_TRACK_FAILED");
      }
    }
  }, intervalMs);

  return true;
});

// Optional health check
service.register("ping", (msg) => {
  msg.respond({ returnValue: true, ok: true, service: "com.lampa.tv.kodibridge" });
});
