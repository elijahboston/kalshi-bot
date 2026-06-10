/**
 * `bun ops` — one CLI for the bot's operational surface: the autonomous
 * follow-ups automation, runtime config knobs, and their audit trail.
 *
 *   bun ops status            automation + bot + regime health at a glance
 *   bun ops due               follow-ups.md items due/overdue today
 *   bun ops knobs             runtime_config with last-change attribution
 *   bun ops history [n]       runtime_config audit trail (default 20 rows)
 *   bun ops set <key> <value> [--why "..."]   change a knob, attributed
 *   bun ops sweep             run the follow-ups sweep now (foreground)
 *   bun ops pause | resume    toggle the .sweep-paused sentinel
 *
 * Why this exists: the daily sweep acts with full autonomy on runtime_config;
 * migration 0006's triggers audit every config write (any writer), and this
 * tool is the human-side window onto that — see docs/follow-ups.md
 * §"Scheduled automation".
 */
import { getDb, runMigrations, runtimeConfig, runtimeConfigLog, sql, desc, eq } from "@kcb/db";
import { now } from "@kcb/shared";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SENTINEL = `${REPO}/.sweep-paused`;
const FOLLOW_UPS = `${REPO}/docs/follow-ups.md`;

// ── follow-ups parsing (exported for tests) ────────────────────────────────

export interface DueItem {
  num: string;
  due: string;
  item: string;
  /** "due" | "overdue" | "recurring" | "conditional" | "upcoming" */
  state: string;
}

/**
 * Parse the follow-ups table. Date rows (YYYY-MM-DD) compare against `today`;
 * "weekly"/"when ..." rows are surfaced as recurring/conditional so the caller
 * can decide. Returns every row, tagged.
 */
export function parseFollowUps(markdown: string, today: string): DueItem[] {
  const items: DueItem[] = [];
  for (const line of markdown.split("\n")) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (!m) continue;
    const [, num, due, item] = m;
    let state: string;
    if (/^\d{4}-\d{2}-\d{2}$/.test(due!)) {
      state = due! < today ? "overdue" : due === today ? "due" : "upcoming";
    } else if (/weekly|daily/i.test(due!)) {
      state = "recurring";
    } else {
      state = "conditional";
    }
    items.push({ num: num!, due: due!, item: item!, state });
  }
  return items;
}

// ── subcommands ────────────────────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  const db = getDb();

  // Automation
  const paused = await Bun.file(SENTINEL).exists();
  let launchd = "not installed";
  try {
    const out = await Bun.$`launchctl list`.quiet();
    if (out.text().includes("com.elijah.kalshi-bot.follow-ups")) launchd = "loaded";
  } catch {
    /* launchctl unavailable (non-macOS/test) */
  }
  let lastSweep = "never";
  const sweepLog = Bun.file(`${REPO}/logs/follow-ups-sweep.log`);
  if (await sweepLog.exists()) {
    const lines = (await sweepLog.text()).trim().split("\n");
    const marker = lines.reverse().find((l) => l.includes("===== follow-ups sweep"));
    if (marker) lastSweep = marker.replace(/=+/g, "").trim();
  }

  // Key knobs
  const rows = (await db.select().from(runtimeConfig)) as Array<{ key: string; value: string }>;
  const knob = (k: string) => rows.find((r) => r.key === k)?.value;

  // Due items
  const today = new Date().toISOString().slice(0, 10);
  const fu = await Bun.file(FOLLOW_UPS).text();
  const due = parseFollowUps(fu, today).filter((i) => i.state === "due" || i.state === "overdue");

  console.log(`Automation`);
  console.log(`  sweep:        ${paused ? "⏸ PAUSED (.sweep-paused)" : "active"} · launchd: ${launchd} · last run: ${lastSweep}`);
  console.log(`  follow-ups:   ${due.length === 0 ? "nothing due today" : due.map((d) => `#${d.num} (${d.due})`).join(", ") + " DUE"}`);
  console.log(`Bot`);
  console.log(`  dry_run:      ${knob("dry_run") ?? "true (default)"}`);
  console.log(`  disabled:     ${knob("disabled_stations") || "none"}`);
  console.log(`  confirmation: ${knob("confirmation_mode_enabled") ?? "false (default)"} · ultra-sniper: ${knob("ultra_sniper_horizon_hours") ?? "0 (dark)"}h`);

  // Recent config changes (the autonomy watchlist)
  const recent = (await db
    .select()
    .from(runtimeConfigLog)
    .orderBy(desc(runtimeConfigLog.id))
    .limit(3)) as Array<{ key: string; oldValue: string | null; newValue: string | null; actor: string | null; changedAt: string }>;
  if (recent.length > 0) {
    console.log(`Recent config changes`);
    for (const r of recent) {
      console.log(`  ${r.changedAt.slice(0, 16)}  ${r.key}: ${r.oldValue ?? "∅"} → ${r.newValue}  (${r.actor ?? "unattributed"})`);
    }
  }
}

async function cmdDue(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const items = parseFollowUps(await Bun.file(FOLLOW_UPS).text(), today);
  const order = ["overdue", "due", "recurring", "conditional", "upcoming"];
  items.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  for (const i of items) {
    const flag =
      i.state === "overdue" ? "⚠ OVERDUE " :
      i.state === "due" ? "● DUE     " :
      i.state === "recurring" ? "↻ recur   " :
      i.state === "conditional" ? "◇ cond    " : "  upcoming";
    console.log(`${flag} #${i.num.padEnd(3)} ${i.due.padEnd(12)} ${i.item}`);
  }
}

async function cmdKnobs(): Promise<void> {
  const db = getDb();
  const rows = (await db.select().from(runtimeConfig).orderBy(runtimeConfig.key)) as Array<{ key: string; value: string; updatedAt: string }>;
  // Last attributed change per key
  const logs = (await db.select().from(runtimeConfigLog).orderBy(desc(runtimeConfigLog.id))) as Array<{ key: string; actor: string | null; note: string | null }>;
  const lastBy = new Map<string, string>();
  for (const l of logs) {
    if (!lastBy.has(l.key)) lastBy.set(l.key, l.actor ? `${l.actor}${l.note ? `: ${l.note}` : ""}` : "unattributed");
  }
  console.log(`${"key".padEnd(36)}${"value".padEnd(28)}${"updated".padEnd(18)}last change by`);
  for (const r of rows) {
    console.log(
      r.key.padEnd(36) +
      r.value.slice(0, 26).padEnd(28) +
      r.updatedAt.slice(0, 16).padEnd(18) +
      (lastBy.get(r.key) ?? "—")
    );
  }
}

async function cmdHistory(limitArg?: string): Promise<void> {
  const db = getDb();
  const limit = Number(limitArg) > 0 ? Number(limitArg) : 20;
  const rows = (await db
    .select()
    .from(runtimeConfigLog)
    .orderBy(desc(runtimeConfigLog.id))
    .limit(limit)) as Array<{ key: string; oldValue: string | null; newValue: string | null; actor: string | null; note: string | null; changedAt: string }>;
  if (rows.length === 0) {
    console.log("No config changes recorded yet (audit began with migration 0006).");
    return;
  }
  for (const r of rows) {
    console.log(
      `${r.changedAt.slice(0, 19)}  ${r.key}: ${r.oldValue ?? "∅"} → ${r.newValue}` +
      `  [${r.actor ?? "unattributed"}${r.note ? ` — ${r.note}` : ""}]`
    );
  }
}

export async function opsSet(key: string, value: string, why?: string, actor = "ops-cli"): Promise<void> {
  const db = getDb();
  await db
    .insert(runtimeConfig)
    .values({ key, value, updatedAt: now() })
    .onConflictDoUpdate({ target: runtimeConfig.key, set: { value, updatedAt: now() } });
  // The 0006 trigger just logged the change (if the value actually changed);
  // annotate that latest row with who/why.
  await db.run(sql`
    UPDATE runtime_config_log
    SET actor = ${actor}, note = ${why ?? null}
    WHERE id = (SELECT MAX(id) FROM runtime_config_log WHERE key = ${key})
      AND actor IS NULL
  `);
}

async function cmdSet(args: string[]): Promise<void> {
  const whyIdx = args.indexOf("--why");
  const why = whyIdx >= 0 ? args[whyIdx + 1] : undefined;
  const positional = whyIdx >= 0 ? args.slice(0, whyIdx) : args;
  const [key, value] = positional;
  if (!key || value === undefined) {
    console.log('Usage: bun ops set <key> <value> [--why "reason"]');
    return;
  }
  if (key === "dry_run" && value !== "true") {
    console.log("⚠ Refusing: going live (dry_run=false) is done by a human in the REPL, deliberately — not via ops tooling.");
    return;
  }
  await opsSet(key, value, why);
  console.log(`${key} = ${value}${why ? `  (${why})` : ""} — audited.`);
  console.log("The running bot re-reads runtime_config every tick (refreshRuntimeConfig), so this applies within ~1–2 min — no restart needed.");
}

async function cmdSweep(): Promise<void> {
  console.log("Running follow-ups sweep in the foreground (this invokes claude -p; may take a few minutes)...");
  await Bun.$`bash ${REPO}/scripts/follow-ups-sweep.sh`;
  console.log(`Done — see logs/follow-ups-sweep.log`);
}

async function cmdPause(): Promise<void> {
  await Bun.write(SENTINEL, `paused ${now()}\n`);
  console.log("Sweep paused (.sweep-paused created). `bun ops resume` to re-enable.");
}

async function cmdResume(): Promise<void> {
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(SENTINEL);
    console.log("Sweep resumed (.sweep-paused removed).");
  } catch {
    console.log("Sweep was not paused.");
  }
}

// ── dispatch ───────────────────────────────────────────────────────────────

const USAGE = `bun ops <status|due|knobs|history [n]|set <key> <value> [--why "..."]|sweep|pause|resume>`;

if (import.meta.main) {
  runMigrations();
  const [cmd, ...rest] = Bun.argv.slice(2);
  switch (cmd) {
    case "status": await cmdStatus(); break;
    case "due": await cmdDue(); break;
    case "knobs": await cmdKnobs(); break;
    case "history": await cmdHistory(rest[0]); break;
    case "set": await cmdSet(rest); break;
    case "sweep": await cmdSweep(); break;
    case "pause": await cmdPause(); break;
    case "resume": await cmdResume(); break;
    default: console.log(USAGE);
  }
}
