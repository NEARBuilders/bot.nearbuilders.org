export const X_USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

export interface ParsedNominationCommand {
  nomineeUsername: string;
  nomineeUsernameNormalized: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeXUsername(username: string): string {
  return username.trim().replace(/^@/, "").toLowerCase();
}

export function parseNominationCommand(
  text: string,
  botUsername: string,
): ParsedNominationCommand | null {
  const normalizedBotUsername = normalizeXUsername(botUsername);
  if (!X_USERNAME_PATTERN.test(normalizedBotUsername)) return null;

  const pattern = new RegExp(
    `(?:^|\\s)@${escapeRegExp(normalizedBotUsername)}(?![A-Za-z0-9_])\\s+!onboard(?![A-Za-z0-9_])\\s+@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])`,
    "gi",
  );
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) return null;

  const nomineeUsername = matches[0]?.[1];
  if (!nomineeUsername || !X_USERNAME_PATTERN.test(nomineeUsername)) return null;
  return {
    nomineeUsername,
    nomineeUsernameNormalized: normalizeXUsername(nomineeUsername),
  };
}

export function isReplyNominationCommand(
  text: string,
  botUsername: string,
): boolean {
  const normalizedBotUsername = normalizeXUsername(botUsername);
  if (!X_USERNAME_PATTERN.test(normalizedBotUsername)) return false;

  const pattern = new RegExp(
    `^\\s*@${escapeRegExp(normalizedBotUsername)}(?![A-Za-z0-9_])\\s+!onboard(?![A-Za-z0-9_])\\s*$`,
    "i",
  );
  return pattern.test(text);
}

export function buildSourcePostUrl(postId: string): string {
  return `https://x.com/i/web/status/${encodeURIComponent(postId)}`;
}
