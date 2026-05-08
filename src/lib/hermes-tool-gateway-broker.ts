// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Hermes Provider host-side Nous credential and managed-tool broker lifecycle.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { ROOT, SCRIPTS, run, runCapture, validateName } = require("./runner");
const { buildSubprocessEnv } = require("./subprocess-env");
const { getCredsDir, resolveProviderCredential } = require("./credentials/store");
const { HERMES_TOOL_GATEWAY_PORT } = require("./core/ports");
const oauth = require("./oauth-device-code");
const onboardProviders = require("./onboard/providers");
const registry = require("./state/registry");

const HERMES_TOOL_BROKER_CREDENTIAL_ENV = "NEMOCLAW_HERMES_TOOL_BROKER_TOKEN";
const HERMES_INFERENCE_CREDENTIAL_ENV = "OPENAI_API_KEY";
const HERMES_NOUS_API_KEY_CREDENTIAL_ENV = "NOUS_API_KEY";
const HERMES_PROVIDER_NAME = "hermes-provider";
const HERMES_TOOL_BROKER_PID_PATH = path.join(getCredsDir(), "hermes-tool-gateway-broker.pid");
const HERMES_TOOL_BROKER_CONFIG_HASH_PATH = path.join(
  getCredsDir(),
  "hermes-tool-gateway-broker.hash",
);
const HERMES_OAUTH_DIR = path.join(getCredsDir(), "hermes-oauth");
const HERMES_BRIDGE_DIR = path.join(getCredsDir(), "hermes-bridges");
const ACCESS_REFRESH_SKEW_MS = 120_000;
const AGENT_KEY_MIN_TTL_SECONDS = 1800;

let brokerStartedThisRun = false;

function sleep(seconds) {
  spawnSync("sleep", [String(seconds)]);
}

function ensurePrivateStateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function ensureHermesOAuthDir() {
  ensurePrivateStateDir(HERMES_OAUTH_DIR);
}

function ensureHermesBridgeDir() {
  ensurePrivateStateDir(HERMES_BRIDGE_DIR);
}

function getHermesOAuthStatePath(sandboxName) {
  const safeName = validateName(sandboxName, "sandbox name");
  ensureHermesOAuthDir();
  return path.join(HERMES_OAUTH_DIR, `${safeName}.json`);
}

function atomicWriteJson(file, value, ensureDir = ensureHermesOAuthDir) {
  ensureDir();
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function loadHermesOAuthState(sandboxName) {
  const file = getHermesOAuthStatePath(sandboxName);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function persistHermesOAuthState(sandboxName, state) {
  const file = getHermesOAuthStatePath(sandboxName);
  atomicWriteJson(file, {
    version: 1,
    sandbox: sandboxName,
    ...state,
    updated_at: new Date().toISOString(),
  });
}

function getHermesBridgeStatePath(sandboxName) {
  const safeName = validateName(sandboxName, "sandbox name");
  ensureHermesBridgeDir();
  return path.join(HERMES_BRIDGE_DIR, `${safeName}.json`);
}

function loadHermesBridgeState(sandboxName) {
  const file = getHermesBridgeStatePath(sandboxName);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function persistHermesDiscordBridgeState(sandboxName, config = {}) {
  const token = String(config.token || "").trim();
  if (!token) return false;
  const existing = loadHermesBridgeState(sandboxName) || {};
  const file = getHermesBridgeStatePath(sandboxName);
  atomicWriteJson(
    file,
    {
      version: 1,
      sandbox: sandboxName,
      ...existing,
      discord: {
        token,
        guildIds: uniqueStrings(config.guildIds),
        allowedUserIds: uniqueStrings(config.allowedUserIds),
        requireMention: config.requireMention !== false,
      },
      updated_at: new Date().toISOString(),
    },
    ensureHermesBridgeDir,
  );
  return true;
}

function deleteHermesDiscordBridgeState(sandboxName) {
  const file = getHermesBridgeStatePath(sandboxName);
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function tokenExpiresSoon(expiresAt, skewMs = ACCESS_REFRESH_SKEW_MS) {
  if (!expiresAt || typeof expiresAt !== "string") return true;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) return true;
  return timestamp - Date.now() < skewMs;
}

function withTokenMetadata(existing, tokenResp) {
  const now = new Date();
  const expiresIn =
    typeof tokenResp.expires_in === "number" && Number.isFinite(tokenResp.expires_in)
      ? tokenResp.expires_in
      : 900;
  return {
    ...(existing || {}),
    auth_method: "oauth",
    api_key: undefined,
    access_token: tokenResp.access_token,
    refresh_token: tokenResp.refresh_token,
    token_type: tokenResp.token_type || "Bearer",
    scope: tokenResp.scope || existing?.scope || "inference:mint_agent_key",
    expires_in: expiresIn,
    expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    obtained_at: now.toISOString(),
    client_id: oauth.DEFAULT_CLIENT_ID,
    portal_base_url: oauth.DEFAULT_PORTAL_BASE_URL,
    inference_base_url: oauth.DEFAULT_INFERENCE_BASE_URL,
    broker_token: existing?.broker_token || crypto.randomBytes(32).toString("hex"),
  };
}

function withApiKeyMetadata(existing, apiKey) {
  const now = new Date();
  return {
    version: 1,
    sandbox: existing?.sandbox || null,
    auth_method: "api_key",
    api_key: apiKey,
    access_token: apiKey,
    token_type: "Bearer",
    portal_base_url: oauth.DEFAULT_PORTAL_BASE_URL,
    inference_base_url: oauth.DEFAULT_INFERENCE_BASE_URL,
    broker_token: existing?.broker_token || crypto.randomBytes(32).toString("hex"),
    obtained_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

async function ensureHermesOAuthState(
  sandboxName,
  { allowInteractiveLogin = true, log = console.error, fetch = undefined } = {},
) {
  let state = loadHermesOAuthState(sandboxName);
  if (state?.refresh_token && state.access_token && !tokenExpiresSoon(state.expires_at)) {
    if (!state.broker_token) {
      state = { ...state, broker_token: crypto.randomBytes(32).toString("hex") };
      persistHermesOAuthState(sandboxName, state);
    }
    return state;
  }

  if (state?.refresh_token) {
    try {
      const refreshed = await oauth.refreshAccessTokenWithRefreshToken(state.refresh_token, {
        fetch,
      });
      state = withTokenMetadata(state, refreshed);
      persistHermesOAuthState(sandboxName, state);
      return state;
    } catch (err) {
      if (!allowInteractiveLogin) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      log(`  ⚠ Hermes Provider OAuth refresh failed: ${message}`);
      log("    Falling back to browser authorization.");
    }
  }

  if (!allowInteractiveLogin) {
    return null;
  }

  const tokens = await oauth.runDeviceCodeFlow({ fetch });
  state = withTokenMetadata(state, tokens);
  persistHermesOAuthState(sandboxName, state);
  return state;
}

async function ensureHermesAgentKey(sandboxName, state, { fetch = undefined } = {}) {
  if (
    state?.agent_key &&
    !tokenExpiresSoon(state.agent_key_expires_at, AGENT_KEY_MIN_TTL_SECONDS * 1000)
  ) {
    return state;
  }

  const minted = await oauth.mintAgentKeyWithAccessToken(state.access_token, {
    fetch,
    minTtlSeconds: AGENT_KEY_MIN_TTL_SECONDS,
  });
  const now = new Date();
  const expiresIn =
    typeof minted.expires_in === "number" && Number.isFinite(minted.expires_in)
      ? minted.expires_in
      : AGENT_KEY_MIN_TTL_SECONDS;
  const next = {
    ...state,
    agent_key: minted.api_key,
    agent_key_id: minted.key_id || null,
    agent_key_expires_at:
      minted.expires_at || new Date(now.getTime() + expiresIn * 1000).toISOString(),
    agent_key_expires_in: expiresIn,
    agent_key_reused: Boolean(minted.reused),
    agent_key_obtained_at: now.toISOString(),
    inference_base_url: minted.inference_base_url || state.inference_base_url,
  };
  persistHermesOAuthState(sandboxName, next);
  return next;
}

function getHermesToolBrokerProviderName(sandboxName) {
  return `${validateName(sandboxName, "sandbox name")}-hermes-tool-broker`;
}

function upsertProvider(name, type, credentialEnv, baseUrl, env, runOpenshell) {
  const result = onboardProviders.upsertProvider(
    name,
    type,
    credentialEnv,
    baseUrl,
    env,
    runOpenshell,
  );
  if (!result.ok) {
    throw new Error(result.message || `failed to upsert provider '${name}'`);
  }
}

function registerHermesToolBrokerProvider(sandboxName, brokerToken, runOpenshell) {
  upsertProvider(
    getHermesToolBrokerProviderName(sandboxName),
    "generic",
    HERMES_TOOL_BROKER_CREDENTIAL_ENV,
    null,
    { [HERMES_TOOL_BROKER_CREDENTIAL_ENV]: brokerToken },
    runOpenshell,
  );
}

function registerHermesInferenceProvider(
  apiKey,
  runOpenshell,
  credentialEnv = HERMES_INFERENCE_CREDENTIAL_ENV,
) {
  upsertProvider(
    HERMES_PROVIDER_NAME,
    "openai",
    credentialEnv,
    oauth.DEFAULT_INFERENCE_BASE_URL,
    { [credentialEnv]: apiKey },
    runOpenshell,
  );
}

function persistBrokerPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  fs.mkdirSync(getCredsDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(HERMES_TOOL_BROKER_PID_PATH, `${pid}\n`, { mode: 0o600 });
  fs.chmodSync(HERMES_TOOL_BROKER_PID_PATH, 0o600);
}

function loadBrokerPid() {
  try {
    const raw = fs.readFileSync(HERMES_TOOL_BROKER_PID_PATH, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearBrokerPid() {
  try {
    fs.unlinkSync(HERMES_TOOL_BROKER_PID_PATH);
  } catch {
    /* ignore */
  }
}

function persistBrokerConfigHash(hash) {
  fs.mkdirSync(getCredsDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(HERMES_TOOL_BROKER_CONFIG_HASH_PATH, `${hash}\n`, { mode: 0o600 });
  fs.chmodSync(HERMES_TOOL_BROKER_CONFIG_HASH_PATH, 0o600);
}

function loadBrokerConfigHash() {
  try {
    return fs.readFileSync(HERMES_TOOL_BROKER_CONFIG_HASH_PATH, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function clearBrokerConfigHash() {
  try {
    fs.unlinkSync(HERMES_TOOL_BROKER_CONFIG_HASH_PATH);
  } catch {
    /* ignore */
  }
}

function isHermesToolBrokerProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const cmdline = runCapture(["ps", "-p", String(pid), "-o", "args="], { ignoreError: true });
  return Boolean(cmdline && cmdline.includes("hermes-tool-gateway-broker.js"));
}

function isHermesToolGatewayBrokerHealthy() {
  const result = run(
    [
      "curl",
      "-sf",
      "--connect-timeout",
      "3",
      "--max-time",
      "5",
      `http://127.0.0.1:${HERMES_TOOL_GATEWAY_PORT}/health`,
    ],
    { ignoreError: true, suppressOutput: true },
  );
  return result.status === 0;
}

function csvValues(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  return [
    ...new Set(
      (values || [])
        .map(String)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function buildDiscordBridgeConfigs() {
  const envToken = resolveProviderCredential("DISCORD_BOT_TOKEN");

  let sandboxes = [];
  try {
    sandboxes = registry.listSandboxes().sandboxes || [];
  } catch {
    return [];
  }

  return sandboxes
    .filter((sandbox) => {
      const bridgeState = loadHermesBridgeState(sandbox.name)?.discord || {};
      const hasRegistryChannel =
        Array.isArray(sandbox.messagingChannels) && sandbox.messagingChannels.includes("discord");
      const hasPersistedBridge =
        typeof bridgeState.token === "string" && bridgeState.token.trim().length > 0;
      return (
        (sandbox.agent === "hermes" || sandbox.provider === HERMES_PROVIDER_NAME) &&
        (hasRegistryChannel || hasPersistedBridge) &&
        !(sandbox.disabledChannels || []).includes("discord")
      );
    })
    .map((sandbox) => {
      const discordConfig = sandbox.messagingBridgeConfig?.discord || {};
      const bridgeState = loadHermesBridgeState(sandbox.name)?.discord || {};
      const envGuildIds = csvValues(
        process.env.DISCORD_SERVER_IDS || process.env.DISCORD_SERVER_ID,
      );
      const envUserIds = csvValues(process.env.DISCORD_ALLOWED_IDS || process.env.DISCORD_USER_ID);
      const configuredGuildIds = uniqueStrings(discordConfig.guildIds);
      const configuredUserIds = uniqueStrings(discordConfig.allowedUserIds);
      const stateGuildIds = uniqueStrings(bridgeState.guildIds);
      const stateUserIds = uniqueStrings(bridgeState.allowedUserIds);
      const token =
        envToken || (typeof bridgeState.token === "string" ? bridgeState.token.trim() : "");
      if (!token) return null;
      const bridgeConfig = {
        sandbox: sandbox.name,
        token,
        guildIds:
          configuredGuildIds.length > 0
            ? configuredGuildIds
            : stateGuildIds.length > 0
              ? stateGuildIds
              : envGuildIds,
        allowedUserIds:
          configuredUserIds.length > 0
            ? configuredUserIds
            : stateUserIds.length > 0
              ? stateUserIds
              : envUserIds,
        requireMention:
          typeof discordConfig.requireMention === "boolean"
            ? discordConfig.requireMention
            : typeof bridgeState.requireMention === "boolean"
              ? bridgeState.requireMention
              : process.env.DISCORD_REQUIRE_MENTION !== "0",
      };
      if (envToken) {
        persistHermesDiscordBridgeState(sandbox.name, bridgeConfig);
      }
      return {
        ...bridgeConfig,
      };
    })
    .filter(Boolean);
}

function buildBrokerRuntimeConfig() {
  return {
    discordBridges: buildDiscordBridgeConfigs(),
  };
}

function hashBrokerRuntimeConfig(config) {
  return crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function killStaleHermesToolGatewayBroker() {
  const persistedPid = loadBrokerPid();
  if (isHermesToolBrokerProcess(persistedPid)) {
    run(["kill", String(persistedPid)], { ignoreError: true, suppressOutput: true });
  }
  clearBrokerPid();
  clearBrokerConfigHash();
}

function spawnHermesToolGatewayBroker(config) {
  ensureHermesOAuthDir();
  const runtimeConfig = config || buildBrokerRuntimeConfig();
  const encodedDiscordBridges = Buffer.from(
    JSON.stringify(runtimeConfig.discordBridges || []),
    "utf8",
  ).toString("base64");
  const child = spawn(process.execPath, [path.join(SCRIPTS, "hermes-tool-gateway-broker.js")], {
    detached: true,
    stdio: "ignore",
    env: buildSubprocessEnv({
      HERMES_TOOL_GATEWAY_PORT: String(HERMES_TOOL_GATEWAY_PORT),
      HERMES_TOOL_GATEWAY_STATE_DIR: HERMES_OAUTH_DIR,
      NOUS_PORTAL_BASE_URL: process.env.NOUS_PORTAL_BASE_URL || oauth.DEFAULT_PORTAL_BASE_URL,
      NEMOCLAW_HERMES_DISCORD_BRIDGES_B64: encodedDiscordBridges,
    }),
    cwd: ROOT,
  });
  child.unref();
  persistBrokerPid(child.pid);
  persistBrokerConfigHash(hashBrokerRuntimeConfig(runtimeConfig));
  return child.pid ?? null;
}

function ensureHermesToolGatewayBroker(options = {}) {
  const runtimeConfig = buildBrokerRuntimeConfig();
  const desiredConfigHash = hashBrokerRuntimeConfig(runtimeConfig);
  const configMatches = loadBrokerConfigHash() === desiredConfigHash;
  if (
    !options.forceRestart &&
    configMatches &&
    brokerStartedThisRun &&
    isHermesToolGatewayBrokerHealthy()
  ) {
    return true;
  }
  const pid = loadBrokerPid();
  if (
    !options.forceRestart &&
    configMatches &&
    isHermesToolBrokerProcess(pid) &&
    isHermesToolGatewayBrokerHealthy()
  ) {
    brokerStartedThisRun = true;
    return true;
  }
  if (!options.forceRestart && configMatches && isHermesToolGatewayBrokerHealthy()) {
    brokerStartedThisRun = true;
    return true;
  }
  killStaleHermesToolGatewayBroker();
  const startedPid = spawnHermesToolGatewayBroker(runtimeConfig);
  for (let attempt = 0; attempt < 10; attempt++) {
    if (isHermesToolBrokerProcess(startedPid) && isHermesToolGatewayBrokerHealthy()) {
      brokerStartedThisRun = true;
      return true;
    }
    sleep(1);
  }
  return false;
}

async function ensureHermesProviderHostCredentials(
  sandboxName,
  {
    authMethod = null,
    apiKey = null,
    allowInteractiveLogin = true,
    runOpenshell = null,
    log = console.error,
    fetch = undefined,
  } = {},
) {
  const existing = loadHermesOAuthState(sandboxName);
  const effectiveAuthMethod =
    authMethod || (existing?.auth_method === "api_key" || existing?.api_key ? "api_key" : "oauth");

  if (effectiveAuthMethod === "api_key") {
    return ensureHermesProviderApiKeyCredentials(sandboxName, {
      apiKey,
      runOpenshell,
    });
  }

  let state = await ensureHermesOAuthState(sandboxName, {
    allowInteractiveLogin,
    log,
    fetch,
  });
  if (!state) return null;

  state = await ensureHermesAgentKey(sandboxName, state, { fetch });

  if (runOpenshell) {
    registerHermesInferenceProvider(state.agent_key, runOpenshell);
    registerHermesToolBrokerProvider(sandboxName, state.broker_token, runOpenshell);
  }

  const brokerReady = ensureHermesToolGatewayBroker();
  if (!brokerReady) {
    throw new Error(
      `Hermes tool gateway broker did not become ready on :${HERMES_TOOL_GATEWAY_PORT}`,
    );
  }
  return state;
}

async function ensureHermesProviderApiKeyCredentials(
  sandboxName,
  { apiKey = null, runOpenshell = null } = {},
) {
  const existing = loadHermesOAuthState(sandboxName);
  const existingApiKey =
    existing?.auth_method === "api_key" || existing?.api_key
      ? existing.api_key || existing.access_token
      : null;
  const normalizedApiKey = String(apiKey || existingApiKey || "").trim();
  if (!normalizedApiKey) return null;

  let state = existing;
  if (
    !state ||
    state.auth_method !== "api_key" ||
    state.api_key !== normalizedApiKey ||
    !state.broker_token
  ) {
    state = withApiKeyMetadata(
      {
        sandbox: sandboxName,
        broker_token: existing?.broker_token,
      },
      normalizedApiKey,
    );
    persistHermesOAuthState(sandboxName, state);
  }

  if (runOpenshell) {
    registerHermesInferenceProvider(
      normalizedApiKey,
      runOpenshell,
      HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
    );
    registerHermesToolBrokerProvider(sandboxName, state.broker_token, runOpenshell);
  }

  const brokerReady = ensureHermesToolGatewayBroker();
  if (!brokerReady) {
    throw new Error(
      `Hermes tool gateway broker did not become ready on :${HERMES_TOOL_GATEWAY_PORT}`,
    );
  }
  return state;
}

function getHermesBrokerToken(sandboxName) {
  return loadHermesOAuthState(sandboxName)?.broker_token || null;
}

module.exports = {
  HERMES_TOOL_BROKER_CREDENTIAL_ENV,
  HERMES_INFERENCE_CREDENTIAL_ENV,
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
  HERMES_PROVIDER_NAME,
  HERMES_OAUTH_DIR,
  HERMES_BRIDGE_DIR,
  HERMES_TOOL_GATEWAY_PORT,
  getHermesOAuthStatePath,
  getHermesBridgeStatePath,
  loadHermesOAuthState,
  loadHermesBridgeState,
  persistHermesOAuthState,
  persistHermesDiscordBridgeState,
  deleteHermesDiscordBridgeState,
  ensureHermesOAuthState,
  ensureHermesAgentKey,
  ensureHermesProviderHostCredentials,
  ensureHermesProviderApiKeyCredentials,
  ensureHermesToolGatewayBroker,
  buildBrokerRuntimeConfig,
  isHermesToolGatewayBrokerHealthy,
  killStaleHermesToolGatewayBroker,
  getHermesToolBrokerProviderName,
  getHermesBrokerToken,
};
