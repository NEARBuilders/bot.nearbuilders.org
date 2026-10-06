import { config } from "./config.js";
import { logEvent } from "./logger.js";

export type RejectionReason = "incomplete" | "not_near" | "spam" | "duplicate";

export interface ReviewDecisionInput {
  proposalId: string;
  submissionCount: number;
  decision: "approve" | "reject";
  reason?: RejectionReason;
  customReason?: string;
  dryRun?: boolean;
  actor: { telegramId: number; username: string | null };
}

export interface ReviewDecisionResult {
  decision: "approved" | "rejected" | "allowed";
  title: string;
  verdict?: "ready" | "review" | "spam" | null;
  summary?: string | null;
}

export interface ReviewApiOptions {
  apiUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

export class ReviewDecisionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ReviewDecisionError";
  }
}

function endpointUrl(apiUrl: string, setting: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(apiUrl);
  } catch {
    throw new ReviewDecisionError(`${setting} is invalid`);
  }
  if (endpoint.protocol !== "https:" && !LOOPBACK_HOSTNAMES.has(endpoint.hostname)) {
    throw new ReviewDecisionError(`${setting} must use HTTPS`);
  }
  return endpoint;
}

function isResult(value: unknown): value is ReviewDecisionResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.decision === "approved" ||
      record.decision === "rejected" ||
      record.decision === "allowed") &&
    typeof record.title === "string"
  );
}

export async function postReviewApi<T>(
  request: {
    apiUrl: string;
    setting: string;
    event: string;
    body: unknown;
    isValid: (value: unknown) => value is T;
  },
  options: ReviewApiOptions = {},
): Promise<T> {
  const apiKey = options.apiKey ?? config.nearBuildersApiKey;
  if (!apiKey) throw new ReviewDecisionError("NEARBUILDERS_API_KEY is not configured");
  const endpoint = endpointUrl(options.apiUrl ?? request.apiUrl, request.setting);
  const fetcher = options.fetch ?? fetch;

  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    logEvent("error", `${request.event}.request_failed`, { err: error });
    throw new ReviewDecisionError("The website could not be reached");
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : `The website returned HTTP ${response.status}`;
    logEvent("warn", `${request.event}.rejected`, { httpStatus: response.status });
    throw new ReviewDecisionError(message.slice(0, 200), response.status);
  }
  if (!request.isValid(body)) {
    throw new ReviewDecisionError("The website returned a malformed response");
  }
  return body;
}

export async function submitReviewDecision(
  input: ReviewDecisionInput,
  options: ReviewApiOptions = {},
): Promise<ReviewDecisionResult> {
  const result = await postReviewApi(
    {
      apiUrl: config.nearReviewDecisionUrl,
      setting: "NEAR_REVIEW_DECISION_URL",
      event: "review_decision",
      body: input,
      isValid: isResult,
    },
    options,
  );
  logEvent("info", "review_decision.completed", { decision: result.decision });
  return result;
}
