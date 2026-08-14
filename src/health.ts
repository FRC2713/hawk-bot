import type { ServerResponse } from "node:http";
import { COMMANDS } from "./commands/registry.js";
import { db } from "./db/client.js";
import { anyInstallation } from "./db/repo.js";

type Health = {
  status: "ok" | "error";
  installed: boolean;
  commands: number;
  uptimeSeconds: number;
  error?: string;
};

/**
 * Liveness/readiness probe for the container, and what the deploy workflow
 * checks from outside. Touches SQLite so an unwritable or unmigrated volume
 * shows up here rather than later, as a command that mysteriously does
 * nothing.
 *
 * `installed: false` is not unhealthy — a freshly deployed container is
 * expected to be running and waiting for an admin to install the app.
 */
export function healthHandler(_req: unknown, res: ServerResponse): void {
  let body: Health;
  let code: number;
  try {
    db().prepare("SELECT 1").get();
    body = {
      status: "ok",
      installed: anyInstallation() !== undefined,
      commands: COMMANDS.length,
      uptimeSeconds: Math.round(process.uptime()),
    };
    code = 200;
  } catch (error) {
    body = {
      status: "error",
      installed: false,
      commands: COMMANDS.length,
      uptimeSeconds: Math.round(process.uptime()),
      error: error instanceof Error ? error.message : "unknown error",
    };
    code = 503;
  }
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
