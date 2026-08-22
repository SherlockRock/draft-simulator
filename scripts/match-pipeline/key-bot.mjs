#!/usr/bin/env node
/**
 * Discord key bot — closes the daily-key loop from a phone.
 *
 * Runs on forge as the `collector` user (which owns the env file, so no sudo).
 * Two jobs:
 *   1. Stall watch: every 15 min, run the status heuristic; when every region
 *      with a backlog has stopped fetching (= the shared key expired), post in
 *      the configured channel. Renotifies every 12h while stalled; posts a
 *      recovery message when fetching resumes.
 *   2. Key intake: a message in that channel from the configured user that is
 *      exactly an RGAPI key gets written into the env file; the collectors'
 *      KeyManagers pick it up within 30s. The bot deletes the key message
 *      (if permitted), reacts, and confirms once matches flow again.
 *
 * Also answers `!status` with the per-region summary.
 *
 * Env (all from /etc/firstpick-collector/env via the systemd unit):
 *   DISCORD_BOT_TOKEN   bot token (Message Content intent must be enabled)
 *   DISCORD_CHANNEL_ID  channel to watch/post in
 *   DISCORD_USER_ID     only this author may submit keys
 *   DATABASE_URL        collector DB (for status)
 */

import { readFile, writeFile } from "node:fs/promises";
import { createDb } from "./db.mjs";
import { collectStatus } from "./status.mjs";

// ---- pure logic (unit-tested) ----

const KEY_RE = /^RGAPI-[A-Za-z0-9-]{20,}$/;

/** The whole message must be the key — no chatter, no embedded matches. */
export function extractKey(content) {
  const trimmed = content.trim();
  return KEY_RE.test(trimmed) ? trimmed : null;
}

export function updateEnvContent(content, newKey) {
  const line = `RIOT_API_KEY=${newKey}`;
  if (/^RIOT_API_KEY=.*$/m.test(content)) {
    return content.replace(/^RIOT_API_KEY=.*$/m, line);
  }
  return `${content.endsWith("\n") || content === "" ? content : content + "\n"}${line}\n`;
}

/** Rising-edge stall notifications with periodic renotify and one recovery. */
export class StallTracker {
  constructor({ renotifyMs }) {
    this.renotifyMs = renotifyMs;
    this.stalled = false;
    this.lastNotifiedAt = null;
  }

  /** @returns {"stalled" | "recovered" | null} what to announce, if anything */
  update(isStalled, now) {
    if (isStalled) {
      if (!this.stalled || now - this.lastNotifiedAt >= this.renotifyMs) {
        this.stalled = true;
        this.lastNotifiedAt = now;
        return "stalled";
      }
      return null;
    }
    const hadNotified = this.stalled;
    this.stalled = false;
    this.lastNotifiedAt = null;
    return hadNotified ? "recovered" : null;
  }
}

/** Stalled = someone has work queued but nobody is fetching (shared key). */
export function isGloballyStalled(status) {
  const regions = Object.values(status.regions);
  const withBacklog = regions.filter((r) => r.matches.pending > 0);
  return withBacklog.length > 0 && withBacklog.every((r) => r.likelyKeyExpired);
}

const formatStatus = (status) =>
  Object.entries(status.regions)
    .map(([region, s]) => {
      const m = s.matches;
      return `**${region}** pending=${m.pending} fetched=${m.fetched} skipped=${m.skipped} failed=${m.failed} · last 24h: ${s.fetchedLast24h}${s.likelyKeyExpired ? " ⚠ stalled" : ""}`;
    })
    .join("\n");

// ---- bot wiring (verified live) ----

async function main() {
  const { Client, GatewayIntentBits, Partials } = await import("discord.js");

  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  const userId = process.env.DISCORD_USER_ID;
  const envFile = process.env.COLLECTOR_ENV_FILE ?? "/etc/firstpick-collector/env";
  const regions = (process.env.COLLECTOR_REGIONS ?? "na1,euw1,kr").split(",").map((r) => r.trim());
  for (const [name, v] of [
    ["DISCORD_BOT_TOKEN", token],
    ["DISCORD_CHANNEL_ID", channelId],
    ["DISCORD_USER_ID", userId],
    ["DATABASE_URL", process.env.DATABASE_URL],
  ]) {
    if (!v) {
      console.error(`key-bot: ${name} is required`);
      process.exit(1);
    }
  }

  const db = createDb(process.env.DATABASE_URL);
  const tracker = new StallTracker({ renotifyMs: 12 * 3600_000 });
  const log = (msg) => console.log(`${new Date().toISOString()} key-bot ${msg}`);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
  });

  const post = async (text) => {
    const channel = await client.channels.fetch(channelId);
    await channel.send(text);
  };

  const checkStall = async () => {
    try {
      const status = await collectStatus(db, { regions });
      const event = tracker.update(isGloballyStalled(status), Date.now());
      if (event === "stalled") {
        await post(
          "🔑 **Collector stalled — key likely expired.**\n" +
            "Regenerate at <https://developer.riotgames.com> and reply here with the new `RGAPI-...` key.\n" +
            formatStatus(status),
        );
        log("posted stall notification");
      } else if (event === "recovered") {
        await post("✅ Collector fetching again.");
        log("posted recovery notification");
      }
    } catch (err) {
      log(`stall check failed: ${err.message}`);
    }
  };

  client.on("messageCreate", async (message) => {
    try {
      if (message.channelId !== channelId || message.author.bot) return;

      if (message.content.trim() === "!status") {
        const status = await collectStatus(db, { regions });
        await message.reply(formatStatus(status));
        return;
      }

      const key = extractKey(message.content);
      if (!key) return;
      if (message.author.id !== userId) {
        log(`ignored key-shaped message from unauthorized user ${message.author.id}`);
        return;
      }

      const content = await readFile(envFile, "utf8");
      await writeFile(envFile, updateEnvContent(content, key), "utf8");
      log("key updated from Discord message");
      // Don't leave the key sitting in chat (needs Manage Messages; best-effort).
      await message.delete().catch(() => {});
      await post("🔄 Key updated — collectors resume within 30s. I'll confirm once matches flow.");

      // Confirm resumption: fetched counts should move within a few minutes.
      const before = await collectStatus(db, { regions });
      const fetchedBefore = Object.values(before.regions).reduce(
        (s, r) => s + r.matches.fetched,
        0,
      );
      setTimeout(async () => {
        try {
          const after = await collectStatus(db, { regions });
          const fetchedAfter = Object.values(after.regions).reduce(
            (s, r) => s + r.matches.fetched,
            0,
          );
          if (fetchedAfter > fetchedBefore) {
            tracker.update(false, Date.now());
            await post(`✅ Confirmed: ${fetchedAfter - fetchedBefore} matches fetched since the key push.`);
          } else {
            await post(
              "⚠ No matches fetched in the 5 minutes since the key push — the key may be wrong. Check `!status` or the forge logs.",
            );
          }
        } catch (err) {
          log(`resume confirmation failed: ${err.message}`);
        }
      }, 5 * 60_000);
    } catch (err) {
      log(`message handler failed: ${err.message}`);
    }
  });

  client.once("clientReady", () => {
    log(`logged in as ${client.user.tag}; watching channel ${channelId}`);
    checkStall();
    setInterval(checkStall, 15 * 60_000);
  });

  await client.login(token);
}

if (process.argv[1]?.endsWith("key-bot.mjs")) {
  main();
}
