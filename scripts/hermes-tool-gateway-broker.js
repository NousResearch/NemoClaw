#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/* global fetch, URLSearchParams, WebSocket */

/**
 * Host-side Hermes managed-tool gateway broker.
 *
 * Hermes managed tools expect a user token in the sandbox, but NemoClaw keeps
 * Nous credentials on the host. The sandbox sends a per-sandbox broker token to
 * this process; the broker refreshes OAuth host-side, then replaces sandbox
 * auth headers before forwarding to allowlisted upstream gateway services.
 * Host-stored Nous API keys are valid for Hermes inference, but managed-tool
 * gateway routes require Nous Portal OAuth subscription auth.
 */

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = parseInt(process.env.HERMES_TOOL_GATEWAY_PORT || "11436", 10);
const STATE_DIR = process.env.HERMES_TOOL_GATEWAY_STATE_DIR;
const PORTAL_BASE_URL = (
  process.env.NOUS_PORTAL_BASE_URL || "https://portal.nousresearch.com"
).replace(/\/+$/, "");
const CLIENT_ID = process.env.HERMES_TOOL_GATEWAY_CLIENT_ID || "hermes-cli";
const DISCORD_API_BASE_URL = (
  process.env.NEMOCLAW_DISCORD_API_BASE_URL || "https://discord.com/api/v10"
).replace(/\/+$/, "");
const DISCORD_GATEWAY_INTENTS = 1 | 512 | 4096 | 32768; // guilds, guild messages, DMs, message content
const DISCORD_RECONNECT_MS = 5_000;
const HERMES_API_TIMEOUT_SECONDS = parseInt(
  process.env.NEMOCLAW_HERMES_DISCORD_API_TIMEOUT_SECONDS || "900",
  10,
);

if (!STATE_DIR) {
  console.error("HERMES_TOOL_GATEWAY_STATE_DIR required");
  process.exit(1);
}

function parseBase64JsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return fallback;
  }
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
}

function loadDiscordBridgeConfigs() {
  const configs = parseBase64JsonEnv("NEMOCLAW_HERMES_DISCORD_BRIDGES_B64", []);
  if (!Array.isArray(configs)) return [];
  return configs
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const sandbox = String(entry.sandbox || "").trim();
      const token = String(entry.token || "").trim();
      if (!sandbox || !token) return null;
      return {
        sandbox,
        token,
        guildIds: normalizeStringArray(entry.guildIds),
        allowedUserIds: normalizeStringArray(entry.allowedUserIds),
        requireMention: entry.requireMention !== false,
      };
    })
    .filter(Boolean);
}

const DISCORD_BRIDGE_CONFIGS = loadDiscordBridgeConfigs();
const discordBridgeStatuses = new Map();

function loadMatrixUpstreams() {
  const candidates = [
    process.env.HERMES_TOOL_GATEWAY_MATRIX_PATH,
    path.join(__dirname, "hermes-managed-tool-gateway-matrix.json"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const matrix = JSON.parse(fs.readFileSync(candidate, "utf8"));
      return Object.fromEntries(
        Object.values(matrix)
          .filter((entry) => entry && typeof entry === "object")
          .map((entry) => [entry.service, entry.upstream])
          .filter(([service, upstream]) => {
            return typeof service === "string" && typeof upstream === "string";
          }),
      );
    } catch {
      // Fall through to the baked-in upstreams below.
    }
  }

  return {
    firecrawl: "https://firecrawl-gateway.nousresearch.com",
    "fal-queue": "https://fal-queue-gateway.nousresearch.com",
    "openai-audio": "https://openai-audio-gateway.nousresearch.com",
    "browser-use": "https://browser-use-gateway.nousresearch.com",
    modal: "https://modal-gateway.nousresearch.com",
  };
}

const DEFAULT_UPSTREAMS = loadMatrixUpstreams();

function loadUpstreams() {
  const raw = process.env.HERMES_TOOL_GATEWAY_UPSTREAMS_JSON;
  if (!raw) return DEFAULT_UPSTREAMS;
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_UPSTREAMS, ...parsed };
  } catch {
    return DEFAULT_UPSTREAMS;
  }
}

const UPSTREAMS = loadUpstreams();
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const DECODED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "content-md5"]);
const STRIPPED_SECRET_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "api-key",
  "x-browser-use-api-key",
  "openai-api-key",
  "x-fal-key",
  "x-firecrawl-api-key",
]);

const BROKER_TOKEN_HEADERS = [
  "x-api-key",
  "api-key",
  "x-browser-use-api-key",
  "openai-api-key",
  "x-fal-key",
  "x-firecrawl-api-key",
];

function timingSafeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function extractBrokerToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const match = auth.match(/^(?:Bearer|Key)\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  for (const headerName of BROKER_TOKEN_HEADERS) {
    const value = req.headers[headerName];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length > 0) return String(value[0]).trim();
  }
  return null;
}

function stateFiles() {
  try {
    return fs
      .readdirSync(STATE_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(STATE_DIR, name));
  } catch {
    return [];
  }
}

function loadStateFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const state = JSON.parse(raw);
    if (!state || typeof state !== "object") return null;
    return { file, state };
  } catch {
    return null;
  }
}

function findStateByBrokerToken(token) {
  if (!token) return null;
  for (const file of stateFiles()) {
    const loaded = loadStateFile(file);
    const brokerToken = loaded?.state?.broker_token;
    if (timingSafeEqualString(token, brokerToken)) {
      return loaded;
    }
  }
  return null;
}

function parseRoute(reqUrl) {
  const url = new URL(reqUrl || "/", "http://broker.local");
  const parts = url.pathname.split("/").filter(Boolean);
  const service = parts[0] || "";
  const upstreamBase = UPSTREAMS[service];
  if (!upstreamBase) return null;
  const suffix = "/" + parts.slice(1).join("/");
  return {
    service,
    upstreamUrl:
      upstreamBase.replace(/\/+$/, "") + (suffix === "/" ? "/" : suffix) + (url.search || ""),
  };
}

function expiresSoon(isoValue) {
  if (!isoValue || typeof isoValue !== "string") return true;
  const timestamp = Date.parse(isoValue);
  if (!Number.isFinite(timestamp)) return true;
  return timestamp - Date.now() < 120_000;
}

function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/**
 * @param {string} message
 * @param {string} code
 * @returns {Error & {code: string}}
 */
function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function errorCode(err) {
  if (!err || typeof err !== "object" || !("code" in err)) return null;
  const code = err.code;
  return typeof code === "string" ? code : null;
}

async function refreshAccessToken(loaded) {
  const state = loaded.state;
  if (state.auth_method === "api_key" || state.api_key) {
    throw codedError("tool_gateway_requires_oauth", "tool_gateway_requires_oauth");
  }
  if (state.access_token && !expiresSoon(state.expires_at)) {
    return state.access_token;
  }
  if (!state.refresh_token) {
    throw codedError("missing_refresh_token", "missing_refresh_token");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: state.refresh_token,
    client_id: state.client_id || CLIENT_ID,
  });
  const resp = await fetch(`${PORTAL_BASE_URL}/api/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (resp.status !== 200) {
    throw codedError(
      `refresh_failed_http_${resp.status}`,
      resp.status === 400 || resp.status === 401 ? "reauth_required" : "refresh_failed",
    );
  }

  const payload = await resp.json();
  if (!payload.access_token) {
    throw codedError("token_response_missing_access_token", "refresh_failed");
  }

  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 900;
  const now = new Date();
  const updated = {
    ...state,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || state.refresh_token,
    token_type: payload.token_type || "Bearer",
    scope: payload.scope || state.scope,
    expires_in: expiresIn,
    expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    updated_at: now.toISOString(),
  };
  atomicWriteJson(loaded.file, updated);
  loaded.state = updated;
  return updated.access_token;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function buildForwardHeaders(req, route, accessToken) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "accept-encoding") continue;
    if (HOP_BY_HOP_HEADERS.has(lower) || STRIPPED_SECRET_HEADERS.has(lower)) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  headers["accept-encoding"] = "identity";
  switch (route.service) {
    case "browser-use":
      headers["X-Browser-Use-API-Key"] = accessToken;
      break;
    case "fal-queue":
      headers.authorization = `Key ${accessToken}`;
      break;
    default:
      headers.authorization = `Bearer ${accessToken}`;
      break;
  }
  return headers;
}

function forwardResponseHeaders(upstreamResp) {
  /** @type {import("http").OutgoingHttpHeaders} */
  const headers = {};
  upstreamResp.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      DECODED_RESPONSE_HEADERS.has(lower) ||
      lower === "set-cookie"
    ) {
      return;
    }
    headers[name] = value;
  });
  return headers;
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function websocketDataToString(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return String(data || "");
}

function setDiscordBridgeStatus(sandbox, patch) {
  const current = discordBridgeStatuses.get(sandbox) || {
    sandbox,
    connected: false,
    bot_id: null,
    guild_count: 0,
    last_error: null,
    updated_at: null,
  };
  discordBridgeStatuses.set(sandbox, {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  });
}

async function discordRest(token, method, pathName, body = undefined) {
  const resp = await fetch(`${DISCORD_API_BASE_URL}${pathName}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "NemoClaw-Hermes-Discord-Bridge/0.1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text.slice(0, 500) };
    }
  }
  if (!resp.ok) {
    throw Object.assign(new Error(`discord_http_${resp.status}`), {
      status: resp.status,
      payload,
    });
  }
  return payload;
}

function stripBotMention(content, botId) {
  return String(content || "")
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .trim();
}

function stableSessionId(message) {
  const channel = String(message.channel_id || "unknown");
  const author = String(message.author?.id || "unknown");
  return `discord-${channel}-${author}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

function discordSystemPrompt(message) {
  const author = message.author || {};
  return [
    "You are Hermes Agent replying to Discord through NemoClaw's host-side Discord bridge.",
    "Keep replies concise and suitable for a Discord chat.",
    "The bridge will deliver your final answer back to the same Discord channel.",
    `Discord source: guild_id=${message.guild_id || "dm"}, channel_id=${message.channel_id || "unknown"}, message_id=${message.id || "unknown"}, user_id=${author.id || "unknown"}, username=${author.username || "unknown"}.`,
  ].join("\n");
}

const SANDBOX_HERMES_POST_CODE = `exec(${JSON.stringify(
  [
    "import base64,json,sys,urllib.request,urllib.error,os",
    "def dotenv_value(name):",
    "    candidates=[]",
    "    home=os.environ.get('HERMES_HOME','')",
    "    if home:",
    "        candidates.append(os.path.join(home,'.env'))",
    "    candidates.extend(['/sandbox/.hermes-data/.env','/sandbox/.hermes/.env'])",
    "    for path in candidates:",
    "        try:",
    "            with open(path,'r',encoding='utf-8') as handle:",
    "                for line in handle:",
    "                    raw=line.strip()",
    "                    if not raw or raw.startswith('#') or '=' not in raw:",
    "                        continue",
    "                    key,value=raw.split('=',1)",
    "                    if key.strip()==name:",
    "                        return value.strip().strip('\"').strip(\"'\")",
    "        except Exception:",
    "            pass",
    "    return ''",
    "data=json.loads(base64.b64decode(sys.argv[1]).decode('utf-8'))",
    "api_key=os.environ.get('API_SERVER_KEY') or dotenv_value('API_SERVER_KEY')",
    "if not api_key:",
    "    sys.stdout.write(json.dumps({'error':'hermes_api_key_missing','message':'API_SERVER_KEY missing from Hermes sandbox .env'}))",
    "    sys.exit(1)",
    "body=json.dumps(data['request']).encode('utf-8')",
    "req=urllib.request.Request('http://127.0.0.1:8642/v1/chat/completions',data=body,method='POST')",
    "req.add_header('Content-Type','application/json')",
    "req.add_header('Authorization','Bearer '+api_key)",
    "req.add_header('X-Hermes-Session-Id',data['session_id'])",
    "req.add_header('Idempotency-Key',data.get('idempotency_key',''))",
    "try:",
    "    resp=urllib.request.urlopen(req,timeout=int(data.get('timeout',900)))",
    "    sys.stdout.write(resp.read().decode('utf-8','replace'))",
    "except urllib.error.HTTPError as e:",
    "    sys.stdout.write(json.dumps({'error':'hermes_api_http_error','status':e.code,'body':e.read().decode('utf-8','replace')[:1000]}))",
    "    sys.exit(1)",
    "except Exception as e:",
    "    sys.stdout.write(json.dumps({'error':'hermes_api_error','message':str(e)[:1000]}))",
    "    sys.exit(1)",
  ].join("\n"),
)})`;

function callSandboxHermes(config, message, content) {
  const sessionId = stableSessionId(message);
  const request = {
    model: "hermes-agent",
    stream: false,
    messages: [
      { role: "system", content: discordSystemPrompt(message) },
      { role: "user", content },
    ],
  };
  const payload = Buffer.from(
    JSON.stringify({
      request,
      session_id: sessionId,
      idempotency_key: message.id ? `discord-${message.id}` : "",
      timeout: HERMES_API_TIMEOUT_SECONDS,
    }),
    "utf8",
  ).toString("base64");
  const { spawn } = require("child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "openshell",
      [
        "sandbox",
        "exec",
        "-n",
        config.sandbox,
        "--timeout",
        String(HERMES_API_TIMEOUT_SECONDS + 30),
        "--no-tty",
        "--",
        "python3",
        "-c",
        SANDBOX_HERMES_POST_CODE,
        payload,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", () => {
      // Do not retain stderr; sandbox diagnostics can contain prompt content.
    });
    const timeout = setTimeout(
      () => {
        child.kill("SIGTERM");
        reject(new Error("sandbox_hermes_api_timeout"));
      },
      (HERMES_API_TIMEOUT_SECONDS + 45) * 1000,
    );
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(
          new Error(
            code !== 0
              ? `sandbox_hermes_api_failed_${code ?? "unknown"}`
              : "sandbox_hermes_api_empty_response",
          ),
        );
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        reject(new Error("sandbox_hermes_api_invalid_json"));
        return;
      }
      if (parsed.error) {
        let message = String(parsed.error);
        if (parsed.status) message += `_${parsed.status}`;
        if (parsed.body) message += `: ${String(parsed.body).slice(0, 240)}`;
        reject(new Error(message));
        return;
      }
      if (code !== 0) {
        reject(new Error(`sandbox_hermes_api_failed_${code ?? "unknown"}`));
        return;
      }
      resolve(
        parsed?.choices?.[0]?.message?.content ||
          parsed?.output_text ||
          parsed?.final_response ||
          "(No response generated.)",
      );
    });
  });
}

function splitDiscordMessage(text) {
  const raw = String(text || "").trim() || "(No response generated.)";
  const chunks = [];
  let rest = raw;
  while (rest.length > 1900) {
    let idx = rest.lastIndexOf("\n", 1900);
    if (idx < 200) idx = rest.lastIndexOf(" ", 1900);
    if (idx < 200) idx = 1900;
    chunks.push(rest.slice(0, idx).trimEnd());
    rest = rest.slice(idx).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendDiscordReply(config, message, text) {
  let previousMessageId = message.id;
  for (const chunk of splitDiscordMessage(text)) {
    const body = {
      content: chunk,
      allowed_mentions: { parse: [], replied_user: false },
    };
    if (previousMessageId) {
      body.message_reference = {
        message_id: previousMessageId,
        channel_id: message.channel_id,
        guild_id: message.guild_id,
        fail_if_not_exists: false,
      };
    }
    const sent = await discordRest(
      config.token,
      "POST",
      `/channels/${message.channel_id}/messages`,
      body,
    );
    previousMessageId = sent?.id || null;
  }
}

function discordMessageContentForBridge(config, botId, message) {
  if (!message || message.type !== 0 || message.author?.bot) return null;
  const guildId = message.guild_id ? String(message.guild_id) : "";
  if (guildId && config.guildIds.length > 0 && !config.guildIds.includes(guildId)) return null;
  const authorId = String(message.author?.id || "");
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(authorId)) return null;
  const isDm = !guildId;
  const mentioned = (message.mentions || []).some((mention) => String(mention.id) === botId);
  if (!isDm && config.requireMention && !mentioned) return null;
  const content = stripBotMention(message.content, botId);
  return content || null;
}

async function sendDiscordTyping(config, message) {
  try {
    await discordRest(config.token, "POST", `/channels/${message.channel_id}/typing`, {});
  } catch {
    // Typing indicators are best-effort.
  }
}

function discordDeliveryErrorMessage(err) {
  const errorMessage = err instanceof Error ? err.message : String(err);
  return errorMessage.includes("hermes_api_key_missing")
    ? "NemoClaw Discord bridge is missing the sandbox Hermes API key. Rebuild the Hermes sandbox with the current image/config, then restart the broker."
    : "NemoClaw could not deliver that message to Hermes inside the sandbox. Check `nemoclaw my-assistant logs` and the host Hermes broker logs.";
}

async function handleDiscordMessage(config, botId, message) {
  const content = discordMessageContentForBridge(config, botId, message);
  if (!content) return;

  await sendDiscordTyping(config, message);

  try {
    const response = await callSandboxHermes(config, message, content);
    await sendDiscordReply(config, message, response);
  } catch (err) {
    setDiscordBridgeStatus(config.sandbox, {
      last_error: err instanceof Error ? err.message : String(err),
    });
    try {
      await sendDiscordReply(config, message, discordDeliveryErrorMessage(err));
    } catch {
      // Avoid recursive error noise.
    }
  }
}

class DiscordBridge {
  constructor(config) {
    this.config = config;
    this.sequence = null;
    this.heartbeat = null;
    this.stopped = false;
    this.botId = null;
  }

  start() {
    setDiscordBridgeStatus(this.config.sandbox, {
      connected: false,
      last_error: null,
    });
    this._loop();
  }

  async _loop() {
    while (!this.stopped) {
      try {
        await this._connectOnce();
      } catch (err) {
        setDiscordBridgeStatus(this.config.sandbox, {
          connected: false,
          last_error: err instanceof Error ? err.message : String(err),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, DISCORD_RECONNECT_MS));
    }
  }

  async _connectOnce() {
    if (typeof WebSocket !== "function") {
      throw new Error("node_websocket_unavailable");
    }
    const me = await discordRest(this.config.token, "GET", "/users/@me");
    this.botId = String(me?.id || "");
    if (!this.botId) throw new Error("discord_bot_identity_missing");
    const gateway = await discordRest(this.config.token, "GET", "/gateway/bot");
    const gatewayUrl = `${gateway.url}?v=10&encoding=json`;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(gatewayUrl);
      let settled = false;
      const finish = (err) => {
        if (this.heartbeat) {
          clearInterval(this.heartbeat);
          this.heartbeat = null;
        }
        setDiscordBridgeStatus(this.config.sandbox, { connected: false });
        if (settled) {
          resolve();
          return;
        }
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      ws.addEventListener("message", (event) => {
        let payload;
        try {
          payload = JSON.parse(websocketDataToString(event.data));
        } catch {
          return;
        }
        if (typeof payload.s === "number") this.sequence = payload.s;
        if (payload.op === 10) {
          const interval = Number(payload.d?.heartbeat_interval || 45_000);
          this.heartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ op: 1, d: this.sequence }));
            }
          }, interval);
          ws.send(
            JSON.stringify({
              op: 2,
              d: {
                token: this.config.token,
                intents: DISCORD_GATEWAY_INTENTS,
                properties: {
                  os: process.platform,
                  browser: "nemoclaw-hermes-discord-bridge",
                  device: "nemoclaw-hermes-discord-bridge",
                },
              },
            }),
          );
          return;
        }
        if (payload.op === 0 && payload.t === "READY") {
          const guilds = Array.isArray(payload.d?.guilds) ? payload.d.guilds : [];
          setDiscordBridgeStatus(this.config.sandbox, {
            connected: true,
            bot_id: this.botId,
            guild_count: guilds.length,
            last_error: null,
          });
          return;
        }
        if (payload.op === 0 && payload.t === "MESSAGE_CREATE") {
          handleDiscordMessage(this.config, this.botId, payload.d).catch((err) => {
            setDiscordBridgeStatus(this.config.sandbox, {
              last_error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      });
      ws.addEventListener("close", (event) => {
        const reason = event?.code ? `discord_gateway_closed_${event.code}` : null;
        finish(reason ? new Error(reason) : null);
      });
      ws.addEventListener("error", () => {
        finish(new Error("discord_gateway_error"));
      });
    });
  }
}

function startDiscordBridges() {
  for (const config of DISCORD_BRIDGE_CONFIGS) {
    const bridge = new DiscordBridge(config);
    bridge.start();
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        discord_bridges: Array.from(discordBridgeStatuses.values()),
      }),
    );
    return;
  }

  const route = parseRoute(req.url);
  if (!route) {
    sendText(res, 404, "Unknown Hermes tool gateway route");
    return;
  }

  const loaded = findStateByBrokerToken(extractBrokerToken(req));
  if (!loaded) {
    sendText(res, 401, "Unauthorized Hermes tool gateway broker request");
    return;
  }

  let accessToken;
  try {
    accessToken = await refreshAccessToken(loaded);
  } catch (err) {
    const code = errorCode(err);
    if (code === "reauth_required" || code === "missing_refresh_token") {
      sendText(
        res,
        401,
        "Nous host credentials are unavailable. Re-run `nemoclaw onboard --resume --agent hermes` to re-authorize.",
      );
      return;
    }
    if (code === "tool_gateway_requires_oauth") {
      sendText(
        res,
        401,
        "Nous managed tools require Nous Portal OAuth. Re-run `nemoclaw onboard --resume --agent hermes` and choose Nous Portal OAuth to enable tool gateways.",
      );
      return;
    }
    sendText(res, 502, "Hermes tool gateway broker could not refresh host OAuth state");
    return;
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch {
    sendText(res, 400, "Could not read request body");
    return;
  }

  try {
    const upstreamResp = await fetch(route.upstreamUrl, {
      method: req.method,
      headers: buildForwardHeaders(req, route, accessToken),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const responseBody = Buffer.from(await upstreamResp.arrayBuffer());
    res.writeHead(upstreamResp.status, forwardResponseHeaders(upstreamResp));
    res.end(responseBody);
  } catch {
    sendText(res, 502, "Hermes tool gateway upstream request failed");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Hermes tool gateway broker listening on 0.0.0.0:${PORT}`);
  startDiscordBridges();
});
