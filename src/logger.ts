type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const min = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 1;

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (order[level] < min) return;
  const line = { t: new Date().toISOString(), level, msg, ...fields };
  // Everything goes to stderr, info included, so stdout stays free for
  // anything a human or a pipe is meant to read.
  console.error(JSON.stringify(line));
}

/**
 * Structured, one JSON object per line — `docker compose logs hawk-bot` is the
 * only place these are read from, and grep is the only tool.
 *
 * Never log message text or a token. This app sits in a workspace shared with
 * minors; stdout is neither access-controlled nor auditable.
 */
export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};
