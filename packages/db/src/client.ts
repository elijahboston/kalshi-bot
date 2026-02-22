import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";

let _db: ReturnType<typeof createDb> | null = null;

function createDb(dbPath?: string) {
  const path = dbPath || process.env.DB_PATH || "./data/kalshi-bot.db";
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true, strict: true });

  // Performance pragmas for a single-user bot
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA synchronous = NORMAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA busy_timeout = 5000");

  return drizzle(sqlite, { schema });
}

/** Get or create the singleton DB instance */
export function getDb(dbPath?: string) {
  if (!_db) {
    _db = createDb(dbPath);
  }
  return _db;
}

export type Db = ReturnType<typeof getDb>;
