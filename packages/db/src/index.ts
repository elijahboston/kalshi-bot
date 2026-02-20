export { getDb, type Db } from "./client";
export { runMigrations } from "./migrate";
export * from "./schema";

// Re-export useful drizzle operators for consumers
export { eq, and, or, gte, lte, desc, asc, sql, count, avg, sum } from "drizzle-orm";
