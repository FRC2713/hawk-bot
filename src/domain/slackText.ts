/**
 * Turns a Google Calendar event description into text that is safe and
 * readable inside a Slack message.
 *
 * Why this exists: Calendar descriptions are frequently HTML
 * (`<a href="…">…</a>`, `<br>`, `<b>`, `<ul>`), and Slack's mrkdwn gives
 * `<` and `>` a meaning of its own. Pasting the description in as-is shows
 * the tags as literal text (#60), and — worse — lets a plain-text
 * description smuggle in Slack control sequences such as `<!channel>`.
 *
 * Every description is treated as possibly HTML: entities are decoded, the
 * handful of tags that map onto Slack formatting are converted, every other
 * tag is dropped, and whatever text is left is escaped for Slack. Pure — no
 * Slack, no I/O.
 */

/** Longest a description may run in the main announcement post. */
export const DESCRIPTION_MAX_CHARS = 600;

/** Each side of the before/after description line in an "edited" thread reply. */
export const DESCRIPTION_DIFF_MAX_CHARS = 200;

export interface DescriptionOptions {
  /** Cut the converted text to about this many characters. */
  maxChars?: number;
  /**
   * When the text is cut, link here ("see the rest on the calendar"). Left
   * out when the Event has no calendar entry.
   */
  moreUrl?: string | null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** An HTML comment, or an opening/closing tag. `<https://x>` is not a tag: a name must be followed by whitespace, `/` or `>`. */
const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[\s/][^>]*)?)>/g;

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "ul",
  "ol",
  "tr",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, entity: string) => {
      if (entity.startsWith("#")) {
        const code =
          entity.charAt(1).toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
    }
  );
}

/** The three characters Slack requires escaping in message text. */
function escapeSlack(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function hrefOf(attributes: string): string | undefined {
  const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
    attributes
  );
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeEntities(value).trim();
}

function convert(html: string): string {
  let out = "";
  let bold = false;
  let italic = false;
  let link: { href: string; text: string } | null = null;

  const emitText = (decoded: string) => {
    if (link) link.text += decoded;
    else out += escapeSlack(decoded);
  };

  /** Start a new line unless already at the start of one. */
  const softBreak = () => {
    if (link) link.text += " ";
    else if (out !== "" && !out.endsWith("\n")) out += "\n";
  };

  const hardBreak = () => {
    if (link) link.text += " ";
    else out += "\n";
  };

  /**
   * Slack only formats `*x*` when the marks hug the text, so trailing
   * whitespace moves outside the closing mark; a pair with nothing between
   * is dropped rather than left as `**`.
   */
  const closeMark = (mark: string) => {
    const trailing = /\s*$/.exec(out)![0];
    let body = out.slice(0, out.length - trailing.length);
    body = body.endsWith(mark) ? body.slice(0, -1) : body + mark;
    out = body + trailing;
  };

  const closeLink = () => {
    if (!link) return;
    const { href, text } = link;
    link = null;
    const label = text.replace(/\s+/g, " ").trim();
    if (!SAFE_URL.test(href)) {
      out += escapeSlack(label);
      return;
    }
    const url = escapeSlack(href);
    out +=
      !label || label === href ? `<${url}>` : `<${url}|${escapeSlack(label)}>`;
  };

  let last = 0;
  for (const match of html.matchAll(TOKEN)) {
    emitText(decodeEntities(html.slice(last, match.index)));
    last = match.index + match[0].length;
    if (match[0].startsWith("<!--")) continue;

    const closing = match[1] === "/";
    const name = (match[2] ?? "").toLowerCase();

    if (name === "a") {
      closeLink();
      if (!closing) {
        const href = hrefOf(match[3] ?? "");
        if (href) link = { href, text: "" };
      }
    } else if (name === "b" || name === "strong") {
      if (link) continue;
      if (!closing && !bold) {
        out += "*";
        bold = true;
      } else if (closing && bold) {
        closeMark("*");
        bold = false;
      }
    } else if (name === "i" || name === "em") {
      if (link) continue;
      if (!closing && !italic) {
        out += "_";
        italic = true;
      } else if (closing && italic) {
        closeMark("_");
        italic = false;
      }
    } else if (name === "br") {
      hardBreak();
    } else if (name === "li") {
      softBreak();
      if (!closing && !link) out += "• ";
    } else if (BLOCK_TAGS.has(name)) {
      softBreak();
    }
    // Any other tag (span, font, img, table cells, …) is dropped; its text stays.
  }
  emitText(decodeEntities(html.slice(last)));

  closeLink();
  if (bold) closeMark("*");
  if (italic) closeMark("_");

  return out
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Cuts converted text to about `max` characters, preferring a line or word
 * boundary, and never inside a `<link>` or an `&entity;` — either would
 * reach Slack broken.
 */
function truncate(
  text: string,
  max: number,
  moreUrl: string | null | undefined
): string {
  if (text.length <= max) return text;

  let cut = text.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  if (boundary > max / 2) cut = cut.slice(0, boundary);

  // Every literal `<` was escaped, so any `<` left is the start of a link.
  const open = cut.lastIndexOf("<");
  if (open > cut.lastIndexOf(">")) cut = cut.slice(0, open);

  const amp = cut.lastIndexOf("&");
  if (amp !== -1 && /^&[a-z0-9]*$/i.test(cut.slice(amp)))
    cut = cut.slice(0, amp);

  cut = `${cut.trimEnd()}…`;
  return moreUrl
    ? `${cut}\n<${escapeSlack(moreUrl)}|See the rest on the calendar>`
    : cut;
}

/**
 * The description as Slack message text, or "" when nothing readable is
 * left (empty, or only markup).
 */
export function descriptionToSlack(
  raw: string,
  options: DescriptionOptions = {}
): string {
  const converted = convert(raw.replace(/\r\n?/g, "\n"));
  return truncate(
    converted,
    options.maxChars ?? DESCRIPTION_MAX_CHARS,
    options.moreUrl
  );
}
