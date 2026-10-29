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
const QUEUE = `(?:${rawTable("ugs_mirror_outbox", "ugsMirrorOutbox")}|${rawTable("ugs_mirror_deletions", "ugsMirrorDeletions")})`;
const PROTECTED = id("players|milesLedger|hintLedger|ugsLinks|ugsMirrorOutbox|ugsMirrorDeletions");
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
  "src/ugs/mirror-worker.ts":
    "claims and finishes its own ugs_mirror_outbox / ugs_mirror_deletions rows (update/delete only; inserts are PlayerBalance's)",
};

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
