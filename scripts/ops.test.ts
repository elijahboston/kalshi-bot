import { test, expect, describe, beforeEach } from "bun:test";

// DO NOT mock @kcb/db — it leaks globally. Use real in-memory DB instead.
import { runMigrations, getDb, runtimeConfig, runtimeConfigLog, sql } from "@kcb/db";

runMigrations();

import { parseFollowUps, opsSet } from "./ops";

beforeEach(async () => {
  const db = getDb();
  await db.run(sql`DELETE FROM runtime_config_log`);
  await db.run(sql`DELETE FROM runtime_config`);
});

describe("runtime_config audit triggers (migration 0006)", () => {
  test("INSERT is logged with old_value NULL", async () => {
    const db = getDb();
    await db.insert(runtimeConfig).values({ key: "test_knob", value: "1", updatedAt: "2026-06-06T00:00:00Z" });

    const log = await db.select().from(runtimeConfigLog);
    expect(log).toHaveLength(1);
    expect(log[0]!.key).toBe("test_knob");
    expect(log[0]!.oldValue).toBeNull();
    expect(log[0]!.newValue).toBe("1");
    expect(log[0]!.actor).toBeNull(); // trigger can't attribute
    expect(log[0]!.changedAt).toBeTruthy();
  });

  test("UPDATE logs old → new", async () => {
    const db = getDb();
    await db.insert(runtimeConfig).values({ key: "test_knob", value: "1", updatedAt: "2026-06-06T00:00:00Z" });
    await db.run(sql`UPDATE runtime_config SET value = '2' WHERE key = 'test_knob'`);

    const log = await db.select().from(runtimeConfigLog);
    expect(log).toHaveLength(2);
    expect(log[1]!.oldValue).toBe("1");
    expect(log[1]!.newValue).toBe("2");
  });

  test("same-value UPDATE is NOT logged (WHEN guard)", async () => {
    const db = getDb();
    await db.insert(runtimeConfig).values({ key: "test_knob", value: "1", updatedAt: "2026-06-06T00:00:00Z" });
    await db.run(sql`UPDATE runtime_config SET value = '1', updated_at = 'later' WHERE key = 'test_knob'`);

    const log = await db.select().from(runtimeConfigLog);
    expect(log).toHaveLength(1); // only the insert
  });

  test("raw sqlite writers are audited too (no cooperation needed)", async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO runtime_config (key, value, updated_at) VALUES ('raw_knob', 'x', 'ts')`);
    const log = await db.select().from(runtimeConfigLog);
    expect(log).toHaveLength(1);
    expect(log[0]!.key).toBe("raw_knob");
  });
});

describe("opsSet", () => {
  test("upserts and annotates the trigger row with actor + why", async () => {
    const db = getDb();
    await opsSet("ultra_sniper_horizon_hours", "4", "3 clean days of HRRR+obs", "ops-test");

    const log = await db.select().from(runtimeConfigLog);
    expect(log).toHaveLength(1);
    expect(log[0]!.actor).toBe("ops-test");
    expect(log[0]!.note).toBe("3 clean days of HRRR+obs");
    expect(log[0]!.newValue).toBe("4");

    // Update path: annotates only the NEW row, not the old one
    await opsSet("ultra_sniper_horizon_hours", "0", "rollback", "ops-test");
    const log2 = await db.select().from(runtimeConfigLog);
    expect(log2).toHaveLength(2);
    expect(log2[1]!.oldValue).toBe("4");
    expect(log2[1]!.note).toBe("rollback");
    expect(log2[0]!.note).toBe("3 clean days of HRRR+obs"); // untouched
  });

  test("same-value set leaves no unattributed annotation dangling", async () => {
    await opsSet("k", "same", "first", "ops-test");
    await opsSet("k", "same", "second", "ops-test"); // trigger skips; annotate must not clobber
    const db = getDb();
    const log = await db.select().from(runtimeConfigLog);
    expect(log).toHaveLength(1);
    expect(log[0]!.note).toBe("first"); // WHERE actor IS NULL prevented the clobber
  });
});

describe("parseFollowUps", () => {
  const FIXTURE = `
# Follow-ups

| # | Due | Item | Check | Decide |
|---|-----|------|-------|--------|
| 1 | 2026-06-05 | Old thing | x | y |
| 2 | 2026-06-06 | Today thing | x | y |
| 3 | 2026-06-19 | Future thing | x | y |
| 9 | weekly | Gate sweep | x | y |
| 10 | when #4 passes | Expansion | x | y |
`;

  test("tags overdue / due / upcoming / recurring / conditional", () => {
    const items = parseFollowUps(FIXTURE, "2026-06-06");
    expect(items).toHaveLength(5);
    expect(items.find((i) => i.num === "1")!.state).toBe("overdue");
    expect(items.find((i) => i.num === "2")!.state).toBe("due");
    expect(items.find((i) => i.num === "3")!.state).toBe("upcoming");
    expect(items.find((i) => i.num === "9")!.state).toBe("recurring");
    expect(items.find((i) => i.num === "10")!.state).toBe("conditional");
  });

  test("ignores non-table lines and the header separator", () => {
    const items = parseFollowUps("| not | a | follow-up |\nplain text\n", "2026-06-06");
    expect(items).toHaveLength(0);
  });
});
