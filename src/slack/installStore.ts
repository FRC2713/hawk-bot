import type {
  Installation,
  InstallationQuery,
  InstallationStore,
} from "@slack/bolt";
import {
  getInstallation,
  revokeInstallation,
  saveInstallation,
} from "../db/repo.js";
import { log } from "../logger.js";

function teamKey(
  q: InstallationQuery<boolean> | Installation<"v1" | "v2", boolean>
): string {
  const anyQ = q as {
    teamId?: string;
    enterpriseId?: string;
    team?: { id: string };
    enterprise?: { id: string };
  };
  const id =
    anyQ.teamId ?? anyQ.team?.id ?? anyQ.enterpriseId ?? anyQ.enterprise?.id;
  if (!id) throw new Error("Installation has neither team nor enterprise id");
  return id;
}

/**
 * One row per workspace, holding the bot token.
 *
 * Hawk Bot requests no user scopes — everything it does, it does as itself, in
 * public. That is deliberate: a bot that manages a team lives in a workspace
 * shared with minors, and the way to keep it uncontroversial is for it to have
 * no ability to read anything a person could not see it read.
 */
export const installationStore: InstallationStore = {
  async storeInstallation(installation) {
    const teamId = teamKey(installation);
    saveInstallation({
      teamId,
      enterpriseId: installation.enterprise?.id ?? null,
      payload: installation,
      scopes: (installation.bot?.scopes ?? []).join(","),
    });
    log.info("installation stored", {
      teamId,
      installedBy: installation.user?.id,
    });
  },

  async fetchInstallation(query) {
    const teamId = teamKey(query);
    const stored = getInstallation(teamId);
    if (!stored) throw new Error(`No installation stored for team ${teamId}`);
    return stored.payload as Installation;
  },

  async deleteInstallation(query) {
    const teamId = teamKey(query);
    revokeInstallation(teamId);
    log.info("installation revoked", { teamId });
  },
};
