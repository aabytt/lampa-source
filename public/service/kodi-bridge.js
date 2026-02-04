"use strict";

const Service = require("webos-service");
const WebSocket = require("ws");

const service = new Service("com.lampa.tv.kodibridge");

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
    this.pending = new Map();
    this.lastActivityTs = Date.now();

    this.pingInterval = null;
    this.pingWatchdog = null;

    this.onNotification = null;
    this.onClose = null;
  }

  connect(timeoutMs) {
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
  // Must be subscription (we stream events)
  if (!msg.isSubscription) {
    msg.respond({ returnValue: false, errorText: "subscribe:true is required" });
    return;
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

  let endedOrStopped = false;
  let playerId = null;
  let pollTimer = null;

  // last known values
  let lastKnownPos = 0;
  let lastKnownDur = 0;
  let lastKnownSpeed = 0;

  const respond = (obj) => {
    try {
      msg.respond({ returnValue: true, subscribed: true, ...obj });
    } catch (_) {}
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

  const fail = async (message, code) => {
    if (endedOrStopped) return;
    endedOrStopped = true;

    cleanup();
    await bringFocusBackToLampa({ error: message, position: lastKnownPos });

    respond({
      type: "error",
      message,
      code: code || "ERR",
      position: lastKnownPos,
      duration: lastKnownDur,
      speed: lastKnownSpeed,
    });
  };

  // 1) LAUNCH KODI IMMEDIATELY (fastest perceived start)
  try {
    await launchApp(kodiAppId, { from: "kodibridge" });
    respond({ type: "launched", appId: kodiAppId });
  } catch (_) {
    await fail(`Kodi not available (${kodiAppId})`, "KODI_LAUNCH_FAILED");
    return true;
  }

  // 2) Validate inputs AFTER launch (as requested)
  const url = p.url;
  const name = pick(p.name, "");
  const position = Number.isFinite(p.position) ? p.position : -1;

  if (!url || typeof url !== "string") {
    await fail("Missing parameters.url", "BAD_ARGS");
    return true;
  }

  // Give Kodi a brief moment to start WS (tune if needed)
  await sleep(150);

  const kodi = new KodiWsClient({ host: kodiHost, port: kodiWsPort, pingTimeoutMs });

  kodi.onClose = async () => {
    if (!endedOrStopped) {
      await fail("Kodi connection closed", "KODI_WS_CLOSED");
    }
  };

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

  // 3) Connect WS
  try {
    await kodi.connect(timeoutMs);
  } catch (_) {
    kodi.close();
    await fail(`Cannot connect to Kodi JSON-RPC WS at ${kodiHost}:${kodiWsPort}`, "KODI_WS_CONNECT_FAILED");
    return true;
  }

  // 4) Notifications
  kodi.onNotification = async (method, params) => {
    if (endedOrStopped) return;

    if (method === "Player.OnAVStart") return respond({ type: "avstart" });
    if (method === "Player.OnPause") return respond({ type: "paused" });
    if (method === "Player.OnResume") return respond({ type: "resumed" });

    if (method === "Player.OnSeek") {
      return respond({ type: "seek", position: lastKnownPos, duration: lastKnownDur, speed: lastKnownSpeed });
    }

    if (method === "Player.OnStop") {
      endedOrStopped = true;
      cleanup();

      const end = !!(params && params.data && params.data.end);
      const finalProps = await getFinalPropsSafe();

      kodi.close();

      await bringFocusBackToLampa({
        stopped: true,
        position: finalProps.position,
        duration: finalProps.duration,
        end,
      });

      respond({
        type: "stopped",
        position: finalProps.position,
        duration: finalProps.duration,
        end,
      });
    }
  };

  // 5) Start playback
  try {
    await kodi.request(
      "Player.Open",
      { item: { file: url }, options: { resume: false } },
      timeoutMs
    );

    await sleep(200);

    // get active player id (retry)
    for (let i = 0; i < 12; i++) {
      const active = await kodi.request("Player.GetActivePlayers", {}, 3000);
      if (Array.isArray(active) && active.length > 0) {
        playerId = active[0].playerid;
        break;
      }
      await sleep(150);
    }

    if (playerId === null || playerId === undefined) {
      throw new Error("No active player after Player.Open");
    }

    if (Number.isFinite(position) && position >= 0) {
      await kodi.request("Player.Seek", { playerid: playerId, value: position }, 8000);
    }

    respond({ type: "playing", name, position: Math.max(0, position) });
  } catch (err) {
    kodi.close();
    await fail(`Kodi play failed: ${err.message}`, "KODI_PLAY_FAILED");
    return true;
  }

  // 6) Poll progress
  pollTimer = setInterval(async () => {
    if (endedOrStopped) return;

    try {
      const props = await kodi.request(
        "Player.GetProperties",
        { playerid: playerId, properties: ["time", "totaltime", "speed"] },
        5000
      );

      const pos = toSecondsFromKodiTime(props.time);
      const dur = toSecondsFromKodiTime(props.totaltime);
      const speed = Number(props.speed || 0);

      lastKnownPos = pos;
      lastKnownDur = dur;
      lastKnownSpeed = speed;

      respond({ type: "progress", position: pos, duration: dur, speed });
    } catch (err) {
      kodi.close();
      await fail(`Kodi tracking failed: ${err.message}`, "KODI_TRACK_FAILED");
    }
  }, intervalMs);

  return true; // keep subscription open
});

// Optional health check
service.register("ping", (msg) => {
  msg.respond({ returnValue: true, ok: true, service: "com.lampa.tv.kodibridge" });
});
