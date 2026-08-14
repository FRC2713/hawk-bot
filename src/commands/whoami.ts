import type { Command } from "./types.js";

export const whoami: Command = {
  name: "whoami",
  summary: "Your Slack id, and whether Hawk Bot treats you as an admin",
  async run(ctx) {
    const admin = await ctx.isAdmin();
    return {
      text: [
        `You are <@${ctx.userId}> (\`${ctx.userId}\`)`,
        `in channel \`${ctx.channelId}\``,
        admin
          ? "Hawk Bot treats you as an admin — admin commands are available."
          : "Hawk Bot does not treat you as an admin. Workspace Owners and " +
            "Admins get the admin commands; nothing else grants them.",
      ].join("\n"),
    };
  },
};
