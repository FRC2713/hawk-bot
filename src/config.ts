import { z } from "zod";
import { suitePublicKey } from "./web/suiteSession.js";

const schema = z.object({
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_CLIENT_ID: z.string().min(1),
  SLACK_CLIENT_SECRET: z.string().min(1),
  SLACK_STATE_SECRET: z.string().min(16),
  // Slack posts events and the OAuth redirect here from its own servers, so
  // this has to be the real public HTTPS origin.
  PUBLIC_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().default("./data"),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  TZ: z.string().default("America/New_York"),
  // The Google service account's full JSON key file, base64-encoded so its
  // embedded private key (which contains literal newlines) survives a .env
  // file intact. Read-only access to the Team Meeting Calendar; the calendar
  // id itself is a workspace setting, not a credential — see domain/settings.ts.
  GOOGLE_SERVICE_ACCOUNT_KEY_BASE64: z.string().min(1),
  // hawk_suite's Slack sign-in gateway, when hawk-bot runs behind it. Rendered
  // into the container by the suite's release, never a workspace setting: a
  // public key an admin could edit from the app is an admin who can mint
  // themselves a session. Unset means "the gateway is off" (rule 6), which is
  // every local run. See CLAUDE.md, "A second door to the same lock", and
  // the both-or-neither check below.
  HAWK_SUITE_ISSUER: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined)
    .pipe(z.string().url().optional()),
  HAWK_SUITE_PUBLIC_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined),
  HAWK_SUITE_AUDIENCE: z.string().min(1).default("hawk-suite"),
});

/**
 * Half-configured is the dangerous state: an issuer with no key verifies
 * nothing, and a key with no issuer has nothing to match against. The key is
 * parsed here too, so a mistyped one is a boot error rather than every
 * HawkBot Admin being denied at the door with the reason buried in a log.
 */
const envSchema = schema.superRefine((value, ctx) => {
  if (!value.HAWK_SUITE_ISSUER !== !value.HAWK_SUITE_PUBLIC_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["HAWK_SUITE_PUBLIC_KEY"],
      message:
        "Set both HAWK_SUITE_ISSUER and HAWK_SUITE_PUBLIC_KEY, or neither",
    });
    return;
  }
  if (!value.HAWK_SUITE_PUBLIC_KEY) return;
  try {
    suitePublicKey(value.HAWK_SUITE_PUBLIC_KEY);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["HAWK_SUITE_PUBLIC_KEY"],
      // The key is public, but the message still quotes none of it (rule 2).
      message: `not an RSA public key (PEM, or base64 of one): ${
        error instanceof Error ? error.message : "unreadable"
      }`,
    });
  }
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

/**
 * Parsed once, on first use rather than at import, so a module that merely
 * imports this one does not need a full Slack environment to load.
 *
 * The error names every variable that failed. A container that crash-loops on
 * a blank credential is otherwise indistinguishable from one that crash-loops
 * on a bug, and `docker compose logs` is the only diagnostic the operator has.
 */
export function config(): Config {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** DATA_DIR without requiring the full Slack environment. */
export function dataDir(): string {
  return process.env.DATA_DIR ?? "./data";
}
