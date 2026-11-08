import { z } from "zod";

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
  // Trust only an isolated Hawk Suite gateway, never arbitrary direct requests.
  HAWK_SUITE_TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  HAWK_SUITE_TEAM_ID: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined)
    .pipe(
      z
        .string()
        .regex(/^T[A-Z0-9]+$/)
        .optional()
    ),
  HAWK_SUITE_ISSUER: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined)
    .pipe(z.string().url().optional()),
});

const envSchema = schema.superRefine((value, ctx) => {
  if (
    value.HAWK_SUITE_TRUST_PROXY &&
    (!value.HAWK_SUITE_ISSUER || !value.HAWK_SUITE_TEAM_ID)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["HAWK_SUITE_TRUST_PROXY"],
      message:
        "Trusted proxy mode requires HAWK_SUITE_ISSUER and HAWK_SUITE_TEAM_ID",
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
