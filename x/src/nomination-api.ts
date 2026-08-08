import { logger } from "./logger.js";

export interface CreateXNominationRequest {
  source: "x";
  sourceNominationId: string;
  sourcePostUrl: string;
  sourcePostText: string;
  sourcePostCreatedAt: string | null;
  nominatedByXId: string;
  nominatedByXUsername: string;
  nomineeXId: string;
  nomineeXUsername: string;
  conversationId: string | null;
  replyToPostId: string | null;
}

export interface XNomination {
  nominationId: string;
  created: boolean;
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

function endpointUrl(apiUrl: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(apiUrl);
  } catch {
    throw new NominationApiError("NEARBUILDERS_NOMINATION_URL is invalid");
  }
  if (endpoint.protocol !== "https:" && !LOOPBACK_HOSTNAMES.has(endpoint.hostname)) {
    throw new NominationApiError("NEARBUILDERS_NOMINATION_URL must use HTTPS");
  }
  return endpoint;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function parseNomination(value: unknown, created: boolean): XNomination {
  if (
    typeof value !== "object" ||
    value === null ||
    !("nominationId" in value) ||
    typeof value.nominationId !== "string" ||
    !value.nominationId
  ) {
    throw new NominationApiError("Nomination API returned a malformed response");
  }
  return { nominationId: value.nominationId, created };
}

function requestConfiguration(options: RequestOptions) {
  const apiKey = options.apiKey ?? process.env.NEARBUILDERS_API_KEY ?? "";
  if (!apiKey) {
    throw new NominationApiError("NEARBUILDERS_API_KEY is not configured");
  }
  return {
    endpoint: endpointUrl(
      options.apiUrl ??
        process.env.NEARBUILDERS_NOMINATION_URL ??
        "https://nearbuilders.org/api/builders/nominations/x",
    ),
    apiKey,
    fetcher: options.fetch ?? fetch,
  };
}

async function requestNomination(
  endpoint: URL,
  input: CreateXNominationRequest,
  apiKey: string,
  fetcher: typeof fetch,
): Promise<XNomination> {
  const idempotencyKey = `x-nomination:${input.sourceNominationId}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
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
      throw new NominationApiError("Nomination API returned invalid JSON", undefined, {
        cause: error,
      });
    }
    return parseNomination(body, response.status === 201);
  }
  throw new NominationApiError("Nomination API request failed");
}

export async function createNomination(
  input: CreateXNominationRequest,
  options: RequestOptions = {},
): Promise<XNomination> {
  const { endpoint, apiKey, fetcher } = requestConfiguration(options);
  logger.info(
    {
      sourceNominationId: input.sourceNominationId,
      nominatedByXId: input.nominatedByXId,
      nomineeXId: input.nomineeXId,
    },
    "Creating or resolving X nomination",
  );
  return await requestNomination(endpoint, input, apiKey, fetcher);
}

export const nominationApi = { createNomination };
