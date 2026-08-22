import type { WebClient } from "@slack/web-api";
import { SLASH_COMMAND } from "../brand.js";
import { getSetting } from "../db/repo.js";
import { formatResolvedValue } from "../domain/configDisplay.js";
import { SETTINGS } from "../domain/settings.js";
import { resolveName } from "../slack/nameResolution.js";
import {
  applySettingInput,
  applySettingUnset,
} from "../slack/settingsWrite.js";
import type { Command } from "./types.js";

async function describeCurrentValue(
  client: WebClient,
  current: string,
  resolveAs: "channel" | "usergroup" | undefined
): Promise<string> {
  if (!resolveAs) return `currently \`${current}\``;
  const resolution = await resolveName(client, resolveAs, current);
  return `currently \`${formatResolvedValue(current, resolveAs, resolution)}\``;
}

async function list(client: WebClient): Promise<string> {
  const lines = await Promise.all(
    SETTINGS.map(async (s) => {
      const current = getSetting(s.key);
      const value = current
        ? await describeCurrentValue(client, current, s.resolveAs)
        : "_not set_";
      return `• \`${s.key}\` — ${s.summary}\n    ${value}`;
    })
  );
  return [
    "*Workspace settings*",
    ...lines,
    `Set one with \`${SLASH_COMMAND} config set <key> <value>\`, clear one with \`${SLASH_COMMAND} config unset <key>\`.`,
  ].join("\n");
}

export const config: Command = {
  name: "config",
  summary: "Show or change Hawk Bot's workspace settings",
  usage: "config | config set <key> <value> | config unset <key>",
  // Everything here is workspace-wide, so it answers to Slack's own admins.
  adminOnly: true,
  async run(ctx) {
    const [verb, key, ...valueParts] = ctx.args;

    if (!verb || verb.toLowerCase() === "list") {
      return { text: await list(ctx.client) };
    }

    // Several settings document "unset to disable" as their off switch — the
    // Informational and Mentor/Teacher Calendars, the No Response Alert
    // Report, and now delegation. Without this there was no way to reach that
    // state from Slack at all, so the documented off switch did not exist.
    if (verb.toLowerCase() === "unset") {
      if (!key) {
        return {
          text: `Usage: \`${SLASH_COMMAND} config unset <key>\``,
        };
      }
      const outcome = applySettingUnset(key);
      if (!outcome.ok) return { text: outcome.reason };
      return {
        text: outcome.removed
          ? `Unset \`${outcome.key}\`.`
          : `\`${outcome.key}\` was already unset.`,
      };
    }

    if (verb.toLowerCase() !== "set") {
      return {
        text: `Don't know \`${verb}\`. Usage: \`${SLASH_COMMAND} ${config.usage}\``,
      };
    }

    if (!key || valueParts.length === 0) {
      return {
        text: `Usage: \`${SLASH_COMMAND} config set <key> <value>\``,
      };
    }

    // Validation and the usergroup handle→id resolution live in
    // slack/settingsWrite.ts, shared with the web configuration page.
    const outcome = await applySettingInput(
      ctx.client,
      key,
      valueParts.join(" "),
      ctx.userId
    );
    if (!outcome.ok) return { text: outcome.reason };
    if (outcome.groupHandle) {
      return {
        text: `Set \`${outcome.key}\` to the group \`@${outcome.groupHandle}\` (\`${outcome.storedValue}\`).`,
      };
    }
    return { text: `Set \`${outcome.key}\` to \`${outcome.storedValue}\`.` };
  },
};
