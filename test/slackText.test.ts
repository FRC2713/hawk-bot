import assert from "node:assert/strict";
import { test } from "node:test";
import { descriptionToSlack } from "../src/domain/slackText.js";

test("the #60 description: a link whose text is its own URL becomes a bare Slack link", () => {
  assert.equal(
    descriptionToSlack(
      '<a href="https://www.frc319.com/register">https://www.frc319.com/register</a>'
    ),
    "<https://www.frc319.com/register>"
  );
});

test("a link with different text keeps both", () => {
  assert.equal(
    descriptionToSlack(
      'Sign up <a href="https://example.com/x?a=1&amp;b=2">here</a>.'
    ),
    "Sign up <https://example.com/x?a=1&amp;b=2|here>."
  );
});

test("a link with a javascript: href is reduced to its text", () => {
  assert.equal(
    descriptionToSlack('<a href="javascript:alert(1)">click</a>'),
    "click"
  );
});

test("an anchor with no href keeps its text", () => {
  assert.equal(descriptionToSlack("<a name=top>Top</a>"), "Top");
});

test("an unclosed anchor still emits its link", () => {
  assert.equal(
    descriptionToSlack('<a href="https://example.com">Docs'),
    "<https://example.com|Docs>"
  );
});

test("br and block tags become newlines", () => {
  assert.equal(descriptionToSlack("one<br>two<br/>three"), "one\ntwo\nthree");
  assert.equal(descriptionToSlack("<p>one</p><p>two</p>"), "one\ntwo");
});

test("bold and italic map to Slack marks, with trailing space moved outside", () => {
  assert.equal(
    descriptionToSlack(
      "<b>Bring: </b>a <i>charged</i> <strong>battery</strong>"
    ),
    "*Bring:* a _charged_ *battery*"
  );
});

test("an empty bold pair leaves nothing behind", () => {
  assert.equal(descriptionToSlack("a<b></b>b"), "ab");
});

test("an unclosed bold tag is closed", () => {
  assert.equal(descriptionToSlack("<b>Heads up"), "*Heads up*");
});

test("lists become bullets", () => {
  assert.equal(
    descriptionToSlack("Agenda:<ul><li>Build</li><li>Wire</li></ul>Thanks"),
    "Agenda:\n• Build\n• Wire\nThanks"
  );
});

test("other tags are dropped and their text kept", () => {
  assert.equal(
    descriptionToSlack('<span style="color:red">hot</span> <font>take</font>'),
    "hot take"
  );
});

test("HTML comments are dropped", () => {
  assert.equal(descriptionToSlack("a<!-- hidden -->b"), "ab");
});

test("entities decode, then escape for Slack", () => {
  assert.equal(
    descriptionToSlack("R&amp;D &lt;3 &#39;bots&#39;&nbsp;"),
    "R&amp;D &lt;3 'bots'"
  );
});

test("an unknown entity is left alone", () => {
  assert.equal(descriptionToSlack("&bogus; ok"), "&amp;bogus; ok");
});

test("plain text is escaped so it cannot inject Slack control sequences", () => {
  assert.equal(
    descriptionToSlack("hey <!channel> and <@U123> & <https://example.com>"),
    "hey &lt;!channel&gt; and &lt;@U123&gt; &amp; &lt;https://example.com&gt;"
  );
});

test("plain multi-line text keeps its line breaks, and runs of blank lines collapse", () => {
  assert.equal(descriptionToSlack("a\r\nb\n\n\n\nc"), "a\nb\n\nc");
});

test("a description of only markup is empty", () => {
  assert.equal(descriptionToSlack("<br><p></p> "), "");
  assert.equal(descriptionToSlack(""), "");
});

test("short text is not truncated", () => {
  assert.equal(descriptionToSlack("short", { maxChars: 10 }), "short");
});

test("long text is cut at a word boundary with an ellipsis", () => {
  assert.equal(
    descriptionToSlack("alpha beta gamma delta", { maxChars: 14 }),
    "alpha beta…"
  );
});

test("a cut adds the calendar link when the event has one", () => {
  assert.equal(
    descriptionToSlack("alpha beta gamma delta", {
      maxChars: 14,
      moreUrl: "https://calendar.google.com/e?x=1&y=2",
    }),
    "alpha beta…\n<https://calendar.google.com/e?x=1&amp;y=2|See the rest on the calendar>"
  );
});

test("text that fits gets no calendar link", () => {
  assert.equal(
    descriptionToSlack("fits", {
      maxChars: 10,
      moreUrl: "https://example.com",
    }),
    "fits"
  );
});

test("a cut never lands inside a link", () => {
  const out = descriptionToSlack(
    'Register <a href="https://example.com/a/very/long/path">at the sign up page</a> today',
    { maxChars: 30 }
  );
  assert.equal(out, "Register…");
});

test("a cut never lands inside an entity", () => {
  const out = descriptionToSlack("abcdefghij&amp;klm", { maxChars: 12 });
  assert.doesNotMatch(out, /&(a|am|amp)?…/);
});
