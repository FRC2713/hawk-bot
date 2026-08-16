import type { Command } from "./types.js";

export type ParsedCommand = {
  /** Lowercased subcommand name. Bare `/hawkbot` means `help`. */
  name: string;
  args: string[];
  /** Everything after the name, verbatim — for commands that take prose. */
  rest: string;
};

/**
 * Splits the text Slack sends with a slash command into a subcommand and its
 * arguments.
 *
 * Pure, and the only place the shape of a command line is decided, so the
 * cases people actually hit — a bare `/hawkbot`, a trailing space from
 * autocomplete, `/hawkbot HELP` — are settled once and tested, rather than
 * re-derived in each handler.
 */
export function parseCommandText(text: string | undefined): ParsedCommand {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { name: "help", args: [], rest: "" };
  const parts = trimmed.split(/\s+/);
  const name = (parts[0] ?? "").toLowerCase();
  return {
    name,
    args: parts.slice(1),
    // Slice by the raw head's length, not the lowercased one — same length,
    // but this keeps the original casing of everything that follows.
    rest: trimmed.slice(name.length).trim(),
  };
}

export function resolveCommand(
  registry: readonly Command[],
  name: string
): Command | undefined {
  const wanted = name.trim().toLowerCase();
  return registry.find(
    (c) => c.name === wanted || (c.aliases?.includes(wanted) ?? false)
  );
}

/**
 * The `help` body, as plain text. Lives next to the parser rather than in the
 * command so that "what commands exist" has one renderer, and so the
 * unknown-command reply can show the same list without importing a command.
 */
export function renderHelp(
  registry: readonly Command[],
  slashCommand: string
): string {
  const width = Math.max(...registry.map((c) => c.name.length));
  const lines = registry.map((c) => {
    const admin = c.adminOnly ? "  (admins)" : "";
    return `  ${c.name.padEnd(width)}  ${c.summary}${admin}`;
  });
  return [`Usage: \`${slashCommand} <command>\``, "```", ...lines, "```"].join(
    "\n"
  );
}
