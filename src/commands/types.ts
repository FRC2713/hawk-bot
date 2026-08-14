import type { KnownBlock } from "@slack/web-api";
import type { WebClient } from "@slack/web-api";

/**
 * What a subcommand hands back. `text` is required even when `blocks` is set:
 * it is what a notification, a screen reader, and Slack's own fallback show.
 */
export type CommandReply = {
  text: string;
  blocks?: KnownBlock[];
  /** Default is ephemeral — only the person who typed it sees the reply. */
  visibility?: "ephemeral" | "in_channel";
};

export type CommandContext = {
  /** Who typed it. */
  userId: string;
  /** Where they typed it. Not necessarily somewhere the bot can post. */
  channelId: string;
  teamId: string | undefined;
  /** Everything after the subcommand name, split on whitespace. */
  args: string[];
  /** Everything after the subcommand name, verbatim. */
  rest: string;
  client: WebClient;
  /** Hawk Bot's own Slack user id — so a reaction-resyncing command can exclude it. */
  botUserId: string;
  /**
   * Resolved against Slack, lazily and at most once per invocation. A command
   * that only wants to *show* whether you are an admin should not pay for an
   * API call it may not need, and the router already gates `adminOnly`.
   */
  isAdmin: () => Promise<boolean>;
  /** The full command list, so `help` renders itself rather than a copy. */
  registry: readonly Command[];
};

export type Command = {
  /** Lowercase, one word. This is what people type. */
  name: string;
  /** Alternate spellings people reach for. Kept short on purpose. */
  aliases?: readonly string[];
  /** One line, shown in `/hawk help`. */
  summary: string;
  /** Argument shape, shown when the command is misused. */
  usage?: string;
  /**
   * Refused for anyone who isn't a HawkBot Admin — membership in the Slack
   * User Group the `admin_usergroup` setting names, or a workspace Owner
   * (always, regardless of the group's state). See ADR-0004 and
   * CONTEXT.md, HawkBot Admin.
   */
  adminOnly?: boolean;
  run: (ctx: CommandContext) => Promise<CommandReply>;
};
