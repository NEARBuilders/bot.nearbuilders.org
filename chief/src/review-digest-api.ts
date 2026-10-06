import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";
import { logEvent } from "./logger.js";

export const REVIEW_PLUGIN_IDS = [
  "builders",
  "projects",
  "events",
  "nearcatalog",
] as const;

export type ReviewPluginId = (typeof REVIEW_PLUGIN_IDS)[number];

export type ReviewItemState =
  | "pending"
  | "apply_failed"
  | "remove_failed"
  | "stalled";

export type EvaluationVerdict = "ready" | "review" | "spam";

export interface ItemEvaluation {
  verdict: EvaluationVerdict;
  score: number | null;
  summary: string;
  flags: string[];
  source: string | null;
}

export interface ReviewDigestItem {
  id: string;
  pluginId: ReviewPluginId;
  entityId: string;
  title: string;
  submittedBy: string | null;
  detail: string | null;
  submissionCount: number | null;
  evaluation: ItemEvaluation | null;
  state: ReviewItemState;
  createdAt: string;
  ageDays: number;
  isNew: boolean;
  isStale: boolean;
  dashboardPath: string;
}

export interface ReviewWindow {
  reviewed: number;
  medianWaitDays: number | null;
}

export interface ReviewActivity {
  last24h: { approved: number; rejected: number };
  last7d: ReviewWindow;
  previous7d: ReviewWindow;
}

export interface ReviewDigest {
  generatedAt: string;
  staleAfterDays: number;
  totals: {
    pending: number;
    newLast24h: number;
    stale: number;
    needsAttention: number;
    oldestPendingDays: number | null;
  };
  byPlugin: Record<ReviewPluginId, number>;
  activity: ReviewActivity | null;
  items: ReviewDigestItem[];
}

interface FetchOptions {
  apiUrl?: string;
  apiKey?: string;
  staleAfterDays?: number;
  fetch?: typeof fetch;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<unknown>;
}

export const DEFAULT_RETRY_DELAYS_MS = [
  30_000, 120_000, 300_000, 480_000,
] as const;

const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
]);
const ITEM_STATES = new Set<ReviewItemState>([
  "pending",
  "apply_failed",
  "remove_failed",
  "stalled",
]);

export class ReviewDigestApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ReviewDigestApiError";
  }
}

function malformed(): ReviewDigestApiError {
  return new ReviewDigestApiError(
    "Review digest API returned a malformed response",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw malformed();
  return value.length > 0 ? value : null;
}

function optionalCount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!isCount(value)) throw malformed();
  return value;
}

const VERDICTS = new Set<EvaluationVerdict>(["ready", "review", "spam"]);

function parseEvaluation(value: unknown): ItemEvaluation | null {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.verdict !== "string" ||
    !VERDICTS.has(value.verdict as EvaluationVerdict) ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.flags)
  ) {
    throw malformed();
  }
  const score = value.score;
  if (score !== null && !isCount(score)) throw malformed();
  return {
    verdict: value.verdict as EvaluationVerdict,
    score: score as number | null,
    summary: value.summary,
    flags: value.flags.filter((flag): flag is string => typeof flag === "string"),
    source: optionalString(value.source),
  };
}

function parseWindow(value: unknown): ReviewWindow {
  if (!isRecord(value) || !isCount(value.reviewed)) throw malformed();
  const median = value.medianWaitDays;
  if (
    median !== null &&
    (typeof median !== "number" || !Number.isFinite(median) || median < 0)
  ) {
    throw malformed();
  }
  return { reviewed: value.reviewed, medianWaitDays: median };
}

function parseActivity(value: unknown): ReviewActivity | null {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    !isRecord(value.last24h) ||
    !isCount(value.last24h.approved) ||
    !isCount(value.last24h.rejected)
  ) {
    throw malformed();
  }
  return {
    last24h: {
      approved: value.last24h.approved,
      rejected: value.last24h.rejected,
    },
    last7d: parseWindow(value.last7d),
    previous7d: parseWindow(value.previous7d),
  };
}

function isPluginId(value: unknown): value is ReviewPluginId {
  return (REVIEW_PLUGIN_IDS as readonly unknown[]).includes(value);
}

function parseItem(value: unknown): ReviewDigestItem {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isPluginId(value.pluginId) ||
    !isNonEmptyString(value.entityId) ||
    !isNonEmptyString(value.title) ||
    typeof value.state !== "string" ||
    !ITEM_STATES.has(value.state as ReviewItemState) ||
    !isNonEmptyString(value.createdAt) ||
    !isCount(value.ageDays) ||
    typeof value.isNew !== "boolean" ||
    typeof value.isStale !== "boolean" ||
    typeof value.dashboardPath !== "string" ||
    !value.dashboardPath.startsWith("/admin/dashboard/")
  ) {
    throw malformed();
  }
  return {
    id: value.id,
    pluginId: value.pluginId,
    entityId: value.entityId,
    title: value.title,
    submittedBy: optionalString(value.submittedBy),
    detail: optionalString(value.detail),
    submissionCount: optionalCount(value.submissionCount),
    evaluation: parseEvaluation(value.evaluation),
    state: value.state as ReviewItemState,
    createdAt: value.createdAt,
    ageDays: value.ageDays,
    isNew: value.isNew,
    isStale: value.isStale,
    dashboardPath: value.dashboardPath,
  };
}

export function parseReviewDigest(value: unknown): ReviewDigest {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.generatedAt) ||
    !isCount(value.staleAfterDays) ||
    !isRecord(value.totals) ||
    !isRecord(value.byPlugin) ||
    !Array.isArray(value.items)
  ) {
    throw malformed();
  }
  const { totals, byPlugin } = value;
  if (
    !isCount(totals.pending) ||
    !isCount(totals.newLast24h) ||
    !isCount(totals.stale) ||
    !isCount(totals.needsAttention)
  ) {
    throw malformed();
  }
  const counts = {} as Record<ReviewPluginId, number>;
  for (const pluginId of REVIEW_PLUGIN_IDS) {
    const count = byPlugin[pluginId] ?? 0;
    if (!isCount(count)) throw malformed();
    counts[pluginId] = count;
  }
  return {
    generatedAt: value.generatedAt,
    staleAfterDays: value.staleAfterDays,
    totals: {
      pending: totals.pending,
      newLast24h: totals.newLast24h,
      stale: totals.stale,
      needsAttention: totals.needsAttention,
      oldestPendingDays: optionalCount(totals.oldestPendingDays),
    },
    byPlugin: counts,
    activity: parseActivity(value.activity),
    items: value.items.map(parseItem),
  };
}

function endpointUrl(apiUrl: string, staleAfterDays: number): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(apiUrl);
  } catch {
    throw new ReviewDigestApiError("NEAR_REVIEW_DIGEST_URL is invalid");
  }
  if (
    endpoint.protocol !== "https:" &&
    !LOOPBACK_HOSTNAMES.has(endpoint.hostname)
  ) {
    throw new ReviewDigestApiError("NEAR_REVIEW_DIGEST_URL must use HTTPS");
  }
  endpoint.searchParams.set("staleAfterDays", String(staleAfterDays));
  return endpoint;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function requestOnce(
  endpoint: URL,
  apiKey: string,
  fetcher: typeof fetch,
): Promise<ReviewDigest> {
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "GET",
      headers: { accept: "application/json", "x-api-key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ReviewDigestApiError(
      "Review digest API request failed",
      undefined,
      true,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new ReviewDigestApiError(
      `Review digest API returned HTTP ${response.status}`,
      response.status,
      isRetryableStatus(response.status),
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ReviewDigestApiError(
      "Review digest API returned invalid JSON",
      response.status,
      false,
      { cause: error },
    );
  }
  return parseReviewDigest(body);
}

export async function fetchReviewDigest(
  options: FetchOptions = {},
): Promise<ReviewDigest> {
  const apiKey = options.apiKey ?? config.nearBuildersApiKey;
  if (!apiKey) {
    throw new ReviewDigestApiError("NEARBUILDERS_API_KEY is not configured");
  }
  const endpoint = endpointUrl(
    options.apiUrl ?? config.nearReviewDigestUrl,
    options.staleAfterDays ?? config.digestStaleAfterDays,
  );
  const fetcher = options.fetch ?? fetch;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const wait = options.sleep ?? sleep;
  const startedAt = Date.now();

  for (let attempt = 1; ; attempt += 1) {
    try {
      const digest = await requestOnce(endpoint, apiKey, fetcher);
      logEvent("info", "review_digest_api.completed", {
        attempt,
        endpointPath: endpoint.pathname,
        pending: digest.totals.pending,
        needsAttention: digest.totals.needsAttention,
        durationMs: Date.now() - startedAt,
      });
      return digest;
    } catch (error) {
      const retryable =
        error instanceof ReviewDigestApiError && error.retryable;
      const delayMs = retryDelaysMs[attempt - 1];
      const httpStatus =
        error instanceof ReviewDigestApiError ? error.status : undefined;
      if (!retryable || delayMs === undefined) {
        logEvent("error", "review_digest_api.failure", {
          err: error,
          attempt,
          httpStatus,
          retryable,
          endpointPath: endpoint.pathname,
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
      logEvent("warn", "review_digest_api.retry", {
        err: error,
        attempt,
        httpStatus,
        delayMs,
        endpointPath: endpoint.pathname,
      });
      await wait(delayMs);
    }
  }
}
