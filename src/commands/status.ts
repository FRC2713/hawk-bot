import { APP_NAME } from "../brand.js";
import { anyInstallation, listSettings } from "../db/repo.js";
import { getSchedulerDiagnostics } from "../scheduler.js";
import type { Command } from "./types.js";

/** "3d 4h", "12m" — precise enough to answer "did it restart?". */
export function humanUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export const status: Command = {
  name: "status",
  summary: "Whether Hawk Bot is healthy, and since when",
  async run(ctx) {
    const installation = anyInstallation();
    const configured = listSettings().length;
    const { lastTickAt, failures } = getSchedulerDiagnostics();

    const lines = [
      `*${APP_NAME}*`,
      `• up ${humanUptime(process.uptime())}`,
      `• installed: ${installation ? `yes, since ${installation.installedAt.slice(0, 10)}` : "no"}`,
      `• commands: ${ctx.registry.length}`,
      `• settings configured: ${configured}`,
      `• last scheduler tick: ${lastTickAt ?? "never"}`,
    ];

    if (failures.length > 0) {
      // mrkdwn collapses leading spaces outside a code span, so each
      // failure gets its own top-level bullet rather than a fake nested
      // list that wouldn't actually render indented.
      for (const f of failures) {
        lines.push(`• scheduler error — ${f.step} (${f.at}): ${f.error}`);
      }
    } else {
      lines.push("• scheduler errors: none since last restart");
    }

    return { text: lines.join("\n") };
  },
};
