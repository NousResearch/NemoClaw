// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Generate Hermes config.yaml and .env from NemoClaw build-arg env vars.
//
// Called at Docker image build time. Reads NEMOCLAW_* env vars and writes:
//   ~/.hermes/config.yaml  — Hermes configuration (immutable at runtime)
//   ~/.hermes/.env         — Messaging token placeholders (immutable at runtime)
//
// Sets what's required for Hermes to run inside OpenShell:
//   - Model and inference endpoint (custom provider pointing at inference.local)
//   - API server on internal port (socat forwards to public port)
//   - Messaging platform tokens (if configured during onboard)
//   - Agent defaults (terminal, memory, skills, display)

import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TOKEN_ENV: Record<string, string> = {
  telegram: "TELEGRAM_BOT_TOKEN",
  discord: "DISCORD_BOT_TOKEN",
  slack: "SLACK_BOT_TOKEN",
};

const ALLOWED_USERS_ENV: Record<string, string> = {
  telegram: "TELEGRAM_ALLOWED_USERS",
  discord: "DISCORD_ALLOWED_USERS",
  slack: "SLACK_ALLOWED_USERS",
};

/**
 * Per-provider API key env-var names. Hermes's provider adapters
 * (anthropic_adapter.py, openai client, etc.) read these from the
 * process environment before sending a request — they short-circuit
 * with an "in-process credentials missing" error if the env var is
 * empty, *even when* the actual outbound call is going to be
 * substituted by OpenShell's L7 proxy.
 *
 * We satisfy the in-process check by writing an OpenShell resolve
 * placeholder. The proxy rewrites the real header value at egress
 * (verified empirically: any non-empty x-api-key works because the
 * proxy overrides it). The placeholder string `openshell:resolve:env:X`
 * is the same pattern OpenShell uses for messaging tokens.
 */
const PROVIDER_API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  // "custom"/"inference" providers don't have a fixed credential env var
  // in Hermes — those flows expect either no key (handled by proxy) or
  // a per-user override via .env. No emission needed by default.
};

/**
 * Map NemoClaw's provider key (from getSandboxInferenceConfig in
 * src/lib/onboard-providers.ts) to the Hermes-side provider value
 * accepted in config.yaml's `model.provider` field.
 *
 * Hermes recognises a small set of provider names; "custom" means
 * "generic OpenAI-compatible endpoint" which is the right behaviour
 * for everything that isn't Anthropic-Messages-shaped.
 */
function mapProvider(providerKey: string): string {
  switch (providerKey) {
    case "anthropic":
      return "anthropic";
    case "openai":
      return "openai";
    case "inference":
    case "custom":
    default:
      return "custom";
  }
}

function main(): void {
  const model = process.env.NEMOCLAW_MODEL!;
  const baseUrl = process.env.NEMOCLAW_INFERENCE_BASE_URL!;
  const providerKey = (process.env.NEMOCLAW_PROVIDER_KEY ?? "custom").trim();

  const channelsB64 = process.env.NEMOCLAW_MESSAGING_CHANNELS_B64 || "W10=";
  const allowedIdsB64 = process.env.NEMOCLAW_MESSAGING_ALLOWED_IDS_B64 || "e30=";

  const msgChannels: string[] = JSON.parse(Buffer.from(channelsB64, "base64").toString("utf-8"));
  const allowedIds: Record<string, (string | number)[]> = JSON.parse(
    Buffer.from(allowedIdsB64, "base64").toString("utf-8"),
  );

  // Map NemoClaw's provider key (set by onboard.ts via getSandboxInferenceConfig)
  // to the Hermes-side provider name in config.yaml. The key values come from
  // src/lib/onboard-providers.ts:
  //   "anthropic" — anthropic-prod / compatible-anthropic-endpoint
  //   "openai"    — openai-api
  //   "inference" — gemini-api / nvidia-prod / nvidia-nim / compatible-endpoint
  //                 (everything that ends up routed as OpenAI-compatible
  //                 through the inference.local proxy)
  //   "custom"    — legacy/fallback default; treated as OpenAI-compatible
  //
  // Hermes accepts these provider names natively (see hermes_cli/web_server.py):
  //   "anthropic" — Anthropic Messages API (POST /v1/messages)
  //   "openai"    — OpenAI Chat Completions
  //   "custom"    — generic OpenAI-compatible endpoint
  //
  // Without this mapping, Hermes would always speak OpenAI-format to the
  // proxy, which fails for any Anthropic-routed sandbox.
  const hermesProvider = mapProvider(providerKey);

  const config: Record<string, unknown> = {
    _config_version: 22,
    model: {
      default: model,
      provider: hermesProvider,
      base_url: baseUrl,
    },
    terminal: {
      backend: "local",
      timeout: 180,
    },
    agent: {
      max_turns: 60,
      reasoning_effort: "medium",
    },
    memory: {
      memory_enabled: true,
      user_profile_enabled: true,
    },
    skills: {
      creation_nudge_interval: 15,
    },
    display: {
      compact: false,
      tool_progress: "all",
    },
  };

  // Messaging platforms (if configured during onboard)
  const platformsConfig: Record<string, Record<string, unknown>> = {};
  for (const ch of msgChannels) {
    if (ch in TOKEN_ENV) {
      const pCfg: Record<string, unknown> = {
        enabled: true,
        token: `openshell:resolve:env:${TOKEN_ENV[ch]}`,
      };
      if (ch in allowedIds && allowedIds[ch]?.length) {
        pCfg.extra = {
          allowed_users: allowedIds[ch].map(String).join(","),
        };
      }
      platformsConfig[ch] = pCfg;
    }
  }

  if (Object.keys(platformsConfig).length > 0) {
    config.platforms = platformsConfig;
  }

  // API server — internal port only.
  // Hermes binds to 127.0.0.1 regardless of config (upstream bug).
  // socat in start.sh forwards 0.0.0.0:8642 -> 127.0.0.1:18642.
  const platforms = (config.platforms ?? {}) as Record<string, unknown>;
  platforms.api_server = {
    enabled: true,
    extra: {
      port: 18642,
      host: "127.0.0.1",
    },
  };
  config.platforms = platforms;

  // Write config.yaml — use inline YAML serialization (no external dep)
  const configPath = join(homedir(), ".hermes", "config.yaml");
  writeFileSync(configPath, toYaml(config));
  chmodSync(configPath, 0o600);

  // Write .env — API server config, provider credential placeholder
  // (so Hermes's in-process credential checks pass; the OpenShell L7
  // proxy substitutes the real value on egress), and messaging token
  // placeholders.
  const envLines: string[] = ["API_SERVER_PORT=18642", "API_SERVER_HOST=127.0.0.1"];

  const providerCredEnv = PROVIDER_API_KEY_ENV[providerKey];
  if (providerCredEnv) {
    envLines.push(`${providerCredEnv}=openshell:resolve:env:${providerCredEnv}`);
  }

  for (const ch of msgChannels) {
    if (ch in TOKEN_ENV) {
      envLines.push(`${TOKEN_ENV[ch]}=openshell:resolve:env:${TOKEN_ENV[ch]}`);
    }
    if (ch in ALLOWED_USERS_ENV && allowedIds[ch]?.length) {
      const allowed = allowedIds[ch].map(String).join(",");
      envLines.push(`${ALLOWED_USERS_ENV[ch]}=${allowed}`);
      if (ch === "telegram") {
        const homeChannel = allowedIds[ch][0];
        envLines.push(`TELEGRAM_HOME_CHANNEL=${String(homeChannel)}`);
        envLines.push("TELEGRAM_HOME_CHANNEL_NAME=NemoHermes DM");
      }
    }
  }

  const envPath = join(homedir(), ".hermes", ".env");
  writeFileSync(envPath, envLines.length > 0 ? envLines.join("\n") + "\n" : "");
  chmodSync(envPath, 0o600);

  console.log(`[config] Wrote ${configPath} (model=${model}, provider=custom)`);
  console.log(`[config] Wrote ${envPath} (${envLines.length} entries)`);
}

/** Minimal YAML serializer for flat/nested objects — no external dependency. */
function toYaml(obj: Record<string, unknown>, indent: number = 0): string {
  const pad = "  ".repeat(indent);
  let out = "";
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      out += `${pad}${key}: null\n`;
    } else if (typeof value === "object" && !Array.isArray(value)) {
      out += `${pad}${key}:\n`;
      out += toYaml(value as Record<string, unknown>, indent + 1);
    } else if (typeof value === "string") {
      out += `${pad}${key}: ${yamlString(value)}\n`;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out += `${pad}${key}: ${value}\n`;
    }
  }
  return out;
}

/** Quote a YAML string if it contains special characters. */
function yamlString(s: string): string {
  if (
    /[:{}\[\],&*?|>!%@`#'"]/.test(s) ||
    s.includes("\n") ||
    s.trim() !== s ||
    /^(?:[-+]?\d+(?:\.\d+)?|true|false|null|~)$/i.test(s)
  ) {
    return JSON.stringify(s);
  }
  return s;
}

main();
