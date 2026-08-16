import { calendar } from "./calendar.js";
import { config } from "./config.js";
import { event } from "./event.js";
import { help } from "./help.js";
import { report } from "./report.js";
import { status } from "./status.js";
import type { Command } from "./types.js";
import { whoami } from "./whoami.js";

/**
 * Every subcommand `/hawkbot` accepts, in the order `help` lists them.
 *
 * Adding a capability to Hawk Bot is adding a file next to these and a line
 * here. Nothing else knows the list: the router resolves against it, `help`
 * renders it, and the App Home reads it, so a new command is documented and
 * reachable the moment it is registered.
 */
export const COMMANDS: readonly Command[] = [
  help,
  status,
  whoami,
  config,
  report,
  event,
  calendar,
];
