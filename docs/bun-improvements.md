# Bun API Improvements

Improvements identified from the Bun API docs. Checked items are complete.

## High Impact

- [x] **`Bun.randomUUIDv7()`** — Replace `crypto.randomUUID()` in `shared/types/index.ts`. UUIDv7 is monotonic and time-sortable, improving SQLite B-tree locality for primary keys.
- [x] **SQLite `strict: true`** — Add to `packages/db/src/client.ts`. Throws on missing bind parameters instead of silently binding NULL.
- [x] **`bun build --compile`** — Add `build:exe` and `build:linux` scripts to `package.json` for standalone binary deployment. Faster startup, no `node_modules` needed, supports cross-compile to Linux.

## Medium Impact

- [ ] **`Bun.nanoseconds()`** — Replace `Date.now()` in `app/engine/services/loop.ts` for tick timing. Sub-microsecond precision.
- [ ] **`BUN_CONFIG_VERBOSE_FETCH=curl`** — Add a `debug:fetch` script to `package.json`. Zero code changes, logs all fetch requests curl-style.
- [ ] **`Bun.CryptoHasher`** — Replace `node:crypto` HMAC in `packages/kalshi-client/src/auth.ts` with Bun's native implementation.
- [ ] **`Bun.env` type augmentation** — Declare env var types for autocomplete and stricter typing across the config module.

## Low Impact (Cleanup)

- [ ] **`Bun.sleep()`** — Replace `new Promise(r => setTimeout(r, 500))` with `Bun.sleep(500)` in `app/cli/src/commands/bot.ts`.
- [ ] **`using` statement** — Replace try/finally in `packages/config/src/index.ts` with `using sqlite = new Database(...)` for automatic cleanup.
- [ ] **`"node:fs"` imports** — Convention fix: `from "fs"` → `from "node:fs"` in `packages/db/src/client.ts` and `packages/config/src/index.ts`.
