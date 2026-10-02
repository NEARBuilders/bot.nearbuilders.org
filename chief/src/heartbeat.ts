import { logEvent } from "./logger.js";

export type HeartbeatStatus = "success" | "fail";

interface HeartbeatOptions {
  fetch?: typeof fetch;
}

export function heartbeatUrl(baseUrl: string, status: HeartbeatStatus): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") {
    throw new Error("DIGEST_HEARTBEAT_URL must use HTTPS");
  }
  if (status === "fail") {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/fail`;
  }
  return url;
}

export async function pingHeartbeat(
  baseUrl: string,
  status: HeartbeatStatus,
  options: HeartbeatOptions = {},
): Promise<boolean> {
  if (!baseUrl) return false;
  const fetcher = options.fetch ?? fetch;
  try {
    const response = await fetcher(heartbeatUrl(baseUrl, status), {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    logEvent(response.ok ? "info" : "warn", "digest.heartbeat", {
      status,
      httpStatus: response.status,
    });
    return response.ok;
  } catch (error) {
    logEvent("warn", "digest.heartbeat_failed", { err: error, status });
    return false;
  }
}
