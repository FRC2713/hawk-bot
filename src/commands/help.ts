import { SLASH_COMMAND } from "../brand.js";
import { renderHelp } from "./parse.js";
import type { Command } from "./types.js";

export const help: Command = {
  name: "help",
  aliases: ["?", "commands"],
  summary: "List everything Hawk Bot can do",
  async run(ctx) {
    return { text: renderHelp(ctx.registry, SLASH_COMMAND) };
  },
};
