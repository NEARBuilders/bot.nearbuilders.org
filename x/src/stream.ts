import { logger } from "./logger.js";
import { XApiError, type XApi, type XStream } from "./x-api.js";

export interface StreamState {
  connected: boolean;
}

export interface StreamRunnerOptions {
  client: XApi;
  botUsername: string;
  ruleTag: string;
  onEvent: (event: unknown) => Promise<void>;
  signal: AbortSignal;
  onStateChange?: (state: StreamState) => void;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export function buildStreamRule(botUsername: string): string {
  return `@${botUsername} onboard -is:retweet`;
}

export async function ensureStreamRule(
  client: Pick<XApi, "getStreamRules" | "addStreamRule" | "deleteStreamRules">,
  value: string,
  tag: string,
): Promise<void> {
  const rules = await client.getStreamRules();
  const ownedRules = rules.filter((rule) => rule.tag === tag);
  const matchingRule = ownedRules.find((rule) => rule.value === value);
  const staleIds = ownedRules
    .filter((rule) => rule.value !== value)
    .map((rule) => rule.id);

  if (staleIds.length > 0) await client.deleteStreamRules(staleIds);
  if (!matchingRule) await client.addStreamRule(value, tag);
}

export function defaultSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function closeStream(stream: XStream): void {
  try {
    stream.close();
  } catch (error) {
    logger.warn({ err: error }, "Could not close X stream cleanly");
  }
}

function isFatalStreamError(error: unknown): boolean {
  return error instanceof XApiError && (error.status === 401 || error.status === 403);
}

export async function runFilteredStream(options: StreamRunnerOptions): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const rule = buildStreamRule(options.botUsername);
  let reconnectDelay = 1_000;

  while (!options.signal.aborted) {
    let stream: XStream | undefined;
    try {
      await ensureStreamRule(options.client, rule, options.ruleTag);
      stream = await options.client.streamPosts();
      options.onStateChange?.({ connected: true });
      reconnectDelay = 1_000;

      const abortHandler = () => {
        if (stream) closeStream(stream);
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
      try {
        for await (const event of stream) {
          if (options.signal.aborted) break;
          await options.onEvent(event);
        }
      } finally {
        options.signal.removeEventListener("abort", abortHandler);
        options.onStateChange?.({ connected: false });
      }

      if (!options.signal.aborted) {
        throw new Error("X filtered stream closed");
      }
    } catch (error) {
      options.onStateChange?.({ connected: false });
      if (options.signal.aborted) break;
      if (isFatalStreamError(error)) {
        logger.fatal({ err: error }, "X stream authentication failed");
        throw error;
      }
      logger.error(
        { err: error, reconnectDelay },
        "X filtered stream failed; reconnecting",
      );
      await sleep(reconnectDelay, options.signal);
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
    } finally {
      if (stream) closeStream(stream);
    }
  }
}
