import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
const fixture = {
  ...process.env,
  SLACK_SIGNING_SECRET: "test",
  SLACK_CLIENT_ID: "test",
  SLACK_CLIENT_SECRET: "test",
  SLACK_STATE_SECRET: "fixture-state-secret",
  PUBLIC_URL: "https://app.suite.test",
  TOKEN_ENCRYPTION_KEY: "test",
  GOOGLE_SERVICE_ACCOUNT_KEY_BASE64: "e30=",
  HAWK_SUITE_TRUST_PROXY: "false",
  HAWK_SUITE_ISSUER: "",
  HAWK_SUITE_TEAM_ID: "",
};
function parse(
  extra: Record<string, string | undefined>,
  code = "console.log(JSON.stringify(config()))"
) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { config } from "./src/config.ts"; ${code}`,
    ],
    { env: { ...fixture, ...extra }, encoding: "utf8" }
  );
}
it("requires explicit proxy mode and workspace configuration", () => {
  const standalone = parse({});
  assert.equal(standalone.status, 0, standalone.stderr);
  assert.equal(JSON.parse(standalone.stdout).HAWK_SUITE_TRUST_PROXY, false);
  for (const extra of [
    { HAWK_SUITE_TRUST_PROXY: "true" },
    {
      HAWK_SUITE_TRUST_PROXY: "true",
      HAWK_SUITE_ISSUER: "https://apps.suite.test/",
    },
    { HAWK_SUITE_TRUST_PROXY: "true", HAWK_SUITE_TEAM_ID: "TTEAM" },
    { HAWK_SUITE_TRUST_PROXY: "yes" },
    {
      HAWK_SUITE_TRUST_PROXY: "true",
      HAWK_SUITE_ISSUER: "https://apps.suite.test/",
      HAWK_SUITE_TEAM_ID: "invalid",
    },
  ])
    assert.notEqual(parse(extra).status, 0);
  const trusted = parse({
    HAWK_SUITE_TRUST_PROXY: "true",
    HAWK_SUITE_ISSUER: "https://apps.suite.test/",
    HAWK_SUITE_TEAM_ID: "TTEAM",
  });
  assert.equal(trusted.status, 0, trusted.stderr);
  assert.equal(JSON.parse(trusted.stdout).HAWK_SUITE_TRUST_PROXY, true);
});
it("ignores gateway headers and cookies when proxy trust is off", () => {
  const result = parse(
    {},
    `
    import assert from "node:assert/strict";
    import { webRoutes } from "./src/web/routes.ts";
    let body = "", location;
    const res = { writeHead(code, headers) { location = headers.location; }, end(value = "") { body += value; } };
    await webRoutes().find(r => r.path === "/config").handler({ headers: {
      cookie: "AUTHP_ACCESS_TOKEN=untrusted", "x-token-subject": "slack:TTEAM:UADMIN", "x-hawk-slack-team": "TTEAM", "x-hawk-slack-user": "UADMIN", "x-token-user-roles": "suite/member"
    } }, res);
    assert.equal(location, undefined);
    assert.ok(body.includes("/hawkbot config"));
    assert.ok(!body.includes("Signed in as"));
  `
  );
  assert.equal(result.status, 0, result.stderr);
});
