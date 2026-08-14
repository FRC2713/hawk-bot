import { APP_NAME } from "../brand.js";
import { anyInstallation, listSettings } from "../db/repo.js";
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
    return {
      text: [
        `*${APP_NAME}*`,
        `• up ${humanUptime(process.uptime())}`,
        `• installed: ${installation ? `yes, since ${installation.installedAt.slice(0, 10)}` : "no"}`,
        `• commands: ${ctx.registry.length}`,
        `• settings configured: ${configured}`,
      ].join("\n"),
    };
  },
};
