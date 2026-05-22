/**
 * Test preload — forces every test that imports `@kcb/db` to use an in-memory
 * SQLite database, NOT the production `./data/kalshi-bot.db`.
 *
 * Without this, tests using `runMigrations()` (no path) and `db.delete(table).run()`
 * for cleanup permanently destroy production data. We've already lost ~679k
 * signals and 459 calibration rows that way once. Never again.
 *
 * The DB_PATH env var is consumed by `packages/db/src/client.ts:createDb`, which
 * is called the first time `getDb()` runs — before any test fixture executes.
 */
process.env.DB_PATH = ":memory:";
