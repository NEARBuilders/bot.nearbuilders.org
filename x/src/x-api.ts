import { Client } from "@xdevplatform/xdk";

export interface XdkClientLike {
  users: {
    getByUsername(
      username: string,
      options: { userFields: string[] },
    ): Promise<{ data?: unknown }>;
  };
  stream: {
    getRules(options?: {
      maxResults?: number;
      paginationToken?: string;
    }): Promise<{
      data?: Array<{
        id?: unknown;
        value?: unknown;
        tag?: unknown;
      }>;
      meta?: { nextToken?: string };
    }>;
    updateRules(body: unknown): Promise<unknown>;
    posts(options: unknown): Promise<XStream>;
  };
}

export interface XUser {
  id: string;
  username: string;
  name: string | null;
}

export interface XRule {
  id: string;
  value: string;
  tag: string | null;
}

export interface XStream extends AsyncIterable<unknown> {
  close(): void;
}

export interface XApi {
  getUserByUsername(username: string): Promise<XUser | null>;
  getStreamRules(): Promise<XRule[]>;
  addStreamRule(value: string, tag: string): Promise<void>;
  deleteStreamRules(ids: string[]): Promise<void>;
  streamPosts(): Promise<XStream>;
}

export class XApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "XApiError";
  }
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = "status" in error ? error.status : undefined;
  return typeof status === "number" ? status : undefined;
}

function readUser(value: unknown): XUser | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as {
    id?: unknown;
    username?: unknown;
    name?: unknown;
  };
  if (typeof candidate.id !== "string" || typeof candidate.username !== "string") {
    return null;
  }
  return {
    id: candidate.id,
    username: candidate.username,
    name: typeof candidate.name === "string" ? candidate.name : null,
  };
}

export function createXApi(
  bearerToken: string,
  client: XdkClientLike = new Client({ bearerToken }) as unknown as XdkClientLike,
): XApi {

  return {
    async getUserByUsername(username) {
      try {
        const response = await client.users.getByUsername(username, {
          userFields: ["id", "username", "name"],
        });
        return readUser(response.data);
      } catch (error) {
        throw new XApiError("X user lookup failed", errorStatus(error), {
          cause: error,
        });
      }
    },

    async getStreamRules() {
      try {
        const rules: XRule[] = [];
        let paginationToken: string | undefined;

        do {
          const response = await client.stream.getRules({
            maxResults: 100,
            ...(paginationToken ? { paginationToken } : {}),
          });
          for (const rule of response.data ?? []) {
            if (
              typeof rule.id === "string" &&
              typeof rule.value === "string"
            ) {
              rules.push({
                id: rule.id,
                value: rule.value,
                tag: typeof rule.tag === "string" ? rule.tag : null,
              });
            }
          }
          const nextToken = response.meta?.nextToken;
          if (!nextToken || nextToken === paginationToken) break;
          paginationToken = nextToken;
        } while (paginationToken);

        return rules;
      } catch (error) {
        throw new XApiError("X stream rules lookup failed", errorStatus(error), {
          cause: error,
        });
      }
    },

    async addStreamRule(value, tag) {
      try {
        await client.stream.updateRules({
          add: [{ value, tag }],
        });
      } catch (error) {
        throw new XApiError("X stream rule creation failed", errorStatus(error), {
          cause: error,
        });
      }
    },

    async deleteStreamRules(ids) {
      if (ids.length === 0) return;
      try {
        await client.stream.updateRules({
          delete: { ids },
        });
      } catch (error) {
        throw new XApiError("X stream rule deletion failed", errorStatus(error), {
          cause: error,
        });
      }
    },

    async streamPosts() {
      try {
        const stream = await client.stream.posts({
          tweetFields: [
            "id",
            "text",
            "author_id",
            "created_at",
            "conversation_id",
            "referenced_tweets",
          ],
          expansions: ["author_id"],
          userFields: ["id", "username", "name"],
        });
        return stream;
      } catch (error) {
        throw new XApiError("X filtered stream connection failed", errorStatus(error), {
          cause: error,
        });
      }
    },
  };
}
