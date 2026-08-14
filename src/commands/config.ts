import { SLASH_COMMAND } from "../brand.js";
import { getSetting, setSetting } from "../db/repo.js";
import { SETTINGS, checkSetting } from "../domain/settings.js";
import type { Command } from "./types.js";

function list(): string {
  const lines = SETTINGS.map((s) => {
    const current = getSetting(s.key);
    return `• \`${s.key}\` — ${s.summary}\n    ${current ? `currently \`${current}\`` : "_not set_"}`;
  });
  return [
    "*Workspace settings*",
    ...lines,
    `Set one with \`${SLASH_COMMAND} config set <key> <value>\`.`,
  ].join("\n");
}

export const config: Command = {
  name: "config",
  summary: "Show or change Hawk Bot's workspace settings",
  usage: "config | config set <key> <value>",
  // Everything here is workspace-wide, so it answers to Slack's own admins.
  adminOnly: true,
  async run(ctx) {
    const [verb, key, ...valueParts] = ctx.args;

    if (!verb || verb.toLowerCase() === "list") {
      return { text: list() };
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

    const checked = checkSetting(key, valueParts.join(" "));
    if (!checked.ok) return { text: checked.reason };

    setSetting(checked.key, checked.value, ctx.userId);
    return { text: `Set \`${checked.key}\` to \`${checked.value}\`.` };
  },
};
