import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Structural guard: PlayerBalance (src/balance) is the only writer of a player's balance and the mirror queue.
// Multiline-aware: the patterns run over the whole file with comments blanked and `;` inside string/template
// literals neutralised, so a `.for("update")` on its own line is caught and a `;` in SQL text does not end a statement.

const ROOT = join(import.meta.dirname, "..");
const BALANCE_DIR = `src${sep}balance${sep}`;

/**
 * Replace comments with spaces. String and template bodies are kept (SQL text is still checked) but their `;` become
 * spaces, so a statement-bounded pattern (`[^;]*?`) cannot stop inside a literal.
 */
export function stripComments(source: string): string {
  const token = /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  return source.replace(token, (match, str: string | undefined) =>
    str ? match.replace(/;/g, " ") : match.replace(/[^\n]/g, " "),
  );
}

/** Drizzle identifier, optionally `schema.`-prefixed. */
const id = (names: string) => String.raw`(?:schema\s*\.\s*)?(?:${names})`;
/**
 * A table position in raw SQL: `name`, `"name"`, `public.name`, `"public"."name"`, or an interpolated
 * `${name}` / `${ schema.name }`.
 */
const rawTable = (snake: string, camel: string) =>
  String.raw`(?:\$\{\s*(?:\w+\s*\.\s*)?${camel}\s*\}|(?:"?\w+"?\s*\.\s*)?"?${snake}"?(?!\w))`;

const PLAYERS = rawTable("players", "players");
const MILES = rawTable("miles_ledger", "milesLedger");
const HINTS = rawTable("hint_ledger", "hintLedger");
const LINKS = rawTable("ugs_links", "ugsLinks");
const PACE = rawTable("ugs_mirror_pace", "ugsMirrorPace");
const TRIPS = rawTable("trips", "trips");
const COUNTERS = rawTable("player_counters", "playerCounters");
const QUEUE = `(?:${rawTable("ugs_mirror_outbox", "ugsMirrorOutbox")}|${rawTable("ugs_mirror_deletions", "ugsMirrorDeletions")})`;
const PROTECTED = id("players|milesLedger|hintLedger|ugsLinks|ugsMirrorOutbox|ugsMirrorDeletions|ugsMirrorPace");
const NOT_BACKTICK = "[^;`]";

const R = (pattern: string, flags = "") => new RegExp(pattern, flags);

export const RULES: { name: string; pattern: RegExp }[] = [
  // .from(players) ... .for(<anything>) within one statement, across any number of lines.
  { name: "locks players FOR UPDATE", pattern: R(String.raw`\.from\(\s*${id("players")}\s*\)[^;]*?\.for\(`) },
  {
    name: "locks players FOR UPDATE (raw SQL)",
    pattern: R(String.raw`\b(?:from|join)\s+${PLAYERS}${NOT_BACKTICK}*?\bfor\s+(?:no\s+key\s+)?update\b`, "i"),
  },
  { name: "calls the mirror queue helpers", pattern: /\b(enqueueMirror|queueMirrorDeletion|cancelMirrorDeletion|dropMirror)\b/ },
  {
    name: "inserts into the mirror queue or a ledger",
    pattern: R(String.raw`\.insert\(\s*${id("ugsMirrorOutbox|ugsMirrorDeletions|milesLedger|hintLedger")}\s*\)`),
  },
  {
    name: "inserts into the mirror queue or a ledger (raw SQL)",
    pattern: R(String.raw`\binsert\s+into\s+(?:${QUEUE}|${MILES}|${HINTS})`, "i"),
  },
  {
    name: "writes players, ugs_links or a ledger directly",
    pattern: R(String.raw`\.(?:insert|update|delete)\(\s*${id("players|milesLedger|hintLedger|ugsLinks")}\s*\)`),
  },
  {
    name: "writes players, ugs_links or a ledger directly (raw SQL)",
    pattern: R(String.raw`\b(?:insert\s+into|update(?:\s+only)?|delete\s+from)\s+(?:${PLAYERS}|${LINKS}|${MILES}|${HINTS})`, "i"),
  },
  {
    // The pace record decides when the next copy write is due. Only PlayerBalance (src/balance) and the mirror worker's
    // success path (PACE_WRITERS) may write it; the enqueue side only reads it.
    name: "writes ugs_mirror_pace",
    pattern: R(String.raw`\.(?:insert|update|delete)\(\s*${id("ugsMirrorPace")}\s*\)|\b(?:insert\s+into|update(?:\s+only)?|delete\s+from)\s+${PACE}`, "i"),
  },
  {
    // Flight Segments and the day/Award counters are part of a player's progress: written only inside
    // PlayerBalance.update's transaction, by the files in TRIP_WRITERS (the structure cannot prove the transaction, the
    // allowlist keeps the writers few and reviewed).
    name: "writes trips or player_counters",
    pattern: R(
      String.raw`\.(?:insert|update|delete)\(\s*${id("trips|playerCounters")}\s*\)|\b(?:insert\s+into|update(?:\s+only)?|delete\s+from)\s+(?:${TRIPS}|${COUNTERS})`,
      "i",
    ),
  },
  // Any string literal naming the private module: static import, dynamic import(), require(); .js/.ts/no extension.
  { name: "imports the private mirror-outbox module", pattern: /["'][^"'\n]*\bmirror-outbox(?:\.[cm]?[jt]s)?["']/ },
  {
    // Outside src/balance a ledger or queue table may only be imported by the READ_ONLY_IMPORTERS files.
    name: "imports a ledger or mirror-queue table",
    pattern: /\bimport\s*(?:type\s*)?\{[^}]*\b(?:milesLedger|hintLedger|ugsMirrorOutbox|ugsMirrorDeletions)\b[^}]*\}/,
  },
  {
    // `const t = players`, `cond ? milesLedger : hintLedger`: a protected table in a variable defeats the checks above.
    name: "assigns a protected table to a variable",
    pattern: R(String.raw`(?<![=!<>])=\s*${PROTECTED}\b(?!\s*[.(\w])|\?\s*${PROTECTED}\s*:|:\s*${PROTECTED}\s*[;)]`),
  },
];

/**
 * Files outside src/balance that may import a ledger or queue table, and why. Reads and the worker's own
 * update/delete of its queue rows are fine; the direct-write rules above still apply to them.
 */
export const READ_ONLY_IMPORTERS: Record<string, string> = {
  "src/ugs/mirror-queue.ts":
    "claims and finishes its own ugs_mirror_outbox / ugs_mirror_deletions rows (update/delete only; inserts are PlayerBalance's). The Postgres MirrorQueue adapters; the worker itself no longer touches the tables",
};

/** Files outside src/balance that may write ugs_mirror_pace, and why. */
export const PACE_WRITERS: Record<string, string> = {
  "src/ugs/mirror-queue.ts": "ProgressWriteQueue records last_mirrored_at after a successful Cloud Save write, only for the current link",
};

/** Files outside src/balance that may write trips or player_counters, and why. */
export const TRIP_WRITERS: Record<string, string> = {
  "src/trips/trips.service.ts": "opens and abandons Flight Segments inside PlayerBalance.update",
  "src/trips/trip-store.ts": "shared segment helpers (close, expire) called from inside PlayerBalance.update",
  "src/rounds/rounds.service.ts": "issues and banks Rounds: segment counters and the day log, inside PlayerBalance.update",
};

const PACE_RULE = "writes ugs_mirror_pace";
const TRIP_RULE = "writes trips or player_counters";
const IMPORT_RULE = "imports a ledger or mirror-queue table";

/** Names of the rules the given source violates. */
export function violations(source: string): string[] {
  const code = stripComments(source);
  return RULES.filter((rule) => rule.pattern.test(code)).map((rule) => rule.name);
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("balance guard: only src/balance writes balances and the mirror queue", () => {
  it("no file outside src/balance violates a rule", () => {
    const found: string[] = [];
    for (const file of filesUnder(join(ROOT, "src"))) {
      const rel = relative(ROOT, file);
      if (rel.startsWith(BALANCE_DIR)) continue;
      const allowed = rel.split(sep).join("/") in READ_ONLY_IMPORTERS;
      for (const name of violations(readFileSync(file, "utf8"))) {
        if (allowed && name === IMPORT_RULE) continue;
        if (rel.split(sep).join("/") in PACE_WRITERS && name === PACE_RULE) continue;
        if (rel.split(sep).join("/") in TRIP_WRITERS && name === TRIP_RULE) continue;
        found.push(`${rel}: ${name}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("the read-only importer allowlist has no stale entries", () => {
    for (const rel of Object.keys(READ_ONLY_IMPORTERS)) {
      expect(violations(readFileSync(join(ROOT, rel), "utf8")), rel).toContain(IMPORT_RULE);
    }
  });

  it("the pace writer allowlist has no stale entries", () => {
    for (const rel of Object.keys(PACE_WRITERS)) {
      expect(violations(readFileSync(join(ROOT, rel), "utf8")), rel).toContain(PACE_RULE);
    }
  });

  it("the trips writer allowlist has no stale entries", () => {
    for (const rel of Object.keys(TRIP_WRITERS)) {
      expect(violations(readFileSync(join(ROOT, rel), "utf8")), rel).toContain(TRIP_RULE);
    }
  });

  it("tests do not import the private mirror-outbox module", () => {
    const found = filesUnder(join(ROOT, "test"))
      .filter((file) => !file.endsWith("balance-guard.test.ts"))
      .filter((file) => violations(readFileSync(file, "utf8")).includes("imports the private mirror-outbox module"))
      .map((file) => relative(ROOT, file));
    expect(found).toEqual([]);
  });

  it("the guard still sees src/balance using what it protects (it is not vacuous)", () => {
    const read = (name: string) => readFileSync(join(ROOT, "src", "balance", name), "utf8");
    expect(violations(read("player-balance.ts"))).toEqual(
      expect.arrayContaining([
        "locks players FOR UPDATE",
        "calls the mirror queue helpers",
        "writes players, ugs_links or a ledger directly",
        "assigns a protected table to a variable",
      ]),
    );
    expect(violations(read("mirror-outbox.ts"))).toContain("inserts into the mirror queue or a ledger");
  });
});

describe("balance guard checker catches seeded violations", () => {
  it("writes to trips and player_counters: drizzle and raw SQL, any quoting", () => {
    for (const seeded of [
      "await tx.insert(trips).values({});",
      "await tx.update(schema.trips).set({}).where(x);",
      "await tx\n  .delete(\n    playerCounters\n  );",
      "await tx.insert(playerCounters).values({});",
      "await tx.execute(sql`UPDATE trips SET status = 'abandoned'`);",
      "await tx.execute(sql`insert into ${trips} (id) values (1)`);",
      'await tx.execute(sql`DELETE FROM "player_counters"`);',
      "await tx.execute(sql`UPDATE public.player_counters SET day_streak = 0`);",
    ]) {
      expect(violations(seeded), seeded).toContain("writes trips or player_counters");
    }
  });

  it("reading trips and player_counters is fine", () => {
    for (const seeded of [
      "await tx.select().from(trips).where(eq(trips.id, id)).for(\"update\");",
      "await tx.select().from(playerCounters);",
      "await tx.execute(sql`SELECT * FROM trips WHERE id = ${id}`);",
      "await tx.update(rounds).set({ tripId: null }).where(eq(rounds.id, id));",
    ]) {
      expect(violations(seeded), seeded).not.toContain("writes trips or player_counters");
    }
  });

  const LOCK = "locks players FOR UPDATE";
  const LOCK_RAW = "locks players FOR UPDATE (raw SQL)";
  const INSERT = "inserts into the mirror queue or a ledger";
  const INSERT_RAW = "inserts into the mirror queue or a ledger (raw SQL)";
  const WRITE = "writes players, ugs_links or a ledger directly";
  const WRITE_RAW = "writes players, ugs_links or a ledger directly (raw SQL)";
  const ALIAS = "assigns a protected table to a variable";
  const MODULE = "imports the private mirror-outbox module";

  it("a multiline .for(\"update\") on its own line", () => {
    const seeded = `
      const [row] = await tx
        .select({ id: players.id })
        .from(players)
        .where(eq(players.id, principal))
        .for("update");`;
    expect(violations(seeded)).toContain(LOCK);
  });

  it("a lock after a multiline chain with inArray and orderBy", () => {
    const seeded = `await tx.select().from(players)\n  .where(inArray(players.id, ids))\n  .orderBy(asc(players.id))\n  .for("update");`;
    expect(violations(seeded)).toContain(LOCK);
  });

  it("a schema-qualified table and a non-literal .for() argument", () => {
    expect(violations('await tx.select().from(schema.players).where(x).for("update");')).toContain(LOCK);
    expect(violations("await tx.select().from(players).where(x).for(mode);")).toContain(LOCK);
    expect(violations("await tx.select().from(players)\n.for(\n  strength,\n);")).toContain(LOCK);
  });

  it("a `;` inside a string or template literal does not hide the lock", () => {
    expect(violations("await tx.select().from(players).where(sql`${players.name} <> ';'`).for(\"update\");")).toContain(LOCK);
    expect(violations("await tx.execute(sql`SELECT * FROM players WHERE name <> ';' FOR UPDATE`);")).toContain(LOCK_RAW);
    expect(violations('await tx.select().from(players).where(eq(players.name, ";")).for("update");')).toContain(LOCK);
  });

  it("raw SQL locks: interpolated, quoted, schema-qualified, any case and whitespace", () => {
    expect(violations("await tx.execute(sql`SELECT * FROM ${players} WHERE id = ${id} FOR UPDATE`);")).toContain(LOCK_RAW);
    expect(violations("await tx.execute(sql`SELECT * FROM ${ schema.players } WHERE id = ${id} FOR UPDATE`);")).toContain(LOCK_RAW);
    expect(violations('await tx.execute(sql`select * from "players" where id = ${id} for update`);')).toContain(LOCK_RAW);
    expect(violations("await tx.execute(sql`SELECT * FROM public.players\n WHERE id = ${x}\n FOR UPDATE`);")).toContain(LOCK_RAW);
    expect(violations('await tx.execute(sql`SELECT * FROM "public"."players" FOR NO KEY UPDATE`);')).toContain(LOCK_RAW);
    expect(violations("await tx.execute(sql`SELECT 1 FROM rounds JOIN players ON true FOR UPDATE`);")).toContain(LOCK_RAW);
  });

  it("raw SQL ledger and queue inserts: interpolated, quoted, qualified", () => {
    expect(violations("await tx.execute(sql`INSERT INTO ${milesLedger} (player_id) VALUES (1)`);")).toContain(INSERT_RAW);
    expect(violations("await tx.execute(sql`insert  into  ${ schema.hintLedger } (x) values (1)`);")).toContain(INSERT_RAW);
    expect(violations('await tx.execute(sql`INSERT INTO "miles_ledger" (x) VALUES (1)`);')).toContain(INSERT_RAW);
    expect(violations("await tx.execute(sql`INSERT INTO public.ugs_mirror_outbox (player_id) VALUES (1)`);")).toContain(INSERT_RAW);
    expect(violations("await tx.execute(sql`INSERT INTO ugs_mirror_outbox (player_id) VALUES (1)`);")).toContain(INSERT_RAW);
    expect(violations("await tx.execute(sql`INSERT INTO ${ugsMirrorDeletions} (x) VALUES (1)`);")).toContain(INSERT_RAW);
  });

  it("drizzle inserts into a ledger or queue table, plain, multiline and schema-prefixed", () => {
    expect(violations("await tx\n  .insert(\n    milesLedger\n  )\n  .values({});")).toContain(INSERT);
    expect(violations("await tx.insert(ugsMirrorDeletions).values({});")).toContain(INSERT);
    expect(violations("await tx.insert(schema.hintLedger).values({});")).toContain(INSERT);
  });

  it("direct .insert/.update/.delete on players, ledgers and ugs_links", () => {
    for (const t of ["players", "milesLedger", "hintLedger", "ugsLinks", "schema.players", "schema.ugsLinks"]) {
      for (const op of ["insert", "update", "delete"]) {
        expect(violations(`await tx.${op}(${t}).where(x);`), `${op} ${t}`).toContain(WRITE);
      }
    }
    expect(violations("await tx\n  .update(\n    players\n  )\n  .set({});")).toContain(WRITE);
  });

  it("direct raw SQL writes to players, ugs_links and the ledgers", () => {
    for (const sqlText of [
      "update players set miles = 0",
      "UPDATE ${players} SET miles = 0",
      'delete from "players" where id = 1',
      "DELETE FROM public.players",
      "insert into ugs_links (a) values (1)",
      "update ${ugsLinks} set x = 1",
      "delete from ugs_links",
      "insert into miles_ledger (a) values (1)",
      "update miles_ledger set delta = 1",
      "delete from ${hintLedger}",
      "update hint_ledger set delta = 1",
      "UPDATE ONLY players SET miles = 1",
    ]) {
      expect(violations("await tx.execute(sql`" + sqlText + "`);"), sqlText).toContain(WRITE_RAW);
    }
  });

  it("allows the mirror worker's own update/delete of the queue tables but not inserts into them", () => {
    expect(violations("await db.update(ugsMirrorOutbox).set({ attempts: 1 }).where(x);")).toEqual([]);
    expect(violations("await db.delete(ugsMirrorDeletions).where(x);")).toEqual([]);
    expect(violations("await db.execute(sql`UPDATE ${sql.identifier(table)} AS t SET claim_id = null`);")).toEqual([]);
    expect(violations("await db.insert(ugsMirrorOutbox).values({});")).toContain(INSERT);
  });

  it("enqueueMirror call and the private module as static, dynamic, require, .js, .ts and extensionless specifiers", () => {
    expect(violations("await enqueueMirror(tx, id, 1, now);")).toContain("calls the mirror queue helpers");
    for (const spec of [
      'import { enqueueMirror } from "../balance/mirror-outbox.js";',
      'import { enqueueMirror } from "../balance/mirror-outbox.ts";',
      'import { enqueueMirror } from "../balance/mirror-outbox";',
      "import { enqueueMirror } from '../balance/mirror-outbox';",
      'const m = await import("../balance/mirror-outbox.js");',
      'const m = await import(\n  "../balance/mirror-outbox"\n);',
      'const m = require("../balance/mirror-outbox");',
      'export * from "./mirror-outbox.js";',
    ]) {
      expect(violations(spec), spec).toContain(MODULE);
    }
  });

  it("importing a ledger or queue table outside src/balance", () => {
    expect(violations('import { milesLedger } from "../db/schema.js";')).toContain(IMPORT_RULE);
    expect(violations('import { players, hintLedger as h } from "../db/schema.js";')).toContain(IMPORT_RULE);
    expect(violations('import type {\n  ugsMirrorOutbox,\n} from "../db/schema.js";')).toContain(IMPORT_RULE);
    expect(violations('import { players, ugsLinks } from "../db/schema.js";')).not.toContain(IMPORT_RULE);
  });

  it("writes to ugs_mirror_pace: drizzle and raw SQL, any quoting", () => {
    for (const seeded of [
      "await db.insert(ugsMirrorPace).values({});",
      "await db.update(schema.ugsMirrorPace).set({}).where(x);",
      "await db\n  .delete(\n    ugsMirrorPace\n  );",
      "await db.execute(sql`INSERT INTO ugs_mirror_pace (player_id) VALUES (1)`);",
      "await db.execute(sql`insert into ${ugsMirrorPace} (a) values (1)`);",
      'await db.execute(sql`UPDATE "ugs_mirror_pace" SET last_mirrored_at = now()`);',
      "await db.execute(sql`DELETE FROM public.ugs_mirror_pace`);",
    ]) {
      expect(violations(seeded), seeded).toContain(PACE_RULE);
    }
    expect(violations("const t = ugsMirrorPace;")).toContain(ALIAS);
  });

  it("reading ugs_mirror_pace is fine", () => {
    expect(violations("await db.select().from(ugsMirrorPace);")).not.toContain(PACE_RULE);
    expect(violations("await db.execute(sql`SELECT 1 FROM ugs_links l JOIN ugs_mirror_pace p ON p.player_id = l.player_id`);")).not.toContain(PACE_RULE);
    expect(violations("await db.execute(sql`UPDATE ugs_mirror_outbox SET urgent = false`);")).not.toContain(PACE_RULE);
  });

  it("assigning a protected table to a variable", () => {
    for (const seeded of [
      "const p = players;",
      "const t = schema.milesLedger;",
      "let l = ugsLinks\n",
      "const t = cond ? milesLedger : hintLedger;",
      "const t = cond ? other : hintLedger;",
      "const t = cond\n  ? milesLedger\n  : other;",
      "const t = cond ? a : (b ? x : players);",
    ]) {
      expect(violations(seeded), seeded).toContain(ALIAS);
    }
    expect(violations("tx.insert(t).values({});")).toEqual([]);
  });

  it("does not flag reads, other tables, a separate later statement, or text in comments", () => {
    expect(violations('await tx.select().from(rounds).where(eq(rounds.id, id)).for("update");')).toEqual([]);
    expect(violations('const a = await db.select().from(players);\nconst b = await tx.select().from(rounds).for("update");')).toEqual([]);
    expect(violations('// enqueueMirror(tx) .from(players).for("update")\n/* insert into miles_ledger */ const x = 1;')).toEqual([]);
    expect(violations("// const p = players; tx.update(players)\nconst x = 1;")).toEqual([]);
    expect(violations("await db.select().from(players).where(eq(players.id, id));")).toEqual([]);
    expect(violations("await tx.execute(sql`SELECT * FROM rounds WHERE id = ${id} FOR UPDATE`);")).toEqual([]);
    expect(violations("await tx.update(rounds).set({ hintUsed: true }).where(eq(rounds.id, id));")).toEqual([]);
    expect(violations("await tx.execute(sql`SELECT * FROM players WHERE id = ${id}`);")).toEqual([]);
    expect(violations("if (a === players) {}\nawait db.select({ player: players, link: ugsLinks.ugsPlayerId });")).toEqual([]);
  });
});
