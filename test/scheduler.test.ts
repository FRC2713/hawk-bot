import assert from "node:assert/strict";
import { test } from "node:test";
import { runStep } from "../src/scheduler.js";

test("a failing step reports its error instead of throwing", async () => {
  const result = await runStep("x", async () => {
    throw new Error("nope");
  });
  assert.deepEqual(result, { step: "x", ok: false, error: "nope" });
});

test("a succeeding step reports ok", async () => {
  const result = await runStep("x", async () => {});
  assert.deepEqual(result, { step: "x", ok: true });
});

test("a failing step does not stop a later step from running", async () => {
  const calls: string[] = [];
  const first = await runStep("a", async () => {
    calls.push("a");
    throw new Error("boom");
  });
  const second = await runStep("b", async () => {
    calls.push("b");
  });
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(first.ok, false);
  assert.equal(second.ok, true);
});
