// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DiscordGuilds, MessagingAllowedIds } from "./build-env.ts";
import { randomBytes } from "node:crypto";
import { loadManagedToolGatewayMatrix } from "./managed-tool-gateway.ts";

const CHANNEL_TOKEN_ENVS: Record<string, string[]> = {
  telegram: ["TELEGRAM_BOT_TOKEN"],
  discord: ["DISCORD_BOT_TOKEN"],
  slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
};

const PROVIDER_API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export function buildMessagingEnvLines(
  enabledChannels: Set<string>,
  allowedIds: MessagingAllowedIds,
  discordGuilds: DiscordGuilds,
  providerKey = "custom",
  toolGatewayPresets: string[] = [],
  toolGatewayBrokerEnabled = false,
): string[] {
  const envLines = ["API_SERVER_PORT=18642", "API_SERVER_HOST=127.0.0.1"];

  if (enabledChannels.has("discord") || toolGatewayBrokerEnabled || toolGatewayPresets.length > 0) {
    envLines.push(
      `API_SERVER_KEY=${process.env.NEMOCLAW_HERMES_API_SERVER_KEY?.trim() || randomBytes(32).toString("hex")}`,
    );
  }

  const providerCredEnv = PROVIDER_API_KEY_ENV[providerKey];
  if (providerCredEnv) {
    envLines.push(`${providerCredEnv}=openshell:resolve:env:${providerCredEnv}`);
  }

  if (toolGatewayBrokerEnabled || toolGatewayPresets.length > 0) {
    envLines.push("NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=1");
    envLines.push(
      "TOOL_GATEWAY_USER_TOKEN=openshell:resolve:env:NEMOCLAW_HERMES_TOOL_BROKER_TOKEN",
    );
    const matrix = loadManagedToolGatewayMatrix();
    const selected = new Set(toolGatewayPresets);
    for (const [preset, entry] of Object.entries(matrix)) {
      if (selected.size > 0 && !selected.has(preset)) continue;
      envLines.push(`${entry.envKey}=${entry.envValue}`);
    }
  }

  for (const channel of enabledChannels) {
    const envKeys = CHANNEL_TOKEN_ENVS[channel] ?? [];
    for (const envKey of envKeys) {
      envLines.push(`${envKey}=openshell:resolve:env:${envKey}`);
    }
  }

  const discordAllowedUsers = collectDiscordAllowedUsers(allowedIds, discordGuilds);
  if (discordAllowedUsers.length > 0) {
    envLines.push(`DISCORD_ALLOWED_USERS=${discordAllowedUsers.join(",")}`);
  }
  if (allowedIds.telegram?.length) {
    envLines.push(`TELEGRAM_ALLOWED_USERS=${allowedIds.telegram.map(String).join(",")}`);
  }
  if (allowedIds.slack?.length) {
    envLines.push(`SLACK_ALLOWED_USERS=${allowedIds.slack.map(String).join(",")}`);
  }

  return envLines;
}

export function buildDiscordConfig(discordGuilds: DiscordGuilds): Record<string, unknown> {
  return {
    require_mention: getDiscordRequireMention(discordGuilds),
    free_response_channels: "",
    allowed_channels: "",
    auto_thread: true,
    reactions: true,
    channel_prompts: {},
  };
}

function getDiscordRequireMention(discordGuilds: DiscordGuilds): boolean {
  for (const guildConfig of Object.values(discordGuilds)) {
    if (typeof guildConfig?.requireMention === "boolean") {
      return guildConfig.requireMention;
    }
  }
  return true;
}

function collectDiscordAllowedUsers(
  allowedIds: MessagingAllowedIds,
  discordGuilds: DiscordGuilds,
): string[] {
  const users = new Set<string>();
  for (const user of allowedIds.discord ?? []) {
    users.add(String(user));
  }
  for (const guildConfig of Object.values(discordGuilds)) {
    for (const user of guildConfig?.users ?? []) {
      users.add(String(user));
    }
  }
  return [...users];
}
