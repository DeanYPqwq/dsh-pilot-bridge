/**
 * dsh-pilot-bridge — phase 1.
 *
 * A second bridge for DSHPilot, running alongside `dsh-deeppilot` on its own
 * port. It exists because deeppilot never forwards approvals to the phone:
 * `approval/asked` reaches the host's plugin bus, but nothing projects it into
 * the phone's `pending` list or its transcript, so the app has no card to draw.
 *
 * This server speaks the *same* wire protocol the app already implements
 * (`s2c.auth.challenge` → `c2s.auth.prove` → `s2c.welcome`, then
 * `s2c.pending.approval` / `c2s.approval.respond`), so no app change is needed
 * to talk to it — it is simply a second host to pair with.
 *
 * Phase 1 scope: TLS listener, `/phone/health`, `/phone/pair`, the auth
 * handshake, `s2c.welcome`, ping, and the approval frames.
 */

import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os, { homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { WebSocketServer } from "ws";
import selfsigned from "selfsigned";
import QRCode from "qrcode";

export const name = "dsh-pilot-bridge";

// Soft dependency: a missing service must not take the host down with it.
export const inject = [];

const HOME = homedir();
const DATA_DIR = join(HOME, ".dsh", "pilot-bridge");
const LOG_PATH = join(HOME, ".dsh", "pilot-bridge.log");
const CERT_PATH = join(DATA_DIR, "cert.json");
const DEVICES_PATH = join(DATA_DIR, "devices.json");

// 3099 is held by a listener leaked before the takeover logic existed; it is
// released by the next DSH restart. 3100 is the working port until then.
const DEFAULT_PORT = 3102;

/** Loopback-only port for the pairing page (plain HTTP by design). */
const PAGE_PORT = 3103;

/**
 * The listener owned by the most recent `apply`.
 *
 * DSH reloads a plugin by running `apply` again in the same process, so without
 * this every reload leaked a listener and the next one died with EADDRINUSE on
 * its own port. Closing the previous server first makes reloads idempotent.
 */
// Stored on `globalThis`, not in module scope: a reload may re-instantiate the
// module, and a module-local would then be null while the old listener is still
// bound — which is exactly how the port ended up stuck.
const SERVER_SLOT = "__dshPilotBridgeServer";
const LISTENERS_SLOT = "__dshPilotBridgeListeners";

/** 记录一个 disposer，供下次重载统一释放。 */
function track(dispose) {
  if (typeof dispose !== "function") return;
  globalThis[LISTENERS_SLOT] = [...(globalThis[LISTENERS_SLOT] ?? []), dispose];
}
// Must carry the `deeppilot:` prefix: the phone rejects any other audience
// (`ParseError.invalidAudience`) before it will even send a pairing request.
const AUDIENCE = "deeppilot:pilot-bridge";

/** Set once the certificate is loaded; the pairing string needs it. */
let FINGERPRINT = "";

export function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  console.log(`[pilot-bridge] ${message}`);
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    // Logging must never break the host.
  }
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  return Buffer.from(String(text).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function readJSON(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(path, value) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

// MARK: - Certificate

/**
 * A self-signed certificate, generated once and reused.
 *
 * The app pins the SPKI fingerprint, so regenerating it would make every
 * already-paired device fail with a pin mismatch. Persisting it is what makes
 * this host stable across restarts.
 */
async function loadOrCreateCertificate() {
  const saved = readJSON(CERT_PATH, null);
  // `keyType` is recorded so a certificate generated before the switch to EC can
  // be discarded instead of silently reused. The phone pins the SubjectPublicKeyInfo
  // with a *fixed P-256 wrapper* around the bare public key, so an RSA certificate
  // produces a fingerprint that can never match — the pin fails with no hint.
  if (saved?.cert && saved?.key && saved?.keyType === "ec") return saved;

  // `selfsigned` v5 returns a promise. Awaiting it is not optional: without the
  // await this was a Promise, `pems.cert` was undefined, and the HTTPS server
  // refused to start with a confusing "key argument must be a string" error.
  const pems = await selfsigned.generate([{ name: "commonName", value: "dsh-pilot-bridge" }], {
    // EC P-256, not RSA: the phone's pinning code wraps a bare public key with a
    // P-256 SubjectPublicKeyInfo prefix, so only an EC certificate can produce a
    // matching fingerprint.
    keyType: "ec",
    curve: "P-256",
    days: 3650,
    algorithm: "sha256",
  });

  // The SPKI of *this* certificate is what the phone pins, so that is what gets
  // stored and reported back at pairing time.
  const spki = createPublicKey(pems.cert).export({ type: "spki", format: "der" });
  const fingerprint = "sha256:" + base64url(createHash("sha256").update(spki).digest());

  const record = { cert: pems.cert, key: pems.private, fingerprint, keyType: "ec" };
  writeJSON(CERT_PATH, record);
  return record;
}

// MARK: - Frames

function envelope(type, payload, id) {
  const frame = { v: 2, type, ts: Date.now(), payload };
  if (id !== undefined) frame.id = id;
  return JSON.stringify(frame);
}

/**
 * The bytes the device signs. Must match `AuthProof.canonicalPreimage` in the
 * app exactly — one differing byte produces a bare `E_AUTH` with no hint.
 *
 * Three details are load-bearing there and therefore here: the leading version
 * marker, the base64url wrapping of the free-text fields, and `"-"` as the
 * cursor placeholder when no resume cursor is offered.
 */
function canonicalPreimage({ deviceId, deviceName, appVersion, nonce, audience, issuedAt, expiresAt, resumeCursor }) {
  const cursor = resumeCursor === undefined || resumeCursor === null ? "-" : String(resumeCursor);
  return Buffer.from(
    [
      "deeppilot-auth-v2",
      `device-id:${base64url(Buffer.from(deviceId, "utf8"))}`,
      `nonce:${nonce}`,
      `audience:${base64url(Buffer.from(audience, "utf8"))}`,
      `issued-at:${issuedAt}`,
      `expires-at:${expiresAt}`,
      `device-name:${base64url(Buffer.from(deviceName, "utf8"))}`,
      `app-version:${base64url(Buffer.from(appVersion, "utf8"))}`,
      `resume-cursor:${cursor}`,
    ].join("\n"),
    "utf8"
  );
}

class Connection {
  constructor(socket) {
    this.socket = socket;
    this.deviceId = null;
    this.authed = false;
    this.nonce = base64url(randomBytes(24));
    // Milliseconds, not seconds. The phone compares `now.millisecondsSince1970`
    // against `expiresAt`, so a seconds value is ~1000x in the past and every
    // challenge is dead on arrival — the client then never sends a proof and the
    // socket just churns.
    const now = Date.now();
    this.issuedAt = now;
    this.expiresAt = now + 30_000;
    this.timer = setTimeout(() => {
      if (!this.authed) this.close("auth timeout");
    }, 35_000);
  }

  send(type, payload, id) {
    try {
      this.socket.send(envelope(type, payload, id));
    } catch (error) {
      log(`send failed: ${error?.message ?? error}`);
    }
  }

  close(reason) {
    clearTimeout(this.timer);
    try {
      this.socket.close(1000, reason);
    } catch {}
  }

  challenge() {
    this.send("s2c.auth.challenge", {
      nonce: this.nonce,
      audience: AUDIENCE,
      issuedAt: this.issuedAt,
      expiresAt: this.expiresAt,
    });
  }
}

/**
 * The address a phone on the same Wi-Fi should use.
 *
 * `127.0.0.1` is useless to a phone, and hard-coding one machine's LAN address
 * breaks on the next DHCP lease, so it is discovered from the interfaces.
 */
function lanAddress() {
  try {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === "IPv4" && !entry.internal) return entry.address;
      }
    }
  } catch {}
  return "127.0.0.1";
}

/**
 * Builds the string the phone parses.
 *
 * Five fields are mandatory — host, code, pin, audience, expiry — and `h` must
 * carry a scheme, because the phone parses it as a URL and rejects a bare
 * `host:port` with "unsupported scheme". `e` is milliseconds since the epoch.
 */
const PAIRING_TTL_MS = 5 * 60 * 1000;

/**
 * The live pairing code.
 *
 * Rotated on start and on demand. It is single-use and short-lived because it is
 * the only thing standing between "anyone on this Wi-Fi" and a paired device —
 * an unexpiring, unverified code (the first version accepted any value) made the
 * whole pairing step decorative.
 */
let pairing = { code: "", expiresAt: 0, used: false };

function newPairingCode() {
  pairing = {
    // 32 characters is a hard floor: the phone refuses a pairing link whose `c`
    // is shorter (`ParseError.invalidCode`), and never sends the request at all.
    // 24 random bytes is 32 base64url characters exactly.
    code: base64url(randomBytes(24)),
    expiresAt: Date.now() + PAIRING_TTL_MS,
    used: false,
  };
  return pairing;
}

function pairingIsLive() {
  return pairing.code !== "" && !pairing.used && Date.now() < pairing.expiresAt;
}

function pairString(host) {
  const code = pairingIsLive() ? pairing.code : newPairingCode().code;
  return (
    `deeppilot://pair?h=https://${host}:${DEFAULT_PORT}` +
    `&c=${code}&f=${FINGERPRINT}&a=${AUDIENCE}&e=${pairing.expiresAt}`
  );
}

/**
 * Renders the pairing page, if `path` is one of its routes.
 *
 * Returns true when the request was handled. Served over plain HTTP on
 * loopback (see below): a self-signed certificate cannot be made trustworthy
 * enough for a browser to open the page, and asking a user to install a root CA
 * is not a reasonable step for pairing a phone.
 */
function servePairPage(request, response, path, method) {
  if (path === "/pair/regenerate" && method === "POST") {
    newPairingCode();
    log("pairing code regenerated");
    response.writeHead(303, { location: "/pair" });
    response.end();
    return true;
  }

  if (path === "/pair" || path === "/pair/") {
    const address = lanAddress();
    const pair = pairString(address);
    const expiry = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
    QRCode.toString(pair, { type: "svg", margin: 1, width: 260 }, (error, svg) => {
      if (error) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end(`QR generation failed: ${error.message}`);
        return;
      }
      const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Pilot Bridge — 配对</title>
<style>
:root { color-scheme: light dark; }
body { font: 15px/1.6 -apple-system, "PingFang SC", system-ui, sans-serif;
       max-width: 640px; margin: 6vh auto; padding: 0 20px; }
h1 { font-size: 20px; margin-bottom: 4px; }
.muted { opacity: .6; font-size: 13px; }
.qr { background: #fff; padding: 16px; border-radius: 12px; width: 260px; margin: 20px auto; }
code { display: block; word-break: break-all; background: rgba(127,127,127,.12);
       padding: 12px; border-radius: 8px; font-size: 12px; user-select: all; }
ol { padding-left: 20px; }
.addr { font-weight: 600; }
</style>
<h1>DSH Pilot Bridge</h1>
<div class="muted">审批通道 · 端口 ${DEFAULT_PORT} · <strong>仅局域网</strong></div>
<p style="background:rgba(255,196,0,.18);border-radius:8px;padding:10px;font-size:13px">
这是<strong>局域网</strong>配对码：手机必须和这台电脑连同一个 Wi-Fi。
这台桥接<strong>没有</strong>开启 Tailscale Funnel，所以公网访问不到它 ——
公网那套仍然由 DeepPilot 插件提供。
</p>
<div class="qr">${svg}</div>
<p><strong>在 iPhone 上：</strong>打开 DSH Pilot → 「主机」→「配对新的主机」→ 扫描上面这个二维码；
没有摄像头就用下面的字符串粘贴。</p>
<div style="position:relative">
  <code id="pairstr">${pair}</code>
  <button onclick="copyPair()" style="margin-top:8px;font:inherit;font-size:13px;
          padding:7px 14px;border-radius:8px;border:1px solid rgba(127,127,127,.45);
          background:transparent;cursor:pointer">复制配对串</button>
</div>
<div id="toast" style="position:fixed;left:50%;transform:translateX(-50%) translateY(-12px);
     top:24px;padding:9px 16px;border-radius:999px;background:rgba(20,20,20,.9);color:#fff;
     font-size:13px;opacity:0;transition:opacity .18s,transform .18s;pointer-events:none">
  已复制
</div>
<script>
function copyPair() {
  const text = document.getElementById('pairstr').textContent.trim();
  const done = () => {
    const t = document.getElementById('toast');
    t.style.opacity = '1';
    t.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => {
      t.style.opacity = '0';
      t.style.transform = 'translateX(-50%) translateY(-12px)';
    }, 1600);
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallback(text, done));
  } else {
    fallback(text, done);
  }
}
function fallback(text, done) {
  const area = document.createElement('textarea');
  area.value = text;
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); done(); } catch (e) { alert('复制失败，请手动选中'); }
  document.body.removeChild(area);
}
</script>
<p class="muted">
配对码 <span class="addr">${pairing.code || "已过期"}</span> ·
有效期至 ${expiry}（UTC）· <strong>只能使用一次</strong><br>
这台电脑的地址是 <span class="addr">${address}</span>，手机需要和它处于同一网络。
</p>
<form method="POST" action="/pair/regenerate">
<button type="submit" style="font:inherit;padding:9px 16px;border-radius:9px;
        border:1px solid rgba(127,127,127,.4);background:transparent;cursor:pointer">
  重新生成配对码
</button>
</form>
<p class="muted">配对码泄漏了、或者超过 5 分钟，就点一次重新生成 —— 旧码立即失效。</p>
<h2 style="font-size:16px">这一步在做什么</h2>
<ol>
<li>手机把自己的<strong>公钥</strong>发给这台电脑（私钥永远不离开手机）。</li>
<li>电脑记住这个公钥，之后每次连接都用它验证签名。</li>
<li>配对完成后，这台电脑上出现的<strong>审批请求</strong>会推送到手机。</li>
</ol>
<p class="muted">这个桥接只负责审批与提问，对话内容仍然由 DeepPilot 插件同步。</p>`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
    });
    return true;
  }
  return false;
}

export async function apply(ctx) {
  // An exception thrown here rejects the promise the loader awaits and is
  // swallowed — the log simply stops after "loaded", which is indistinguishable
  // from "nothing to do". Everything is funnelled through one catch so a failure
  // is always visible and never takes the host down with it.
  try {
    await applyInner(ctx);
  } catch (error) {
    log(`apply failed: ${error?.stack ?? error?.message ?? error}`);
  }
}

async function applyInner(ctx) {
  log("loaded");

  let certificate;
  try {
    certificate = await loadOrCreateCertificate();
  } catch (error) {
    log(`certificate unavailable: ${error?.message ?? error}`);
    return;
  }
  FINGERPRINT = certificate.fingerprint;
  log(`fingerprint ${FINGERPRINT}`);

  const devices = readJSON(DEVICES_PATH, {});
  const connections = new Map();
  const approvals = new Map();
  /** requestId -> { requestId, sessionId, questions[] } — 来自 ask_user_question 工具调用。 */
  const questions = new Map();

  /** 已推送到手机、尚未决定的审批：requestId -> { resolve, toolName, callId }。 */
  const awaiting = new Map();
  /** 已推送到手机、尚未回答的提问：requestId -> { resolve }。 */
  const awaitingQuestions = new Map();
  /** sessionId -> { id, title, lastActivityTs } — enough for the phone's list. */
  const sessionsSeen = new Map();

  // 释放上一个实例注册的监听器。
  //
  // cordis 的热重载会再次调用 `apply`，但不会自动回收上一次注册的监听器；
  // 于是每次重载都多挂一份，旧的实例里 `connections` 是空的，看到 phone=0 就
  // 立刻 next()，把手机这条路短路掉 —— 表现就是「卡片一闪而过」或「完全不出现」。
  {
    const previous = globalThis[LISTENERS_SLOT] ?? [];
    for (const dispose of previous) {
      try { dispose?.(); } catch {}
    }
    globalThis[LISTENERS_SLOT] = [];
    log(`disposed ${previous.length} stale listener(s)`);
  }

  // 内省（默认关闭）：把 harness 服务的方法名打出来，用于定位审批回答接口。
  // 需要时用 PILOT_BRIDGE_INTROSPECT=1 启动。
  if (process.env.PILOT_BRIDGE_INTROSPECT === "1") {
    const describe = (label, target) => {
      if (!target) { log(`${label}: (missing)`); return; }
      const names = new Set();
      let proto = Object.getPrototypeOf(target);
      while (proto && proto !== Object.prototype) {
        for (const n of Object.getOwnPropertyNames(proto)) names.add(n);
        proto = Object.getPrototypeOf(proto);
      }
      for (const n of Object.getOwnPropertyNames(target)) {
        if (typeof target[n] === "function") names.add(n);
      }
      log(`${label}: ${[...names].filter((n) => !n.startsWith("_")).sort().join(", ")}`);
    };
    try { describe("sessionController", ctx.get("sessionController")); } catch (e) { log(`introspect sessionController: ${e?.message ?? e}`); }
    try { describe("connection", ctx.get("connection")); } catch (e) { log(`introspect connection: ${e?.message ?? e}`); }
    try { describe("typertGateway", ctx.get("typertGateway")); } catch (e) { log(`introspect typertGateway: ${e?.message ?? e}`); }
    try {
      const sc = ctx.get("sessionController");
      describe("sessionController.control", sc?.control);
      const sym = Object.getOwnPropertySymbols(sc ?? {}).find((x) => String(x).includes("remote-methods"));
      if (sym) log(`sessionController.remote-methods: ${JSON.stringify(sc[sym]).slice(0, 1500)}`);
    } catch (e) { log(`introspect control: ${e?.message ?? e}`); }
  }

  function broadcast(type, payload) {
    const text = envelope(type, payload);
    for (const set of connections.values()) {
      for (const connection of set) {
        try {
          connection.socket.send(text);
        } catch {}
      }
    }
  }

  // --- approvals from the harness ---------------------------------------------
  if (ctx?.on) {
    ctx.on(
      "session/event",
      (session, event) => {
        const type = String(event?.type ?? "");
        const sessionId = String(session?.id ?? "");
        if (sessionId) {
          const existing = sessionsSeen.get(sessionId) ?? {
            id: sessionId,
            title: "",
            lastActivityTs: Date.now(),
          };
          existing.lastActivityTs = Date.now();
          // The harness emits the generated title as its own event; without this
          // every row would read "未命名会话" on the phone.
          if (type === "session/title") {
            const data = event?.data ?? {};
            const title = data.title ?? data.text ?? data.name;
            if (typeof title === "string" && title.trim()) existing.title = title.trim().slice(0, 200);
          }
          sessionsSeen.set(sessionId, existing);
        }
        // `ask_user_question` 在主机侧只是普通工具调用，不是交互事件，所以这里
        // 从 tool/call 的参数里把它还原成一张提问卡片。
        if (type === "tool/call") {
          const data = event?.data ?? {};
          const toolName = String(data.name ?? "");
          if (toolName === "ask_user_question") {
            try {
              const args = JSON.parse(String(data.arguments ?? "{}"));
              const mapped = (Array.isArray(args.questions) ? args.questions : [])
                .map((q, i) => ({
                  id: String(q.id ?? `q${i}`),
                  question: String(q.question ?? ""),
                  multiSelect: q.multiSelect === true,
                  options: (Array.isArray(q.options) ? q.options : []).map((o, j) => ({
                    id: String(o.id ?? `o${j}`),
                    label: String(o.label ?? ""),
                    ...(o.description ? { description: String(o.description) } : {}),
                  })),
                }))
                .filter((q) => q.question.length > 0);
              if (mapped.length > 0) {
                const requestId = `q-${String(data.callId ?? "")}`;
                const payload = {
                  requestId,
                  sessionId: String(session?.id ?? sessionId ?? ""),
                  questions: mapped,
                };
                questions.set(requestId, payload);
                awaitingQuestions.set(requestId, { questionId: mapped[0].id, resolve: null });
                log(`question ${requestId} asked (${mapped.length}) session=${payload.sessionId} conns=${connections.size}`);
                log(`question payload: ${JSON.stringify(payload).slice(0, 400)}`);
                broadcast("s2c.pending.question", payload);
              }
            } catch (error) {
              log(`question parse failed: ${error?.message ?? error}`);
            }
          }
        }

        // 工具结束（或失败）就把提问撤下
        if (type === "tool/result") {
          // `tool/result` 把 callId 放在 `message` 里，不同于 `tool/call` 的顶层字段。
          // 之前读顶层导致拼出的 id 永远对不上，提问卡片再也撤不下来。
          const data = event?.data ?? {};
          const callId = String(data?.message?.callId ?? data?.callId ?? "");
          const requestId = `q-${callId}`;
          if (questions.has(requestId)) {
            questions.delete(requestId);
            log(`question ${requestId} cleared`);
            broadcast("s2c.pending.cleared", { requestId });
          } else if (data?.message?.isError === false || true) {
            // callId 对不上时的兜底：任何一次 ask_user_question 的结果都意味着
            // 最早那条待答提问已经结束。
            const oldest = questions.keys().next().value;
            if (oldest !== undefined) {
              questions.delete(oldest);
              awaitingQuestions.delete(oldest);
              log(`question ${oldest} cleared (fallback)`);
              broadcast("s2c.pending.cleared", { requestId: oldest });
            }
          }
        }

        if (type === "approval/asked") {
          const data = event?.data ?? {};
          const payload = {
            requestId: String(data.id ?? ""),
            sessionId: String(session?.id ?? ""),
            toolName: String(data.toolName ?? "tool"),
            summary: String(data.reason ?? ""),
            riskLevel: "medium",
            callId: String(data.callId ?? ""),
          };
          if (!payload.requestId) return;
          approvals.set(payload.requestId, payload);
          awaiting.set(payload.requestId, {
            resolve: null,
            toolName: payload.toolName,
            callId: String(data.callId ?? ""),
          });
          log(`approval ${payload.requestId} asked (${payload.toolName})`);
          broadcast("s2c.pending.approval", payload);
        } else if (type === "approval/decided") {
          const requestId = String(event?.data?.id ?? "");
          if (!requestId || !approvals.has(requestId)) return;
          approvals.delete(requestId);
          awaiting.delete(requestId);
          log(`approval ${requestId} decided`);
          broadcast("s2c.pending.cleared", { requestId });
        }
      },
      { global: true }
    );
  }

  // --- 回答审批 -------------------------------------------------------------------
  //
  // harness 的 ApprovalService 通过 cordis 的 waterfall 事件做决定：
  //   ctx.waterfall(target, "approval/request", req, () => "unavailable")
  // 注册一个监听器就能回答，返回值即结果。只有手机连着时才接管，否则直接
  // 调用 next() 交给电脑端的回答者 —— 否则会把桌面端的弹窗挡住。
  // 必须注册在根上下文上：ApprovalService 用自己的 fork 派发，而 dispatch 只查
  // 该 fork 的 _hooks 原型链。插件上下文是根的子节点、与 approval 服务互为兄弟，
  // 挂在插件上下文上的监听器永远不在那条链里（global 只影响过滤）。
  const approvalCtx = ctx?.root ?? ctx;
  log(`approval listener ctx: root=${typeof ctx?.root} same=${approvalCtx === ctx}`);
  const registerOn = (target, label) => {
    if (!target?.on) return;
    track(target.on(
      "approval/request",
      async (req, next) => {
        log(`approval/request hit: phone=${connections.size} awaiting=${awaiting.size} callId=${String(req?.callId ?? "-")}`);
        if (connections.size === 0) return next();

        // 找到这条请求对应的 approval/asked 记录：优先按 callId，退化为最早待决项。
        const callId = String(req?.callId ?? "");
        let target = null;
        for (const [id, entry] of awaiting) {
          if (entry.resolve) continue;
          if (callId && entry.callId === callId) { target = id; break; }
          if (!target) target = id;
        }
        if (!target) {
          // `approval/asked` 的投递和 waterfall 之间没有顺序保证，按 callId 反查。
          for (const [id, payload] of approvals) {
            if (callId && payload.callId === callId && !awaiting.get(id)?.resolve) {
              awaiting.set(id, { resolve: null, toolName: payload.toolName, callId });
              target = id;
              break;
            }
          }
        }
        if (!target) return next();

        const entry = awaiting.get(target);
        // 手机连着时由手机独占，**不**同时拉起电脑端。
        //
        // 之前是「2 秒先手，抢不到就让电脑端并行」：只要用户超过 2 秒才点，
        // 电脑端卡片就已经弹出来了，而手机回答后那个回答者的 promise 永远没人
        // 兑现 —— 卡片就挂在那里不消失。现在只有手机不在时电脑端才会看到请求；
        // 手机在但一直不回答，超时后再交给电脑。
        // 电脑与手机**同时**看到卡片，任何一方回答都算数，并且没有超时。
        const desktop = Promise.resolve().then(() => next());
        const phone = new Promise((resolve) => {
          entry.resolve = (value) => resolve(value);
        });
        const winner = await Promise.race([phone, desktop.then((v) => ({ fromDesktop: v }))]);
        if (typeof winner === "object" && winner !== null && "fromDesktop" in winner) {
          log(`approval ${target}: answered on the computer`);
          entry.resolve = null;
          return winner.fromDesktop;
        }
        log(`approval ${target} answered from phone: ${String(winner)}`);
        return winner;
      },
      { global: true, prepend: true }
    ));
    log(`registered approval listener via ${label}`);
  };

  // 只注册一次。早先为了排查而在 root/self/events 各注册一遍，结果是
  // 同一个请求被调用多次，其中几个看到 phone=0 就 next()，直接把手机这条路
  // 短路了。
  registerOn(ctx?.root, "root");

  // 提问：harness 的 UserQuestionService 同样用 waterfall 派发，事件名是
  // `user-questions/request`（用 internal/dispatch 探针确认过）。返回
  // `{ answers: [{ id, selected, custom? }] }` 即为回答。
  const registerQuestions = (target, label) => {
    if (!target?.on) return;
    track(target.on(
      "user-questions/request",
      async (request, next) => {
        log(`user-questions hit: phone=${connections.size} awaiting=${awaitingQuestions.size}`);
        if (connections.size === 0) return next();
        const firstId = String(request?.questions?.[0]?.id ?? "");
        let match = null;
        for (const [id, entry] of awaitingQuestions) {
          if (entry.questionId === firstId) { match = id; break; }
        }
        if (!match) {
          for (const [id, payload] of questions) {
            if (String(payload.questions?.[0]?.id ?? "") === firstId) {
              awaitingQuestions.set(id, { questionId: firstId, resolve: null });
              match = id;
              break;
            }
          }
        }
        if (!match) {
          // 没有对应的待回答问题 —— 交给电脑端。
          return next();
        }
        // 同审批：手机连着就由手机独占，避免电脑端卡片残留。
        const desktop = Promise.resolve().then(() => next());
        const phone = new Promise((resolve) => {
          const entry = awaitingQuestions.get(match);
          entry.resolve = (value) => resolve(value);
        });
        const winner = await Promise.race([phone, desktop.then((v) => ({ fromDesktop: v }))]);
        const finishQuestion = () => {
          awaitingQuestions.delete(match);
          if (questions.delete(match)) {
            log(`question ${match} cleared`);
            broadcast("s2c.pending.cleared", { requestId: match });
          }
        };
        if (typeof winner === "object" && winner !== null && "fromDesktop" in winner) {
          log(`question ${match}: answered on the computer`);
          finishQuestion();
          return winner.fromDesktop;
        }
        log(`question ${match} answered from phone`);
        finishQuestion();
        return { answers: winner };;
      },
      { global: true, prepend: true }
    ));
    log(`registered question listener via ${label}`);
  };
  registerQuestions(ctx?.root, "root");

  // 诊断：打印审批期间所有被派发的事件名，用来确认沙箱提权到底走哪条通道。
  try {
    const root = ctx?.root ?? ctx;
    track(root.on("internal/dispatch", (type, name) => {
      const n = String(name);
      if (/approval|sandbox|permission|escalat|interaction|question/i.test(n)) {
        log(`dispatch ${type}: ${n}`);
      }
    }, { global: true, prepend: true }));
    log("dispatch probe installed");
  } catch (e) {
    log(`dispatch probe failed: ${e?.message ?? e}`);
  }

  // --- HTTP ---------------------------------------------------------------------
  function sendJSON(response, status, body) {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
    });
    response.end(text);
  }

  const server = https.createServer({ cert: certificate.cert, key: certificate.key }, (request, response) => {
    const url = new URL(request.url ?? "/", "https://localhost");
    if (servePairPage(request, response, url.pathname, request.method)) return;

    if (url.pathname === "/phone/health") {
      return sendJSON(response, 200, {
        ok: true,
        server: "dsh-pilot-bridge",
        version: "0.1.0",
        devices: Object.keys(devices).length,
      });
    }

    if (url.pathname === "/phone/pair" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) request.destroy();
      });
      request.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return sendJSON(response, 400, { error: "malformed" });
        }
        const code = String(parsed.code ?? "");
        if (!pairingIsLive() || code !== pairing.code) {
          log(`pair rejected: code ${pairingIsLive() ? "mismatch" : "expired"}`);
          return sendJSON(response, 400, {
            error: pairingIsLive() ? "invalid pairing code" : "pairing code expired",
          });
        }
        const publicKey = String(parsed.publicKey ?? "");
        if (!publicKey || publicKey.length < 80) {
          return sendJSON(response, 400, { error: "invalid public key" });
        }
        pairing.used = true;
        // Derived from the key, matching the app's own derivation, so pairing
        // again with the same key updates the same record instead of adding one.
        const deviceId = base64url(createHash("sha256").update(fromBase64url(publicKey)).digest());
        devices[deviceId] = {
          publicKey,
          deviceName: String(parsed.deviceName ?? "iPhone"),
          appVersion: String(parsed.appVersion ?? ""),
          scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
          pairedAt: new Date().toISOString(),
        };
        writeJSON(DEVICES_PATH, devices);
        log(`paired device ${deviceId.slice(0, 8)} (${devices[deviceId].deviceName})`);
        // 201 and an explicit `ok: true`: the phone treats a 200 as a rejection
        // ("主机拒绝了配对请求：HTTP 200") and only accepts 201 with that flag.
        return sendJSON(response, 201, {
          ok: true,
          deviceId,
          audience: AUDIENCE,
          scopes: devices[deviceId].scopes,
          tlsFingerprint: certificate.fingerprint,
        });
      });
      return;
    }

    sendJSON(response, 404, { error: "not found" });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "https://localhost");
    if (url.pathname !== "/phone") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws) => {
    const connection = new Connection(ws);
    connection.challenge();
    log("socket opened; challenge sent");

    ws.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      const type = String(frame?.type ?? "");
      const payload = frame?.payload ?? {};

      if (type === "c2s.auth.prove") {
        const deviceId = String(payload.deviceId ?? "");
        const record = devices[deviceId];
        if (!record) {
          connection.send("s2c.error", { code: "E_AUTH", message: "unknown device" });
          connection.close("unknown device");
          return;
        }
        const preimage = canonicalPreimage({
          deviceId,
          deviceName: String(payload.deviceName ?? ""),
          appVersion: String(payload.appVersion ?? ""),
          nonce: String(payload.nonce ?? ""),
          audience: String(payload.audience ?? ""),
          issuedAt: Number(payload.issuedAt ?? 0),
          expiresAt: Number(payload.expiresAt ?? 0),
          resumeCursor: payload.resumeCursor === undefined ? null : Number(payload.resumeCursor),
        });

        let ok = false;
        try {
          const point = fromBase64url(record.publicKey);
          // Wrap the raw X9.63 point into a DER SubjectPublicKeyInfo. This is
          // the same prefix the app's certificate-pinning code uses.
          const prefix = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
          const keyObject = createPublicKey({
            key: Buffer.concat([prefix, point]),
            format: "der",
            type: "spki",
          });
          ok = cryptoVerify(
            "sha256",
            preimage,
            { key: keyObject, dsaEncoding: "der" },
            fromBase64url(String(payload.signature ?? ""))
          );
        } catch (error) {
          log(`verify error: ${error?.message ?? error}`);
          ok = false;
        }

        if (!ok) {
          connection.send("s2c.error", { code: "E_AUTH", message: "bad signature" });
          connection.close("bad signature");
          return;
        }

        connection.authed = true;
        connection.deviceId = deviceId;
        clearTimeout(connection.timer);
        if (!connections.has(deviceId)) connections.set(deviceId, new Set());
        connections.get(deviceId).add(connection);
        log(`device ${deviceId.slice(0, 8)} authenticated`);

        connection.send("s2c.welcome", {
          protocolVersion: 2,
          serverVersion: "0.1.0",
          deviceId,
          scopes: record.scopes,
          capabilities: {
            sessions: false,
            prompt: false,
            interactions: true,
            attachments: false,
            schedule: false,
            models: false,
            projectSelection: false,
          },
          cursor: 0,
          resumed: false,
        });

        // Anything already waiting goes out immediately, so a phone that
        // reconnects in the middle of an approval still gets the card.
        for (const approval of approvals.values()) {
          connection.send("s2c.pending.approval", approval);
        }
        for (const question of questions.values()) {
          connection.send("s2c.pending.question", question);
        }
        return;
      }

      if (!connection.authed) return;

      switch (type) {
        case "c2s.ping":
          connection.send("s2c.pong", {});
          break;
        case "c2s.pending.list":
          connection.send(
            "s2c.pending.snapshot",
            { approvals: [...approvals.values()], questions: [...questions.values()] },
            frame.id
          );
          break;
        case "c2s.sessions.list":
          // Deliberately empty. This bridge carries approvals only; it has no
          // transcript, so a fabricated list produced rows that opened onto a
          // blank conversation — worse than showing nothing. Pending approvals
          // are surfaced by the app at the top of its own list instead.
          connection.send("s2c.sessions.list", { sessions: [] }, frame.id);
          break;
        case "c2s.question.respond": {
          const requestId = String(payload.requestId ?? "");
          const entry = awaitingQuestions.get(requestId);
          log(`question.respond ${JSON.stringify(payload).slice(0, 200)}`);
          if (entry?.resolve) {
            const answers = (Array.isArray(payload.answers) ? payload.answers : []).map((a) => ({
              id: String(a.id ?? ""),
              selected: Array.isArray(a.selected) ? a.selected.map(String) : [],
              ...(typeof a.custom === "string" && a.custom.length > 0 ? { custom: a.custom } : {}),
            }));
            entry.resolve(answers);
          } else {
            log(`question.respond: ${requestId} is not awaiting an answer`);
          }
          // 无论是否还在等待，都把卡片从手机端撤下：回答已经提交过，留着只会让人
          // 以为没生效并重复点击。
          questions.delete(requestId);
          awaitingQuestions.delete(requestId);
          broadcast("s2c.pending.cleared", { requestId });
          connection.send("s2c.ack", { requestId }, frame.id);
          break;
        }
        case "c2s.approval.respond":
          // The harness owns the decision; this bridge only relays it. Until a
          // host-side answer channel is wired the frame is acknowledged so the
          // UI does not hang, and the payload is logged for the next phase.
          {
            const requestId = String(payload.requestId ?? "");
            const decision = String(payload.decision ?? "");
            const entry = awaiting.get(requestId);
            log(`approval.respond ${JSON.stringify(payload).slice(0, 200)}`);
            if (entry?.resolve) {
              entry.resolve(decision === "allow" || decision === "allowed-once" ? "allowed-once" : "rejected");
            } else {
              log(`approval.respond: ${requestId} is not awaiting a decision`);
            }
            connection.send("s2c.ack", { requestId }, frame.id);
          }
          break;
        case "c2s.session.open":
        case "c2s.resume":
          connection.send("s2c.ack", {}, frame.id);
          break;
        default:
          connection.send("s2c.error", { code: "E_UNSUPPORTED", message: type }, frame.id);
          break;
      }
    });

    ws.on("close", () => {
      clearTimeout(connection.timer);
      if (connection.deviceId) {
        const set = connections.get(connection.deviceId);
        set?.delete(connection);
        if (set && set.size === 0) connections.delete(connection.deviceId);
      }
    });
  });

  // A plain-HTTP listener bound to loopback, purely for the pairing page.
  //
  // The bridge itself must stay TLS-only, but a browser will not open a
  // self-signed HTTPS page (`ERR_CERT_AUTHORITY_INVALID`) and the alternatives —
  // install a root CA, or click through a warning screen that Safari no longer
  // offers — are both unacceptable for a pairing step. Loopback means nothing on
  // the network can reach this page; the phone still gets a LAN address, which
  // the page displays for copying.
  const pageServer = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (servePairPage(request, response, url.pathname, request.method)) return;
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });

  // Take over from any previous instance *before* binding.
  // A reload runs `apply` again without ever disposing the previous call, so
  // listeners accumulate. The slot therefore holds a *list*: overwriting it with
  // the newest instance (which may itself have failed to bind) previously left
  // the oldest server holding the port and serving a stale certificate.
  try {
    // The slot may hold a single object from an earlier build of this file; a
    // bare spread of it throws "not iterable", which aborted `apply` before it
    // could listen.
    const stored = globalThis[SERVER_SLOT];
    const previous = Array.isArray(stored) ? stored : stored ? [stored] : [];
    for (const entry of previous) {
      // `close()` alone waits for open connections and keeps the port held.
      entry?.server?.close?.();
      entry?.server?.closeAllConnections?.();
      entry?.pageServer?.close?.();
      entry?.pageServer?.closeAllConnections?.();
    }
    globalThis[SERVER_SLOT] = [];
  } catch {}
  {
    const stored = globalThis[SERVER_SLOT];
    const previous = Array.isArray(stored) ? stored : stored ? [stored] : [];
    globalThis[SERVER_SLOT] = [...previous, { server, pageServer }];
  }

  // `unref()`：监听套接字不参与"事件循环是否还有工作"的判断。
  //
  // 没有它，DSH 关闭时 Node 会因为这两个常驻 listener 拒不让进程退出，
  // 表现为 `graceful deadline exceeded` —— 连桌面端更新都装不上。
  // 插件被卸载（DSH 退出、或热重载）时主动收尾。
  try {
    ctx.effect(() => () => {
      try { wss.close(); } catch {}
      try { server.closeAllConnections?.(); } catch {}
      try { server.close(); } catch {}
      try { pageServer.closeAllConnections?.(); } catch {}
      try { pageServer.close(); } catch {}
      log("bridge disposed; listeners closed");
    });
  } catch (e) {
    log(`dispose hook failed: ${e?.message ?? e}`);
  }

  pageServer.listen(PAGE_PORT, "127.0.0.1", () => {
    pageServer.unref?.();
    log(`pairing page: http://127.0.0.1:${PAGE_PORT}/pair`);
  });

  server.listen(DEFAULT_PORT, "0.0.0.0", () => {
    server.unref?.();
    log(`listening on https://0.0.0.0:${DEFAULT_PORT}`);
    log(`pair string (LAN): ${pairString(lanAddress())}`);
  });

  server.on("error", (error) => {
    log(`server error: ${error?.message ?? error}`);
  });


}
