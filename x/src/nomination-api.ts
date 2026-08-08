import { logger } from "./logger.js";

export type EngagementStatus =
  | "pending_contact"
  | "contacted"
  | "snoozed"
  | "rejected"
  | "completed";

export type OnboardingStatus =
  | "awaiting_profile"
  | "under_review"
  | "processing"
  | "accepted"
  | "rejected"
  | "removed"
  | "processing_failed";

export interface CreateXNominationRequest {
  source: "x";
  sourceNominationId: string;
  sourcePostUrl: string;
  sourcePostText: string;
  sourcePostCreatedAt: string | null;
  nominatedByXId: string;
  nominatedByXUsername: string;
  nomineeXId: string | null;
  nomineeXUsername: string;
  conversationId: string | null;
  replyToPostId: string | null;
}

export interface XNomination {
  nominationId: string;
  source: "x";
  engagementStatus: EngagementStatus | null;
  onboardingStatus: OnboardingStatus | null;
  joinUrl?: string;
  proposalId: string | null;
  proposalEntityId: string | null;
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

const ENGAGEMENT_STATUSES = new Set<EngagementStatus>([
  "pending_contact",
  "contacted",
  "snoozed",
  "rejected",
  "completed",
]);

const ONBOARDING_STATUSES = new Set<OnboardingStatus>([
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

function endpointUrl(apiUrl: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(apiUrl);
  } catch {
    throw new NominationApiError("NEARBUILDERS_NOMINATION_URL is invalid");
  }
  if (!usesSecureOrLoopbackUrl(endpoint)) {
    throw new NominationApiError(
      "NEARBUILDERS_NOMINATION_URL must use HTTPS",
    );
  }
  return endpoint;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  return candidate === undefined || candidate === null ? null :
    typeof candidate === "string" ? candidate : null;
}

function parseNomination(value: unknown, created: boolean): XNomination {
  if (!isObject(value) || typeof value.nominationId !== "string" || !value.nominationId) {
    throw new NominationApiError("Nomination API returned a malformed response");
  }
  if (value.source !== undefined && value.source !== "x") {
    throw new NominationApiError("Nomination API returned the wrong nomination source");
  }

  const engagementValue = value.engagementStatus;
  if (engagementValue !== undefined &&
      (typeof engagementValue !== "string" ||
        !ENGAGEMENT_STATUSES.has(engagementValue as EngagementStatus))) {
    throw new NominationApiError("Nomination API returned an invalid engagement status");
  }

  const onboardingValue = value.onboardingStatus ?? value.status;
  if (onboardingValue !== undefined && onboardingValue !== null &&
      (typeof onboardingValue !== "string" ||
        !ONBOARDING_STATUSES.has(onboardingValue as OnboardingStatus))) {
    throw new NominationApiError("Nomination API returned an invalid onboarding status");
  }

  const joinUrlValue = value.joinUrl;
  let joinUrl: string | undefined;
  if (joinUrlValue !== undefined && joinUrlValue !== null) {
    if (typeof joinUrlValue !== "string") {
      throw new NominationApiError("Nomination API returned an invalid joinUrl");
    }
    let parsedJoinUrl: URL;
    try {
      parsedJoinUrl = new URL(joinUrlValue);
    } catch {
      throw new NominationApiError("Nomination API returned an invalid joinUrl");
    }
    if (!usesSecureOrLoopbackUrl(parsedJoinUrl)) {
      throw new NominationApiError("Nomination API joinUrl must use HTTPS");
    }
    joinUrl = parsedJoinUrl.toString();
  }

  const proposalId = optionalString(value, "proposalId");
  const proposalEntityId = optionalString(value, "proposalEntityId");
  return {
    nominationId: value.nominationId,
    source: "x",
    engagementStatus: (engagementValue as EngagementStatus | undefined) ?? null,
    onboardingStatus:
      onboardingValue === undefined || onboardingValue === null
        ? null
        : (onboardingValue as OnboardingStatus),
    ...(joinUrl ? { joinUrl } : {}),
    proposalId,
    proposalEntityId,
    created,
  };
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

export const nominationApi = {
  createNomination,
};
