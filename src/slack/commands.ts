import type { App } from "@slack/bolt";
import { SLASH_COMMAND } from "../brand.js";
import {
  parseCommandText,
  renderHelp,
  resolveCommand,
} from "../commands/parse.js";
import { COMMANDS } from "../commands/registry.js";
import type { CommandReply } from "../commands/types.js";
import { log } from "../logger.js";
import { isWorkspaceAdmin } from "./authz.js";

/**
 * The single slash command, and the only router.
 *
 * Slack gives an app three seconds to acknowledge before it shows the user a
 * timeout, so `ack()` comes first and the reply is sent afterwards through
 * `respond`. Anything slower than a database read belongs behind that split.
 */
export function registerCommands(app: App): void {
  app.command(SLASH_COMMAND, async ({ command, ack, respond, client }) => {
    await ack();

    const parsed = parseCommandText(command.text);
    const cmd = resolveCommand(COMMANDS, parsed.name);

    if (!cmd) {
      await respond({
        response_type: "ephemeral",
        text: `Don't know \`${parsed.name}\`.\n${renderHelp(COMMANDS, SLASH_COMMAND)}`,
      });
      return;
    }

    // Memoized for this invocation: `adminOnly` and a command that also asks
    // should cost one API call, not two.
    let adminAnswer: Promise<boolean> | undefined;
    const isAdmin = () =>
      (adminAnswer ??= isWorkspaceAdmin(client, command.user_id));

    if (cmd.adminOnly && !(await isAdmin())) {
      await respond({
        response_type: "ephemeral",
        text: `\`${cmd.name}\` is for workspace Owners and Admins. Ask a coach.`,
      });
      return;
    }

    let reply: CommandReply;
    try {
      reply = await cmd.run({
        userId: command.user_id,
        channelId: command.channel_id,
        teamId: command.team_id,
        args: parsed.args,
        rest: parsed.rest,
        client,
        isAdmin,
        registry: COMMANDS,
      });
    } catch (error) {
      // The person typing gets a plain sentence; the detail goes to the log,
      // which is the only place it is safe and the only place it is useful.
      log.error("command failed", {
        command: cmd.name,
        userId: command.user_id,
        error: String(error),
      });
      await respond({
        response_type: "ephemeral",
        text: `\`${cmd.name}\` failed. It has been logged — tell a coach if it keeps happening.`,
      });
      return;
    }

    await respond({
      response_type: reply.visibility ?? "ephemeral",
      text: reply.text,
      ...(reply.blocks ? { blocks: reply.blocks } : {}),
    });
  });
}
