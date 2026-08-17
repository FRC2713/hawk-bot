import type { WebClient } from "@slack/web-api";
import { log } from "../logger.js";
import { slackErrorCode } from "./slackErrors.js";

/**
 * `chat:write.public` only covers `chat.postMessage` — every reaction call
 * (`reactions.add`, `reactions.get`) still needs the bot to actually be a
 * channel member, and fails with one of these codes otherwise. That gap is
 * what let Check-in Posts go out with no reactions and no visible error
 * until someone thought to check container logs (issue #33). Returns
 * `undefined` for anything not in this known set, so a caller can fall back
 * to a generic message rather than a false-sounding one.
 */
export function describeChannelAccessError(err: unknown): string | undefined {
  switch (slackErrorCode(err)) {
    case "not_in_channel":
      return "I'm not a member of that channel — invite Hawk Bot to it and this resolves itself.";
    case "missing_scope":
      return "this workspace's Slack app install is missing a required permission — a HawkBot Admin needs to reinstall the app from the Slack dashboard so it picks up the current scopes.";
    case "channel_not_found":
      return "that channel id doesn't exist, or I can't see it — double-check the configured channel setting.";
    default:
      return undefined;
  }
}

/**
 * Best-effort self-join so a freshly-configured `announce_channel` never
 * depends on someone remembering `/invite` — the same reasoning
 * `chat:write.public` already applies to posting, extended to cover
 * reactions (which that scope does not, see `describeChannelAccessError`).
 * Only public channels support a bot self-join; Slack has no equivalent for
 * private ones, so that specific failure is expected and left silent here —
 * the real error still surfaces from the reaction call itself.
 */
export async function ensureChannelMembership(
  client: WebClient,
  channel: string
): Promise<void> {
  try {
    await client.conversations.join({ channel });
  } catch (err) {
    const code = slackErrorCode(err);
    if (
      code === "already_in_channel" ||
      code === "method_not_supported_for_channel_type"
    ) {
      return;
    }
    log.warn("could not auto-join channel", { channel, error: String(err) });
  }
}
