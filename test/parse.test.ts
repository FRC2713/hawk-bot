import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCommandText,
  renderHelp,
  resolveCommand,
} from "../src/commands/parse.js";
import type { Command } from "../src/commands/types.js";

const fake = (name: string, extra: Partial<Command> = {}): Command => ({
  name,
  summary: `does ${name}`,
  run: async () => ({ text: name }),
  ...extra,
});

test("a bare slash command means help", () => {
  assert.equal(parseCommandText("").name, "help");
  assert.equal(parseCommandText(undefined).name, "help");
  assert.equal(parseCommandText("   ").name, "help");
});

test("the subcommand is case-insensitive", () => {
  assert.equal(parseCommandText("STATUS").name, "status");
  assert.equal(parseCommandText("Config set x y").name, "config");
});

test("arguments survive whatever whitespace autocomplete leaves behind", () => {
  const parsed = parseCommandText("  config   set   announce_channel  C123 ");
  assert.deepEqual(parsed.args, ["set", "announce_channel", "C123"]);
});

test("rest keeps the original casing of everything after the name", () => {
  const parsed = parseCommandText("Note Meetings Are On Tuesday");
  assert.equal(parsed.name, "note");
  assert.equal(parsed.rest, "Meetings Are On Tuesday");
});

test("aliases resolve, unknown names do not", () => {
  const registry = [fake("help", { aliases: ["?"] }), fake("status")];
  assert.equal(resolveCommand(registry, "?")?.name, "help");
  assert.equal(resolveCommand(registry, "STATUS")?.name, "status");
  assert.equal(resolveCommand(registry, "nope"), undefined);
});

test("help lists every command, and marks the admin-only ones", () => {
  const text = renderHelp(
    [fake("status"), fake("config", { adminOnly: true })],
    "/hawkbot"
  );
  assert.match(text, /status\s+does status/);
  assert.match(text, /config\s+does config\s+\(admins\)/);
});
