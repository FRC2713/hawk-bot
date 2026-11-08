/** Hawk Suite's trusted-proxy identity contract. Enable only behind Caddy on
 * an isolated app network. These headers are not signed credentials.
 */
export type SuiteIdentity = {
  subject: string;
  teamId: string;
  userId: string;
  name?: string;
  email?: string;
};
type HeaderValues = Record<string, string | string[] | undefined>;

/** Reject duplicate identity fields instead of choosing an arbitrary value. */
export function readSuiteHeaders(
  headers: HeaderValues,
  expectedTeam: string
): SuiteIdentity | undefined {
  function single(name: string): string | undefined {
    const value = headers[name];
    if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
    return value;
  }
  const subject = single("x-token-subject");
  const teamId = single("x-hawk-slack-team");
  const userId = single("x-hawk-slack-user");
  const roles = single("x-token-user-roles");
  if (!teamId || !/^T[A-Z0-9]+$/.test(teamId) || teamId !== expectedTeam)
    return undefined;
  if (!userId || !/^[UW][A-Z0-9]+$/.test(userId)) return undefined;
  if (subject !== `slack:${teamId}:${userId}`) return undefined;
  if (
    !roles ||
    roles.length > 2048 ||
    !/^[a-zA-Z0-9_:/.-]+(?: +[a-zA-Z0-9_:/.-]+)*$/.test(roles) ||
    !roles.split(/ +/).includes("suite/member")
  )
    return undefined;
  const display = (name: string): string | undefined => {
    const value = single(name)?.trim();
    return value && value.length <= 256 ? value : undefined;
  };
  return {
    subject,
    teamId,
    userId,
    name: display("x-token-user-name"),
    email: display("x-token-user-email"),
  };
}
