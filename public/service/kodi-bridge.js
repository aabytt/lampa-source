/* eslint-disable no-console */
const Service = require("webos-service");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const service = new Service("com.lampa.tv.kodibridge");

const KODI_RPC = "http://127.0.0.1:8080/jsonrpc";

const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_PING_TIMEOUT_MS = 20000;

// latest-wins: новый запрос отменяет предыдущий
let currentJob = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createKeepAliveActivity() {
  return new Promise((resolve) => {
    service.activityManager.create("kodiBridgeKeepAlive", (activity) => resolve(activity));
  });
}

function completeKeepAliveActivity(activity) {
  return new Promise((resolve) => {
    if (!activity) return resolve();
    service.activityManager.complete(activity, () => resolve());
  });
}

function shrink(str, max = 500) {
  if (!str) return "";
  return str.length <= max ? str : str.slice(0, max) + "…";
}

function isOkResponse(data) {
  return Boolean(data && data.jsonrpc === "2.0" && data.id === 1 && data.result === "OK");
}

function isPong(data) {
  return Boolean(data && data.jsonrpc === "2.0" && data.id === 1 && data.result === "pong");
}

function postJson(urlStr, bodyObj, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;

    const body = JSON.stringify(bodyObj);

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + (u.search || ""),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "webos-kodi-bridge/1.0",
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch (e) {
            json = null;
          }
          resolve({
            okHttp: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: data,
            json,
          });
        });
      }
    );

    req.on("error", (err) => reject(err));
    req.setTimeout(timeoutMs, () => req.destroy(new Error("HTTP timeout")));
    req.write(body);
    req.end();
  });
}

async function kodiPingOnce() {
  return postJson(KODI_RPC, { jsonrpc: "2.0", method: "JSONRPC.Ping", id: 1 }, 2000);
}

async function kodiPlayerOpenOnce(url) {
  return postJson(
    KODI_RPC,
    {
      jsonrpc: "2.0",
      method: "Player.Open",
      params: { item: { file: url } },
      id: 1,
    },
    4000
  );
}

async function waitKodiReady(job, intervalMs, timeoutMs) {
  const started = Date.now();
  let attempts = 0;
  let last = null;

  while (!job.cancelled && Date.now() - started < timeoutMs) {
    attempts += 1;
    try {
      const r = await kodiPingOnce();
      last = r;
      if (r.json && isPong(r.json)) return { ready: true, attempts, last };
    } catch (e) {}
    await sleep(intervalMs);
  }

  return { ready: false, attempts, last };
}

async function playWorker(job, url, intervalMs, timeoutMs, pingTimeoutMs) {
  let attemptsOpen = 0;
  let attemptsPing = 0;
  let lastOpen = null;
  let lastPing = null;

  // 1) сразу Player.Open
  if (!job.cancelled) {
    attemptsOpen += 1;
    try {
      lastOpen = await kodiPlayerOpenOnce(url);
      if (lastOpen.json && isOkResponse(lastOpen.json)) {
        return { ok: true, attemptsOpen, attemptsPing, lastOpen, lastPing };
      }
    } catch (e) {}
  }

  // 2) ждём Ping->pong
  if (!job.cancelled) {
    const pingRes = await waitKodiReady(job, intervalMs, pingTimeoutMs);
    attemptsPing = pingRes.attempts;
    lastPing = pingRes.last;
  }

  // 3) ретраи Player.Open
  const startedOpenPhase = Date.now();
  while (!job.cancelled && Date.now() - startedOpenPhase < timeoutMs) {
    await sleep(intervalMs);
    attemptsOpen += 1;

    try {
      lastOpen = await kodiPlayerOpenOnce(url);
      if (lastOpen.json && isOkResponse(lastOpen.json)) {
        return { ok: true, attemptsOpen, attemptsPing, lastOpen, lastPing };
      }
    } catch (e) {}
  }

  return { ok: false, attemptsOpen, attemptsPing, lastOpen, lastPing };
}

/**
 * playAsync:
 * - если subscribe:true → шлём STARTED, а потом FINAL (OK/TIMEOUT/CANCELLED) в этот же callback
 * - если subscribe:false → просто отвечаем STARTED и всё
 */
service.register("playAsync", async (message) => {
  const p = message.payload || {};
  const url = p.url;

  if (!url || typeof url !== "string") {
    message.respond({ returnValue: false, errorText: "Missing or invalid 'url' string" });
    return;
  }

  const intervalMs = Number(p.intervalMs) > 0 ? Number(p.intervalMs) : DEFAULT_INTERVAL_MS;
  const timeoutMs = Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const pingTimeoutMs = Number(p.pingTimeoutMs) > 0 ? Number(p.pingTimeoutMs) : DEFAULT_PING_TIMEOUT_MS;

  // важное: подписка определяется полем subscribe в payload (UI должен передать subscribe:true)
  const subscribed = Boolean(p.subscribe);

  // отменяем предыдущий job
  if (currentJob) currentJob.cancelled = true;

  const job = { cancelled: false, url, startedAt: Date.now() };
  currentJob = job;

  // если клиент подписался — держим канал открытым
  if (subscribed) {
    // webos-service поддерживает subscriptions так:
    // сохраняем "subscription" на message и отвечаем несколько раз
    message.subscription = true;
  }

  // 1) сразу сообщаем "started"
  message.respond({ returnValue: true, stage: "STARTED", url });

  // если подписки нет — на этом всё (в фоне отработаем, но в аппку финал не отправим)
  if (!subscribed) {
    // всё равно можем выполнить, но это уже "немо"
  }

  let keepAlive = null;

  try {
    keepAlive = await createKeepAliveActivity();

    const r = await playWorker(job, url, intervalMs, timeoutMs, pingTimeoutMs);

    // если job отменён — финал "CANCELLED"
    if (job.cancelled) {
      if (subscribed) {
        message.respond({ returnValue: false, stage: "FINAL", result: "CANCELLED", url });
      }
      return;
    }

    const finalPayload = {
      returnValue: r.ok,
      stage: "FINAL",
      result: r.ok ? "OK" : "TIMEOUT",
      url,
      attemptsOpen: r.attemptsOpen,
      attemptsPing: r.attemptsPing,
      lastPing: r.lastPing
        ? { status: r.lastPing.status, json: r.lastPing.json, text: shrink(r.lastPing.text) }
        : null,
      lastOpen: r.lastOpen
        ? { status: r.lastOpen.status, json: r.lastOpen.json, text: shrink(r.lastOpen.text) }
        : null,
    };

    // 2) отправляем финал в аппку, если есть подписка
    if (subscribed) {
      message.respond(finalPayload);
    }
  } catch (e) {
    if (subscribed) {
      message.respond({
        returnValue: false,
        stage: "FINAL",
        result: "ERROR",
        errorText: String(e && e.message ? e.message : e),
        url,
      });
    }
  } finally {
    try {
      await completeKeepAliveActivity(keepAlive);
    } catch (e) {}

    if (currentJob === job) currentJob = null;
  }
});
