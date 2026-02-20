import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb } from "./client";

export function runMigrations(dbPath?: string) {
  const db = getDb(dbPath);
  migrate(db, { migrationsFolder: new URL("./migrations", import.meta.url).pathname });
  console.log("✓ Migrations applied");
}

// Run directly: bun run packages/db/src/migrate.ts
if (import.meta.main) {
  runMigrations();
}
