import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { before, beforeEach, after, it, mock } from "node:test";
import { WebClient } from "@slack/web-api";
import { saveInstallation, getSetting } from "../src/db/repo.js";
import { forgetAdminStatus } from "../src/slack/authz.js";
import { webRoutes } from "../src/web/routes.js";
const directory = mkdtempSync(join(tmpdir(), "hawk-bot-headers-"));
Object.assign(process.env, {
  DATA_DIR: directory,
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  SLACK_SIGNING_SECRET: "test",
  SLACK_CLIENT_ID: "test",
  SLACK_CLIENT_SECRET: "test",
  SLACK_STATE_SECRET: "test-state-secret-0123456789",
  PUBLIC_URL: "https://bot.suite.test",
  GOOGLE_SERVICE_ACCOUNT_KEY_BASE64: "e30=",
  HAWK_SUITE_ISSUER: "https://apps.suite.test/",
  HAWK_SUITE_TRUST_PROXY: "true",
  HAWK_SUITE_TEAM_ID: "TTEAM",
});
const headers = {
  "x-token-subject": "slack:TTEAM:UADMIN",
  "x-hawk-slack-team": "TTEAM",
  "x-hawk-slack-user": "UADMIN",
  "x-token-user-roles": "suite/member",
  "x-token-user-name": "Test Admin",
};
let owner = true;
let calls = 0;
const server = createServer(async (req, res) => {
  const route = webRoutes().find((r) => r.path === req.url?.split("?")[0]);
  if (!route) {
    res.writeHead(404);
    res.end();
    return;
  }
  await route.handler(req, res);
});
let base: string;
before(async () => {
  mock.method(WebClient.prototype, "apiCall", async (method: string) => {
    calls++;
    assert.equal(method, "users.info");
    return { ok: true, user: { id: "UADMIN", is_owner: owner } };
  });
  saveInstallation({ teamId: "TTEAM", payload: { bot: { token: "test" } } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  owner = true;
  calls = 0;
  forgetAdminStatus();
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  mock.restoreAll();
  rmSync(directory, { recursive: true, force: true });
});
it("opens config for a trusted member who passes the HawkBot Admin check", async () => {
  const res = await fetch(`${base}/config`, { headers });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Test Admin/);
  assert.match(body, /https:\/\/apps.suite.test\/auth\/logout/);
  assert.equal(calls, 1);
});
it("gateway roles alone grant no admin access on GET or POST", async () => {
  owner = false;
  assert.equal((await fetch(`${base}/config`, { headers })).status, 403);
  assert.equal(
    (
      await fetch(`${base}/config/set`, {
        method: "POST",
        headers: { ...headers, origin: "https://bot.suite.test" },
        body: "key=home_note&value=changed",
      })
    ).status,
    403
  );
  assert.equal(getSetting("home_note"), undefined);
});
it("foreign or malformed gateway identity never reaches the Slack admin check", async () => {
  const res = await fetch(`${base}/config`, {
    headers: {
      ...headers,
      "x-token-subject": "slack:TOTHER:UADMIN",
      "x-hawk-slack-team": "TOTHER",
    },
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Sign in/);
  assert.equal(calls, 0);
});
it("writes settings only with admin permission and the exact Origin", async () => {
  const rejected = await fetch(`${base}/config/set`, {
    method: "POST",
    headers: { ...headers, origin: "https://eye.suite.test" },
    body: "key=home_note&value=changed",
  });
  assert.equal(rejected.status, 403);
  const accepted = await fetch(`${base}/config/set`, {
    redirect: "manual",
    method: "POST",
    headers: { ...headers, origin: "https://bot.suite.test" },
    body: "key=home_note&value=changed",
  });
  assert.equal(accepted.status, 303);
  assert.equal(getSetting("home_note"), "changed");
});
