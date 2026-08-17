import { ErrorCode, type WebAPIPlatformError } from "@slack/web-api";

function isPlatformError(err: unknown): err is WebAPIPlatformError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === ErrorCode.PlatformError
  );
}

/** The Slack error code (e.g. `channel_not_found`) behind a thrown Web API error, or undefined for anything else. */
export function slackErrorCode(err: unknown): string | undefined {
  return isPlatformError(err) ? err.data.error : undefined;
}
