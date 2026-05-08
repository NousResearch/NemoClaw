// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/* global fetch, URLSearchParams */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "hermes-tool-gateway-broker.js");
const require = createRequire(import.meta.url);
const DIST_BROKER = path.join(
  import.meta.dirname,
  "..",
  "dist",
  "lib",
  "hermes-tool-gateway-broker.js",
);
const DIST_REGISTRY = path.join(import.meta.dirname, "..", "dist", "lib", "state", "registry.js");
const DIST_CREDENTIALS = path.join(
  import.meta.dirname,
  "..",
  "dist",
  "lib",
  "credentials",
  "store.js",
);

let children: ChildProcess[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("no port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function b64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function clearDistModule(modulePath: string): void {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Module was not loaded in this test process.
  }
}

function loadBrokerModulesForHome(home: string): {
  broker: Record<string, any>;
  registry: Record<string, any>;
} {
  process.env.HOME = home;
  clearDistModule(DIST_BROKER);
  clearDistModule(DIST_REGISTRY);
  clearDistModule(DIST_CREDENTIALS);
  return {
    broker: require(DIST_BROKER),
    registry: require(DIST_REGISTRY),
  };
}

async function waitForHealth(port: number): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`);
      if (resp.status === 200) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("broker did not become healthy");
}

afterEach(async () => {
  for (const child of children) {
    child.kill("SIGTERM");
  }
  children = [];
});

describe("Hermes tool gateway broker", () => {
  it("persists host-side Discord bridge state for broker restarts", () => {
    const originalHome = process.env.HOME;
    const originalToken = process.env.DISCORD_BOT_TOKEN;
    const originalServerId = process.env.DISCORD_SERVER_ID;
    const originalUserId = process.env.DISCORD_USER_ID;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-discord-state-"));

    try {
      process.env.DISCORD_BOT_TOKEN = "discord-secret";
      process.env.DISCORD_SERVER_ID = "guild-env";
      process.env.DISCORD_USER_ID = "user-env";
      const { broker, registry } = loadBrokerModulesForHome(tmp);
      registry.registerSandbox({
        name: "my-assistant",
        provider: broker.HERMES_PROVIDER_NAME,
        agent: "hermes",
        messagingChannels: ["discord"],
        messagingBridgeConfig: {
          discord: {
            guildIds: ["guild-1"],
            allowedUserIds: ["user-1"],
            requireMention: true,
          },
        },
      });

      const firstRuntime = broker.buildBrokerRuntimeConfig();
      expect(firstRuntime.discordBridges).toHaveLength(1);
      expect(firstRuntime.discordBridges[0]).toMatchObject({
        sandbox: "my-assistant",
        token: "discord-secret",
        guildIds: ["guild-1"],
        allowedUserIds: ["user-1"],
        requireMention: true,
      });

      const statePath = broker.getHermesBridgeStatePath("my-assistant");
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(state.discord.token).toBe("discord-secret");
      expect(fs.statSync(path.dirname(statePath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);

      delete process.env.DISCORD_BOT_TOKEN;
      delete process.env.DISCORD_SERVER_ID;
      delete process.env.DISCORD_USER_ID;
      const secondRuntime = broker.buildBrokerRuntimeConfig();
      expect(secondRuntime.discordBridges).toHaveLength(1);
      expect(secondRuntime.discordBridges[0]).toMatchObject({
        sandbox: "my-assistant",
        token: "discord-secret",
        guildIds: ["guild-1"],
        allowedUserIds: ["user-1"],
      });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = originalToken;
      if (originalServerId === undefined) delete process.env.DISCORD_SERVER_ID;
      else process.env.DISCORD_SERVER_ID = originalServerId;
      if (originalUserId === undefined) delete process.env.DISCORD_USER_ID;
      else process.env.DISCORD_USER_ID = originalUserId;
      clearDistModule(DIST_BROKER);
      clearDistModule(DIST_REGISTRY);
      clearDistModule(DIST_CREDENTIALS);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refreshes host OAuth, strips sandbox auth, and proxies allowlisted routes", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-broker-"));
    const statePath = path.join(tmp, "sandbox.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          version: 1,
          sandbox: "sandbox",
          broker_token: "broker-token",
          access_token: "expired-access",
          refresh_token: "refresh-1",
          expires_at: "2000-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const portalBodies: string[] = [];
    const portal = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        portalBodies.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "access-2",
            refresh_token: "refresh-2",
            expires_in: 900,
            token_type: "Bearer",
          }),
        );
      });
    });
    const portalPort = await listen(portal);

    const upstreamRequests: Array<{
      url?: string;
      authorization?: string;
      apiKey?: string;
      browserUseApiKey?: string;
      openaiApiKey?: string;
      acceptEncoding?: string;
    }> = [];
    const upstream = http.createServer((req, res) => {
      upstreamRequests.push({
        url: req.url,
        authorization: req.headers.authorization,
        apiKey: req.headers["x-api-key"] as string | undefined,
        browserUseApiKey: req.headers["x-browser-use-api-key"] as string | undefined,
        openaiApiKey: req.headers["openai-api-key"] as string | undefined,
        acceptEncoding: req.headers["accept-encoding"] as string | undefined,
      });
      if (req.url === "/browsers") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "browser-session",
            cdpUrl: "https://session.cdp4.browser-use.com",
          }),
        );
        return;
      }
      const body = zlib.gzipSync(JSON.stringify({ ok: true }));
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Content-Length": String(body.length),
        "Content-MD5": "not-a-real-digest",
      });
      res.end(body);
    });
    const upstreamPort = await listen(upstream);
    const brokerPort = await freePort();

    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        HERMES_TOOL_GATEWAY_PORT: String(brokerPort),
        HERMES_TOOL_GATEWAY_STATE_DIR: tmp,
        NOUS_PORTAL_BASE_URL: `http://127.0.0.1:${portalPort}`,
        HERMES_TOOL_GATEWAY_UPSTREAMS_JSON: JSON.stringify({
          firecrawl: `http://127.0.0.1:${upstreamPort}`,
          "browser-use": `http://127.0.0.1:${upstreamPort}`,
          "fal-queue": `http://127.0.0.1:${upstreamPort}`,
          "openai-audio": `http://127.0.0.1:${upstreamPort}`,
          modal: `http://127.0.0.1:${upstreamPort}`,
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    try {
      await waitForHealth(brokerPort);

      const denied = await fetch(`http://127.0.0.1:${brokerPort}/firecrawl/v1/scrape`, {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(denied.status).toBe(401);

      const unknown = await fetch(`http://127.0.0.1:${brokerPort}/unknown`);
      expect(unknown.status).toBe(404);

      const proxied = await fetch(`http://127.0.0.1:${brokerPort}/firecrawl/v1/scrape?debug=1`, {
        method: "POST",
        headers: {
          Authorization: "Bearer broker-token",
          "Content-Type": "application/json",
          "x-api-key": "sandbox-secret",
        },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      expect(proxied.status).toBe(200);
      expect(proxied.headers.get("content-encoding")).toBeNull();
      expect(proxied.headers.get("content-length")).toBeNull();
      expect(proxied.headers.get("content-md5")).toBeNull();
      expect(await proxied.json()).toEqual({ ok: true });

      expect(new URLSearchParams(portalBodies[0]).get("refresh_token")).toBe("refresh-1");
      expect(upstreamRequests[0]).toMatchObject({
        url: "/v1/scrape?debug=1",
        authorization: "Bearer access-2",
        acceptEncoding: "identity",
      });
      expect(upstreamRequests[0]?.apiKey).toBeUndefined();

      const browserUse = await fetch(`http://127.0.0.1:${brokerPort}/browser-use/browsers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Browser-Use-API-Key": "broker-token",
        },
        body: JSON.stringify({ timeout: 5 }),
      });
      expect(browserUse.status).toBe(200);
      const browserUsePayload = await browserUse.json();
      expect(browserUsePayload).toMatchObject({
        id: "browser-session",
        cdpUrl: "https://session.cdp4.browser-use.com",
      });
      expect(upstreamRequests[1]).toMatchObject({
        url: "/browsers",
        browserUseApiKey: "access-2",
      });
      expect(upstreamRequests[1]?.authorization).toBeUndefined();

      const falQueue = await fetch(`http://127.0.0.1:${brokerPort}/fal-queue/fal-ai/test`, {
        method: "POST",
        headers: {
          Authorization: "Key broker-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: "test" }),
      });
      expect(falQueue.status).toBe(200);
      expect(upstreamRequests[2]).toMatchObject({
        url: "/fal-ai/test",
        authorization: "Key access-2",
      });

      const openaiAudio = await fetch(
        `http://127.0.0.1:${brokerPort}/openai-audio/v1/audio/speech`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "openai-api-key": "broker-token",
          },
          body: JSON.stringify({ input: "hello", voice: "alloy", model: "tts-1" }),
        },
      );
      expect(openaiAudio.status).toBe(200);
      expect(upstreamRequests[3]).toMatchObject({
        url: "/v1/audio/speech",
        authorization: "Bearer access-2",
      });
      expect(upstreamRequests[3]?.openaiApiKey).toBeUndefined();

      const modal = await fetch(`http://127.0.0.1:${brokerPort}/modal/v1/sandboxes`, {
        method: "POST",
        headers: {
          Authorization: "Bearer broker-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ image: "python:3.11" }),
      });
      expect(modal.status).toBe(200);
      expect(upstreamRequests[4]).toMatchObject({
        url: "/v1/sandboxes",
        authorization: "Bearer access-2",
      });

      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(state.refresh_token).toBe("refresh-2");
      expect(state.access_token).toBe("access-2");
      expect(output).not.toContain("refresh-1");
      expect(output).not.toContain("access-2");
      expect(output).not.toContain("sandbox-secret");
      expect(output).not.toContain("broker-token");
    } finally {
      child.kill("SIGTERM");
      await close(portal);
      await close(upstream);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects managed-tool gateway requests when Hermes state uses a Nous API key", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-broker-api-key-"));
    const statePath = path.join(tmp, "sandbox.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          version: 1,
          sandbox: "sandbox",
          auth_method: "api_key",
          broker_token: "broker-token",
          api_key: "nous-api-key",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const upstreamRequests: Array<{ url?: string; authorization?: string }> = [];
    const upstream = http.createServer((req, res) => {
      upstreamRequests.push({
        url: req.url,
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamPort = await listen(upstream);
    const brokerPort = await freePort();

    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        HERMES_TOOL_GATEWAY_PORT: String(brokerPort),
        HERMES_TOOL_GATEWAY_STATE_DIR: tmp,
        NOUS_PORTAL_BASE_URL: "http://127.0.0.1:1",
        HERMES_TOOL_GATEWAY_UPSTREAMS_JSON: JSON.stringify({
          firecrawl: `http://127.0.0.1:${upstreamPort}`,
          "fal-queue": `http://127.0.0.1:${upstreamPort}`,
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    try {
      await waitForHealth(brokerPort);

      const proxied = await fetch(`http://127.0.0.1:${brokerPort}/firecrawl/v1/scrape`, {
        method: "POST",
        headers: {
          Authorization: "Bearer broker-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      expect(proxied.status).toBe(401);
      expect(await proxied.text()).toContain("Nous managed tools require Nous Portal OAuth");
      expect(upstreamRequests).toHaveLength(0);

      const falQueue = await fetch(`http://127.0.0.1:${brokerPort}/fal-queue/fal-ai/test`, {
        method: "POST",
        headers: {
          Authorization: "Key broker-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: "test" }),
      });
      expect(falQueue.status).toBe(401);
      expect(await falQueue.text()).toContain("Nous managed tools require Nous Portal OAuth");
      expect(upstreamRequests).toHaveLength(0);

      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(state.refresh_token).toBeUndefined();
      expect(output).not.toContain("nous-api-key");
      expect(output).not.toContain("broker-token");
    } finally {
      child.kill("SIGTERM");
      await close(upstream);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("starts host-side Discord bridge status without logging the bot token", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-discord-broker-"));
    const discordRequests: Array<{ url?: string; authorization?: string }> = [];
    const discordApi = http.createServer((req, res) => {
      discordRequests.push({
        url: req.url,
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/users/@me") {
        res.end(JSON.stringify({ id: "bot-1", username: "hermes-bot", bot: true }));
      } else if (req.url === "/gateway/bot") {
        res.end(JSON.stringify({ url: "ws://127.0.0.1:1", shards: 1 }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
    const discordPort = await listen(discordApi);
    const brokerPort = await freePort();

    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        HERMES_TOOL_GATEWAY_PORT: String(brokerPort),
        HERMES_TOOL_GATEWAY_STATE_DIR: tmp,
        NEMOCLAW_DISCORD_API_BASE_URL: `http://127.0.0.1:${discordPort}`,
        NEMOCLAW_HERMES_DISCORD_BRIDGES_B64: b64Json([
          {
            sandbox: "my-assistant",
            token: "discord-secret",
            guildIds: ["guild-1"],
            allowedUserIds: ["user-1"],
            requireMention: true,
          },
        ]),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    try {
      await waitForHealth(brokerPort);
      for (let i = 0; i < 20 && discordRequests.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const health = await fetch(`http://127.0.0.1:${brokerPort}/health`);
      expect(health.status).toBe(200);
      const payload = (await health.json()) as {
        discord_bridges: Array<{ sandbox: string }>;
      };
      expect(payload.discord_bridges[0]).toMatchObject({
        sandbox: "my-assistant",
      });
      expect(discordRequests[0]?.authorization).toBe("Bot discord-secret");
      expect(output).not.toContain("discord-secret");
    } finally {
      child.kill("SIGTERM");
      await close(discordApi);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
