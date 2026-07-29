import { config } from "./config.js";
import type { ApiPayload } from "./conversation.js";
import { logger } from "./logger.js";

interface SubmissionBody {
  pluginId: "builders";
  entityId: string;
  payload: ApiPayload;
  source: "telegram";
  metadata: {
    nominatedBy?: string;
    telegramChatId?: number;
  };
}

export async function submitBuilder(input: {
  payload: ApiPayload;
  userId: number;
  nearAddress: string | null;
  nominatedByUserId: number | null;
  groupChatId: number | null;
}): Promise<{ success: boolean; message: string }> {
  const payload: ApiPayload = {};
  if (input.payload.name) payload.name = input.payload.name;
  if (input.payload.bio) payload.bio = input.payload.bio;
  if (input.payload.skills?.length) payload.skills = input.payload.skills;
  if (input.payload.location) payload.location = input.payload.location;
  if (
    input.payload.links &&
    Object.keys(input.payload.links).length > 0
  ) {
    payload.links = input.payload.links;
  }

  const body: SubmissionBody = {
    pluginId: "builders",
    entityId: input.nearAddress
      ? input.nearAddress.trim()
      : `telegram:${input.userId}`,
    payload,
    source: "telegram",
    metadata: {},
  };

  if (input.nominatedByUserId) {
    body.metadata.nominatedBy = `telegram:${input.nominatedByUserId}`;
  }
  if (input.groupChatId) {
    body.metadata.telegramChatId = input.groupChatId;
  }

  logger.info({ body }, "Outgoing API request");
  if (!config.nearBuildersApiKey) {
    logger.warn(
      "NEARBUILDERS_API_KEY is not set - request will likely fail with 401",
    );
  }

  try {
    const response = await fetch(config.nearOnboardingUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.nearBuildersApiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const responseText = await response.text();
    logger.info(
      { status: response.status, responseBody: responseText },
      "API response",
    );

    if (response.status === 200 || response.status === 201) {
      return { success: true, message: "Success" };
    }
    return {
      success: false,
      message: `API returned ${response.status}: ${responseText}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, "API request failed");
    return { success: false, message: `Request error: ${message}` };
  }
}
