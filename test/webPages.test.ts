import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  configPage,
  escapeHtml,
  forbiddenPage,
  landingPage,
  signInPage,
  wrongWorkspacePage,
} from "../src/web/pages.js";

describe("escapeHtml", () => {
  it("escapes the five HTML metacharacters", () => {
    assert.equal(
      escapeHtml(`<a href="x" onclick='y'>&`),
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;"
    );
  });

  it("passes ordinary text through", () => {
    assert.equal(
      escapeHtml("team@group.calendar.google.com"),
      "team@group.calendar.google.com"
    );
  });
});

describe("pages", () => {
  it("landing page names the app and links to configuration", () => {
    const html = landingPage();
    assert.match(html, /Hawk Bot/);
    assert.match(html, /href="\/config"/);
  });

  it("sign-in page links the Slack OAuth entry point", () => {
    assert.match(signInPage(), /href="\/auth\/slack"/);
    // With no gateway configured there is one door, and it is ours.
    assert.ok(!signInPage().includes("Hawk Suite"));
  });

  it("sign-in page offers the suite portal when the gateway is configured", () => {
    const html = signInPage("https://apps.suite.test/auth/");
    assert.match(html, /href="https:\/\/apps\.suite\.test\/auth\/"/);
    // Terminal page: our own sign-in stays reachable as a fallback.
    assert.match(html, /href="\/auth\/slack"/);
  });

  it("wrong-workspace page is terminal and escapes the name", () => {
    const html = wrongWorkspacePage(`<img src=x onerror=alert(1)>`);
    assert.ok(!html.includes("<img"));
    assert.match(html, /&lt;img/);
    // No sign-in link: that is the loop this page exists to break.
    assert.ok(!html.includes('href="/auth/slack"'));
  });

  it("a gateway session is signed out at the gateway, not here", () => {
    // Clearing only our own cookie would make sign-out a no-op for someone
    // the suite's domain-wide cookie is holding.
    const suite = {
      kind: "suite" as const,
      href: "https://apps.x.test/auth/logout",
    };
    const html = configPage({
      signedInAs: "Ty",
      settings: [],
      signOut: suite,
    });
    assert.match(html, /href="https:\/\/apps\.x\.test\/auth\/logout"/);
    assert.ok(!html.includes('action="/auth/sign-out"'));
    // Our own session still gets the POST form it always had.
    assert.match(
      configPage({ signedInAs: "Ty", settings: [] }),
      /action="\/auth\/sign-out"/
    );
  });

  it("forbidden page escapes the signed-in name", () => {
    const html = forbiddenPage(`<img src=x onerror=alert(1)>`);
    assert.ok(!html.includes("<img"));
    assert.match(html, /&lt;img/);
  });

  it("config page renders every setting and escapes stored values", () => {
    const html = configPage({
      signedInAs: "Ty",
      settings: [
        {
          key: "announce_channel",
          summary: "Channel Hawk Bot posts to",
          expects: "a channel id",
          value: `C0123"><script>alert(1)</script>`,
        },
        {
          key: "home_note",
          summary: "Free text",
          expects: "any text",
        },
      ],
      flash: { kind: "err", text: `<b>not</b> valid` },
    });
    assert.match(html, /announce_channel/);
    assert.match(html, /home_note/);
    assert.match(html, /Not set/);
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<b>not</b>"));
    // An unset setting gets no Unset button; a set one does.
    assert.equal(html.match(/action="\/config\/unset"/g)?.length, 1);
  });

  it("config page prefers the resolved display over the raw value", () => {
    const html = configPage({
      signedInAs: "Ty",
      settings: [
        {
          key: "announce_channel",
          summary: "s",
          expects: "e",
          value: "C0123456789",
          display: "C0123456789 (#general)",
        },
      ],
    });
    assert.match(html, /C0123456789 \(#general\)/);
    // The form input still holds the raw id — that is what gets stored.
    assert.match(html, /value="C0123456789"/);
  });
});
