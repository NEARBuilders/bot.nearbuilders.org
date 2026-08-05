import { config } from "./config.js";
import { logger } from "./logger.js";

export type NominationStatus =
  | "awaiting_claim"
  | "awaiting_profile"
  | "under_review"
  | "processing"
  | "accepted"
  | "rejected"
  | "removed"
  | "processing_failed";

export interface CreateNominationRequest {
  source: "telegram";
  sourceNominationId: string;
  nomineeTelegramId: number | null;
  nomineeUsername: string | null;
  nominatedByTelegramId: number;
  telegramGroupId: number;
}

export interface ClaimNominationRequest {
  nominationId?: string;
  nomineeTelegramId: number;
  nomineeUsername: string | null;
}

export type Nomination =
  | { nominationId: string; status: "awaiting_claim"; created: boolean }
  | {
      nominationId: string;
      status: "awaiting_profile";
      joinUrl: string;
      created: boolean;
    }
  | {
      nominationId: string;
      status: Exclude<NominationStatus, "awaiting_claim" | "awaiting_profile">;
      created: boolean;
    };

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
const STATUSES = new Set<NominationStatus>([
  "awaiting_claim",
  "awaiting_profile",
  "under_review",
  "processing",
  "accepted",
  "rejected",
  "removed",
  "processing_failed",
]);

export class NominationApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NominationApiError";
  }
}

function usesSecureOrLoopbackUrl(url: URL): boolean {
  return url.protocol === "https:" || LOOPBACK_HOSTNAMES.has(url.hostname);
}

function endpointUrl(apiUrl: string, claim: boolean): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(apiUrl);
  } catch {
    throw new NominationApiError("NEAR_NOMINATION_URL is invalid");
  }
  if (!usesSecureOrLoopbackUrl(endpoint)) {
    throw new NominationApiError("NEAR_NOMINATION_URL must use HTTPS");
  }
  if (claim)
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/claim`;
  return endpoint;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function parseNomination(value: unknown, created: boolean): Nomination {
  if (
    typeof value !== "object" ||
    value === null ||
    !("nominationId" in value) ||
    typeof value.nominationId !== "string" ||
    value.nominationId.length === 0 ||
    !("status" in value) ||
    typeof value.status !== "string" ||
    !STATUSES.has(value.status as NominationStatus)
  ) {
    throw new NominationApiError(
      "Nomination API returned a malformed response",
    );
  }

  const nominationId = value.nominationId;
  const status = value.status as NominationStatus;
  if (status === "awaiting_profile") {
    if (!("joinUrl" in value) || typeof value.joinUrl !== "string") {
      throw new NominationApiError(
        "Nomination API returned a malformed response",
      );
    }
    let joinUrl: URL;
    try {
      joinUrl = new URL(value.joinUrl);
    } catch {
      throw new NominationApiError(
        "Nomination API returned an invalid joinUrl",
      );
    }
    if (!usesSecureOrLoopbackUrl(joinUrl)) {
      throw new NominationApiError("Nomination API joinUrl must use HTTPS");
    }
    return { nominationId, status, joinUrl: joinUrl.toString(), created };
  }

  if ("joinUrl" in value) {
    throw new NominationApiError(
      "Nomination API returned a malformed response",
    );
  }

  if (status === "awaiting_claim") return { nominationId, status, created };
  return { nominationId, status, created };
}

async function requestNomination(
  endpoint: URL,
  input: CreateNominationRequest | ClaimNominationRequest,
  apiKey: string,
  fetcher: typeof fetch,
  idempotencyKey?: string,
): Promise<Nomination> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          "x-api-key": apiKey,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (attempt === 0) {
        logger.warn(
          { err: error, endpoint: endpoint.pathname },
          "Retrying nomination API request",
        );
        continue;
      }
      throw new NominationApiError("Nomination API request failed", undefined, {
        cause: error,
      });
    }

    if (!response.ok) {
      if (attempt === 0 && isRetryableStatus(response.status)) {
        logger.warn(
          { status: response.status, endpoint: endpoint.pathname },
          "Retrying nomination API response",
        );
        continue;
      }
      throw new NominationApiError(
        `Nomination API returned HTTP ${response.status}`,
        response.status,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new NominationApiError(
        "Nomination API returned invalid JSON",
        undefined,
        {
          cause: error,
        },
      );
    }
    return parseNomination(body, response.status === 201);
  }

  throw new NominationApiError("Nomination API request failed");
}

function requestConfiguration(options: RequestOptions, claim: boolean) {
  const apiKey = options.apiKey ?? config.nearBuildersApiKey;
  if (!apiKey)
    throw new NominationApiError("NEARBUILDERS_API_KEY is not configured");
  return {
    endpoint: endpointUrl(options.apiUrl ?? config.nearNominationUrl, claim),
    apiKey,
    fetcher: options.fetch ?? fetch,
  };
}

export async function createNomination(
  input: CreateNominationRequest,
  options: RequestOptions = {},
): Promise<Nomination> {
  const { endpoint, apiKey, fetcher } = requestConfiguration(options, false);
  const idempotencyKey = `telegram-nomination:${input.sourceNominationId}`;
  logger.info(
    {
      sourceNominationId: input.sourceNominationId,
      nomineeTelegramId: input.nomineeTelegramId,
    },
    "Creating or resolving website nomination",
  );
  return await requestNomination(
    endpoint,
    input,
    apiKey,
    fetcher,
    idempotencyKey,
  );
}

export async function claimNomination(
  input: ClaimNominationRequest,
  options: RequestOptions = {},
): Promise<Nomination> {
  const { endpoint, apiKey, fetcher } = requestConfiguration(options, true);
  logger.info(
    {
      nominationId: input.nominationId,
      nomineeTelegramId: input.nomineeTelegramId,
    },
    "Claiming or recovering website nomination",
  );
  return await requestNomination(endpoint, input, apiKey, fetcher);
}

export const nominationApi = {
  createNomination,
  claimNomination,
};
