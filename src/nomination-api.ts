import { config } from "./config.js";
import { logger } from "./logger.js";

export interface CreateNominationRequest {
  source: "telegram";
  sourceNominationId: string;
  nomineeTelegramId: number;
  nomineeUsername: string | null;
  nominatedByTelegramId: number;
  telegramGroupId: number;
}

export interface NominationHandoff {
  nominationId: string;
  joinUrl: string;
}

interface RequestOptions {
  apiUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
]);

function usesSecureOrLoopbackUrl(url: URL): boolean {
  return url.protocol === "https:" || LOOPBACK_HOSTNAMES.has(url.hostname);
}

function isResponseBody(value: unknown): value is {
  nominationId: string;
  joinUrl: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "nominationId" in value &&
    typeof value.nominationId === "string" &&
    value.nominationId.length > 0 &&
    "joinUrl" in value &&
    typeof value.joinUrl === "string"
  );
}

export async function createNomination(
  input: CreateNominationRequest,
  options: RequestOptions = {},
): Promise<NominationHandoff> {
  const apiUrl = options.apiUrl ?? config.nearNominationUrl;
  const apiKey = options.apiKey ?? config.nearBuildersApiKey;
  const fetcher = options.fetch ?? fetch;

  if (!apiKey) {
    throw new Error("NEARBUILDERS_API_KEY is not configured");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(apiUrl);
  } catch {
    throw new Error("NEAR_NOMINATION_URL is invalid");
  }
  if (!usesSecureOrLoopbackUrl(endpoint)) {
    throw new Error("NEAR_NOMINATION_URL must use HTTPS");
  }

  logger.info(
    {
      sourceNominationId: input.sourceNominationId,
      nomineeTelegramId: input.nomineeTelegramId,
    },
    "Requesting website nomination handoff",
  );

  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `telegram-nomination:${input.sourceNominationId}`,
      "x-api-key": apiKey,
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Nomination API returned HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Nomination API returned invalid JSON");
  }
  if (!isResponseBody(body)) {
    throw new Error("Nomination API returned an invalid handoff response");
  }

  let joinUrl: URL;
  try {
    joinUrl = new URL(body.joinUrl);
  } catch {
    throw new Error("Nomination API returned an invalid joinUrl");
  }
  if (!usesSecureOrLoopbackUrl(joinUrl)) {
    throw new Error("Nomination API joinUrl must use HTTPS");
  }

  return {
    nominationId: body.nominationId,
    joinUrl: joinUrl.toString(),
  };
}
