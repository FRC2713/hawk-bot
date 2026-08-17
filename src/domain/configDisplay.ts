/**
 * The outcome of trying to resolve a stored channel or usergroup id to its
 * current human-readable name — the pure result `slack/nameResolution.ts`'s
 * live Slack calls reduce to, so `/hawkbot config`'s display logic never
 * touches a Slack client or an error object directly.
 */
export type Resolution =
  | { status: "ok"; name: string }
  | { status: "not_found" }
  | { status: "no_access" }
  | { status: "unknown" };

const SIGIL: Record<"channel" | "usergroup", string> = {
  channel: "#",
  usergroup: "@",
};

/**
 * `/hawkbot config`'s display line for one channel/usergroup setting's raw
 * id, given how (or whether) it resolved. The id is always shown — it's the
 * value actually stored, and what a coach would type back into `config set`
 * — with the readable name as an annotation, never a replacement.
 */
export function formatResolvedValue(
  rawId: string,
  kind: "channel" | "usergroup",
  resolution: Resolution
): string {
  switch (resolution.status) {
    case "ok":
      return `${rawId} (${SIGIL[kind]}${resolution.name})`;
    case "not_found":
      // Slack returns the same `channel_not_found` code whether a channel
      // was deleted or is private and the bot was never invited — worded to
      // cover both rather than asserting deletion. A usergroup's not_found
      // is unambiguous (fetched with `include_disabled`, so this only means
      // gone), but the same wording is harmless there too.
      return kind === "channel"
        ? `${rawId} ⚠️ not found (or I can't see it — check I'm invited)`
        : `${rawId} ⚠️ not found`;
    case "no_access":
      return `${rawId} ⚠️ no access`;
    case "unknown":
      return rawId;
  }
}
