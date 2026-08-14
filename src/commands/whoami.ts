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
          ? "Hawk Bot treats you as a HawkBot Admin — admin commands are available."
          : "Hawk Bot does not treat you as a HawkBot Admin. Membership in " +
            "the HawkBot Admin group grants it (workspace Owners always " +
            "have it too); nothing else does.",
      ].join("\n"),
    };
  },
};
