import { logger } from "./logger.js";
import {
  createNomination,
  type CreateXNominationRequest,
  type XNomination,
} from "./nomination-api.js";
import {
  buildSourcePostUrl,
  isReplyNominationCommand,
  parseNominationCommand,
} from "./parser.js";
import { XApiError, type XApi, type XUser } from "./x-api.js";

interface RecordValue {
  [key: string]: unknown;
}

export interface XPost {
  id: string;
  text: string;
  authorId: string;
  authorUsername: string | null;
  createdAt: string | null;
  conversationId: string | null;
  replyToPostId: string | null;
}

export interface HandlePostDependencies {
  botUsername: string;
  x: Pick<XApi, "getUserByUsername" | "getPostAuthor" | "likePost">;
  nominations: Pick<typeof import("./nomination-api.js"), "createNomination">;
}

export type HandlePostResult =
  | "ignored"
  | "created"
  | "replayed"
  | "lookup_failed"
  | "api_failed";

function asRecord(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null
    ? (value as RecordValue)
    : null;
}

function stringValue(value: RecordValue, ...keys: string[]): string | null {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key] as string;
  }
  return null;
}

export function extractPostEvent(event: unknown): XPost | null {
  const root = asRecord(event);
  const data = asRecord(root?.data);
  if (!data) return null;

  const id = stringValue(data, "id");
  const text = stringValue(data, "text");
  const authorId = stringValue(data, "author_id", "authorId");
  if (!id || !text || !authorId) return null;

  const includes = asRecord(root?.includes);
  const users = Array.isArray(includes?.users) ? includes.users : [];
  const author = users
    .map(asRecord)
    .find((user) => stringValue(user ?? {}, "id") === authorId);

  const referencedTweets = data.referenced_tweets ?? data.referencedTweets;
  const reply = Array.isArray(referencedTweets)
    ? referencedTweets
        .map(asRecord)
        .find((tweet) => stringValue(tweet ?? {}, "type") === "replied_to")
    : null;

  return {
    id,
    text,
    authorId,
    authorUsername: author ? stringValue(author, "username") : null,
    createdAt: stringValue(data, "created_at", "createdAt"),
    conversationId: stringValue(data, "conversation_id", "conversationId"),
    replyToPostId: reply ? stringValue(reply, "id") : null,
  };
}

function isRetryableXError(error: unknown): boolean {
  if (!(error instanceof XApiError)) return true;
  return error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500;
}

async function resolveNominee(
  x: Pick<XApi, "getUserByUsername">,
  username: string,
): Promise<XUser | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await x.getUserByUsername(username);
    } catch (error) {
      if (error instanceof XApiError && error.status === 404) return null;
      if (attempt === 0 && isRetryableXError(error)) {
        logger.warn({ err: error, username }, "Retrying X nominee lookup");
        continue;
      }
      throw error;
    }
  }
  return null;
}

async function resolveReplyNominee(
  x: Pick<XApi, "getPostAuthor">,
  postId: string,
): Promise<XUser | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await x.getPostAuthor(postId);
    } catch (error) {
      if (error instanceof XApiError && error.status === 404) return null;
      if (attempt === 0 && isRetryableXError(error)) {
        logger.warn({ err: error, postId }, "Retrying replied-to X post lookup");
        continue;
      }
      throw error;
    }
  }
  return null;
}

function createRequest(
  post: XPost,
  nominee: XUser,
): CreateXNominationRequest {
  if (!post.authorUsername) {
    throw new Error("Stream event did not include the nominator username");
  }
  return {
    source: "x",
    sourceNominationId: post.id,
    sourcePostUrl: buildSourcePostUrl(post.id),
    sourcePostText: post.text,
    sourcePostCreatedAt: post.createdAt,
    nominatedByXId: post.authorId,
    nominatedByXUsername: post.authorUsername,
    nomineeXId: nominee.id,
    nomineeXUsername: nominee.username,
    conversationId: post.conversationId,
    replyToPostId: post.replyToPostId,
  };
}

async function likeNominationPost(
  x: Pick<XApi, "likePost">,
  postId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await x.likePost(postId);
      return;
    } catch (error) {
      if (attempt === 0 && isRetryableXError(error)) {
        logger.warn({ err: error, postId }, "Retrying X nomination like");
        continue;
      }
      throw error;
    }
  }
}

export async function handlePostEvent(
  event: unknown,
  dependencies: HandlePostDependencies,
): Promise<HandlePostResult> {
  const post = extractPostEvent(event);
  if (!post || !post.authorUsername) return "ignored";

  const command = parseNominationCommand(post.text, dependencies.botUsername);
  const isReplyCommand = isReplyNominationCommand(post.text, dependencies.botUsername);
  if (!command && !isReplyCommand) return "ignored";

  let nominee: XUser | null;
  try {
    if (command) {
      nominee = await resolveNominee(dependencies.x, command.nomineeUsername);
    } else {
      if (!post.replyToPostId) return "ignored";
      nominee = await resolveReplyNominee(dependencies.x, post.replyToPostId);
    }
  } catch (error) {
    logger.error(
      {
        err: error,
        postId: post.id,
        nomineeUsername: command?.nomineeUsername,
        replyToPostId: command ? undefined : post.replyToPostId,
      },
      "Could not resolve X nominee",
    );
    return "lookup_failed";
  }
  if (!nominee) {
    logger.info(
      {
        postId: post.id,
        nomineeUsername: command?.nomineeUsername,
        replyToPostId: command ? undefined : post.replyToPostId,
      },
      "Ignored nomination for an unavailable X user",
    );
    return "ignored";
  }
  if (
    nominee.id === post.authorId ||
    nominee.username.toLowerCase() === post.authorUsername.toLowerCase()
  ) {
    logger.info({ postId: post.id, nomineeXId: nominee.id }, "Ignored X self-nomination");
    return "ignored";
  }

  let nomination: XNomination;
  try {
    nomination = await dependencies.nominations.createNomination(
      createRequest(post, nominee),
    );
  } catch (error) {
    logger.error({ err: error, postId: post.id }, "Could not persist X nomination");
    return "api_failed";
  }

  logger.info(
    {
      postId: post.id,
      nominationId: nomination.nominationId,
      created: nomination.created,
    },
    nomination.created ? "Recorded X nomination" : "Replayed X nomination",
  );

  try {
    await likeNominationPost(dependencies.x, post.id);
  } catch (error) {
    logger.error(
      { err: error, postId: post.id, nominationId: nomination.nominationId },
      "Could not like X nomination post",
    );
  }

  return nomination.created ? "created" : "replayed";
}

export const productionNominationDependencies = {
  createNomination,
};
