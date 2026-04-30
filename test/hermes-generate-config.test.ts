// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "generate-config.ts");

function b64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

describe("Hermes config generation", () => {
  it("writes current Hermes config and env keys for DM-only Telegram", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-config-"));
    const hermesDir = path.join(tmpHome, ".hermes");
    fs.mkdirSync(hermesDir, { recursive: true });

    try {
      const result = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
          NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
          NEMOCLAW_MESSAGING_CHANNELS_B64: b64Json(["telegram"]),
          NEMOCLAW_MESSAGING_ALLOWED_IDS_B64: b64Json({ telegram: ["123456789"] }),
        },
      });

      expect(result.status).toBe(0);

      const configRaw = fs.readFileSync(path.join(hermesDir, "config.yaml"), "utf8");
      const config = YAML.parse(configRaw) as {
        _config_version: number;
        model: { provider: string; default: string; base_url: string };
        platforms: {
          telegram: { token: string; extra: { allowed_users: string } };
          api_server: { enabled: boolean; extra: { host: string; port: number } };
        };
      };

      expect(config._config_version).toBe(22);
      expect(config.model).toMatchObject({
        provider: "custom",
        default: "nvidia/nemotron-3-super-120b-a12b",
        base_url: "https://inference.local/v1",
      });
      expect(config.platforms.telegram.token).toBe("openshell:resolve:env:TELEGRAM_BOT_TOKEN");
      expect(config.platforms.telegram.extra.allowed_users).toBe("123456789");
      expect(config.platforms.api_server).toMatchObject({
        enabled: true,
        extra: { host: "127.0.0.1", port: 18642 },
      });

      const envRaw = fs.readFileSync(path.join(hermesDir, ".env"), "utf8");
      expect(envRaw).toContain("TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN");
      expect(envRaw).toContain("TELEGRAM_ALLOWED_USERS=123456789");
      expect(envRaw).toContain("TELEGRAM_HOME_CHANNEL=123456789");
      expect(envRaw).toContain("TELEGRAM_HOME_CHANNEL_NAME=NemoHermes DM");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // Provider mapping cases — NEMOCLAW_PROVIDER_KEY drives both the
  // Hermes-side model.provider value and the credential placeholder
  // emitted to .env.
  type ProviderCase = {
    label: string;
    providerKey: string;
    inferenceBaseUrl: string;
    expectedProvider: string;
    expectedEnvKeyLine: string | null;
    forbiddenEnvKeys?: string[];
  };

  const providerCases: ProviderCase[] = [
    {
      label: "anthropic-prod (and compatible-anthropic-endpoint)",
      providerKey: "anthropic",
      inferenceBaseUrl: "https://inference.local",
      expectedProvider: "anthropic",
      expectedEnvKeyLine: "ANTHROPIC_API_KEY=openshell:resolve:env:ANTHROPIC_API_KEY",
      forbiddenEnvKeys: ["OPENAI_API_KEY"],
    },
    {
      label: "openai-api",
      providerKey: "openai",
      inferenceBaseUrl: "https://inference.local/v1",
      expectedProvider: "openai",
      expectedEnvKeyLine: "OPENAI_API_KEY=openshell:resolve:env:OPENAI_API_KEY",
      forbiddenEnvKeys: ["ANTHROPIC_API_KEY"],
    },
    {
      label: "inference (gemini / nvidia / compatible-endpoint)",
      providerKey: "inference",
      inferenceBaseUrl: "https://inference.local/v1",
      expectedProvider: "custom",
      expectedEnvKeyLine: null,
      forbiddenEnvKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    },
    {
      label: "legacy/default custom",
      providerKey: "custom",
      inferenceBaseUrl: "https://inference.local/v1",
      expectedProvider: "custom",
      expectedEnvKeyLine: null,
      forbiddenEnvKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    },
  ];

  for (const tc of providerCases) {
    it(`maps NEMOCLAW_PROVIDER_KEY=${tc.providerKey} (${tc.label})`, () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-config-"));
      const hermesDir = path.join(tmpHome, ".hermes");
      fs.mkdirSync(hermesDir, { recursive: true });

      try {
        const result = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: tmpHome,
            NEMOCLAW_MODEL: "claude-opus-4-7",
            NEMOCLAW_PROVIDER_KEY: tc.providerKey,
            NEMOCLAW_INFERENCE_BASE_URL: tc.inferenceBaseUrl,
          },
        });

        expect(result.status).toBe(0);

        const configRaw = fs.readFileSync(path.join(hermesDir, "config.yaml"), "utf8");
        const config = YAML.parse(configRaw) as {
          model: { provider: string; default: string; base_url: string };
        };
        expect(config.model.provider).toBe(tc.expectedProvider);
        expect(config.model.base_url).toBe(tc.inferenceBaseUrl);

        const envRaw = fs.readFileSync(path.join(hermesDir, ".env"), "utf8");
        if (tc.expectedEnvKeyLine) {
          expect(envRaw).toContain(tc.expectedEnvKeyLine);
        }
        for (const forbidden of tc.forbiddenEnvKeys ?? []) {
          expect(envRaw).not.toContain(`${forbidden}=`);
        }
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });
  }
});
