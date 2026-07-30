import pg from "pg";
import { config } from "./config.js";

const { Pool, types } = pg;

// Telegram IDs have at most 52 significant bits and are safe JS numbers.
types.setTypeParser(20, (value) => Number(value));

export interface BotUser {
  user_id: number;
  username: string | null;
  first_name: string | null;
}

export interface Nomination {
  id: number;
  nominated_user_id: number;
  nominated_by_user_id: number;
  group_chat_id: number;
  confirmed_at: Date | null;
  website_nomination_id: string | null;
}

export interface PendingNomination {
  username: string;
  nominated_by_user_id: number;
  group_chat_id: number;
  created_at: Date;
}

let pool: pg.Pool | undefined;

function getPool(): pg.Pool {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is not set in .env");
  }
  pool ??= new Pool({ connectionString: config.databaseUrl });
  return pool;
}

export async function setupDb(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS bot_users (
      user_id        BIGINT PRIMARY KEY,
      username       TEXT,
      first_name     TEXT,
      started_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW(),
      completed_at   TIMESTAMPTZ DEFAULT NULL,
      confirmed_at   TIMESTAMPTZ DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS nomination_log (
      id                   SERIAL PRIMARY KEY,
      nominated_user_id    BIGINT,
      nominated_username   TEXT,
      nominated_by_user_id BIGINT NOT NULL,
      group_chat_id        BIGINT NOT NULL,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      confirmed_at         TIMESTAMPTZ DEFAULT NULL,
      website_nomination_id TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_nominations (
      username             TEXT PRIMARY KEY,
      nominated_by_user_id BIGINT NOT NULL,
      group_chat_id        BIGINT NOT NULL,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE bot_users
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ DEFAULT NULL;

    ALTER TABLE bot_users
      ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ DEFAULT NULL;

    ALTER TABLE nomination_log
      ADD COLUMN IF NOT EXISTS nominated_username TEXT;

    ALTER TABLE nomination_log
      ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ DEFAULT NULL;

    ALTER TABLE nomination_log
      ADD COLUMN IF NOT EXISTS website_nomination_id TEXT DEFAULT NULL;

    ALTER TABLE nomination_log
      DROP COLUMN IF EXISTS handoff_expires_at;

    ALTER TABLE nomination_log
      ALTER COLUMN nominated_user_id DROP NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS nomination_log_website_nomination_id_idx
      ON nomination_log (website_nomination_id)
      WHERE website_nomination_id IS NOT NULL;
  `);
}

export async function hasStartedBot(userId: number): Promise<boolean> {
  const result = await getPool().query(
    "SELECT 1 FROM bot_users WHERE user_id = $1",
    [userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function hasPendingNomination(username: string): Promise<boolean> {
  const result = await getPool().query(
    "SELECT 1 FROM pending_nominations WHERE LOWER(username) = LOWER($1)",
    [username],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function registerUser(
  userId: number,
  username: string | undefined,
  firstName: string | undefined,
): Promise<void> {
  await getPool().query(
    `INSERT INTO bot_users (user_id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET username = EXCLUDED.username,
           first_name = EXCLUDED.first_name,
           updated_at = NOW()`,
    [userId, username ?? null, firstName ?? null],
  );
}

export async function logNomination(input: {
  nominatedByUserId: number;
  groupChatId: number;
  nominatedUserId?: number;
  nominatedUsername?: string;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO nomination_log
       (nominated_user_id, nominated_username, nominated_by_user_id, group_chat_id)
     VALUES ($1, $2, $3, $4)`,
    [
      input.nominatedUserId ?? null,
      input.nominatedUsername ?? null,
      input.nominatedByUserId,
      input.groupChatId,
    ],
  );
}

export async function addPendingNomination(
  username: string,
  nominatedByUserId: number,
  groupChatId: number,
): Promise<void> {
  await getPool().query(
    `INSERT INTO pending_nominations
       (username, nominated_by_user_id, group_chat_id)
     VALUES (LOWER($1), $2, $3)
     ON CONFLICT (username) DO UPDATE
       SET nominated_by_user_id = EXCLUDED.nominated_by_user_id,
           group_chat_id = EXCLUDED.group_chat_id,
           created_at = NOW()`,
    [username, nominatedByUserId, groupChatId],
  );
}

export async function claimPendingNomination(
  userId: number,
  username: string,
): Promise<PendingNomination | null> {
  if (!username) return null;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<PendingNomination>(
      `SELECT username, nominated_by_user_id, group_chat_id, created_at
       FROM pending_nominations
       WHERE LOWER(username) = LOWER($1)
       FOR UPDATE`,
      [username],
    );
    const nomination = result.rows[0];
    if (!nomination) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `INSERT INTO nomination_log
         (nominated_user_id, nominated_username, nominated_by_user_id, group_chat_id)
       VALUES ($1, $2, $3, $4)`,
      [
        userId,
        username,
        nomination.nominated_by_user_id,
        nomination.group_chat_id,
      ],
    );
    await client.query(
      "DELETE FROM pending_nominations WHERE LOWER(username) = LOWER($1)",
      [username],
    );
    await client.query("COMMIT");
    return nomination;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markCompleted(userId: number): Promise<void> {
  await getPool().query(
    `UPDATE bot_users
     SET completed_at = NOW(), updated_at = NOW()
     WHERE user_id = $1`,
    [userId],
  );
}

export async function hasCompleted(userId: number): Promise<boolean> {
  const result = await getPool().query<{ completed_at: Date | null }>(
    "SELECT completed_at FROM bot_users WHERE user_id = $1",
    [userId],
  );
  return result.rows[0]?.completed_at != null;
}

export async function hasConfirmed(userId: number): Promise<boolean> {
  const result = await getPool().query<{
    confirmed_at: Date | null;
    completed_at: Date | null;
  }>(
    `SELECT confirmed_at, completed_at
     FROM bot_users
     WHERE user_id = $1`,
    [userId],
  );
  const user = result.rows[0];
  return user?.confirmed_at != null || user?.completed_at != null;
}

export async function getUserByUsername(
  username: string,
): Promise<BotUser | null> {
  const result = await getPool().query<BotUser>(
    `SELECT user_id, username, first_name
     FROM bot_users
     WHERE LOWER(username) = LOWER($1)`,
    [username],
  );
  return result.rows[0] ?? null;
}

export async function getNomination(
  nominatedUserId: number,
): Promise<Nomination | null> {
  const result = await getPool().query<Nomination>(
    `SELECT id,
            nominated_user_id,
            nominated_by_user_id,
            group_chat_id,
            confirmed_at,
            website_nomination_id
     FROM nomination_log
     WHERE nominated_user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [nominatedUserId],
  );
  return result.rows[0] ?? null;
}

export async function confirmNomination(input: {
  nominationId: number;
  nominatedUserId: number;
  websiteNominationId: string;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE nomination_log
       SET confirmed_at = COALESCE(confirmed_at, NOW()),
           website_nomination_id = $3
       WHERE id = $1 AND nominated_user_id = $2`,
      [input.nominationId, input.nominatedUserId, input.websiteNominationId],
    );
    if (result.rowCount !== 1) {
      throw new Error("Nomination was not found for this Telegram user");
    }
    const userResult = await client.query(
      `UPDATE bot_users
       SET confirmed_at = COALESCE(confirmed_at, NOW()), updated_at = NOW()
       WHERE user_id = $1`,
      [input.nominatedUserId],
    );
    if (userResult.rowCount !== 1) {
      throw new Error("Telegram user was not registered");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end();
}
