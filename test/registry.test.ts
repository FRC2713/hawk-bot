import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCommand } from "../src/commands/parse.js";
import { COMMANDS } from "../src/commands/registry.js";

/**
 * The registry is append-only in practice, and a duplicate name would resolve
 * to whichever came first — a bug that looks like "my new command does the
 * wrong thing" rather than like a collision.
 */
test("no two commands answer to the same word", () => {
  const seen = new Set<string>();
  for (const c of COMMANDS) {
    for (const word of [c.name, ...(c.aliases ?? [])]) {
      assert.ok(!seen.has(word), `${word} is claimed twice`);
      seen.add(word);
    }
  }
});

test("every command is lowercase, one word, and documented", () => {
  for (const c of COMMANDS) {
    assert.match(
      c.name,
      /^[a-z?]+$/,
      `${c.name} is not a single lowercase word`
    );
    assert.ok(c.summary.length > 0, `${c.name} has no summary`);
  }
});

test("a bare /hawkbot resolves to something", () => {
  assert.ok(resolveCommand(COMMANDS, "help"));
});
