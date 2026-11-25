import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { APP_CONFIG, loadConfig } from "../src/config/config.module.js";
import { exitCodeOf, runCodeSearchSeed } from "../src/content/code-search-seed.js";
import type { CodeSearchPack } from "../src/content/code-search-seed.js";
import { DatabaseService } from "../src/database/database.module.js";
import { CODE_SEARCH_ID_PREFIX } from "../src/content/grid-boards.js";
import { CODE_SEARCH_LADDER } from "../src/rules/code-search-ladder.js";
import { RANK_THRESHOLDS, RANKS } from "../src/rules/ranks.js";
import { makePuzzle, makeTarget, validatePuzzle } from "../src/rules/word-grid.js";
import { MemoryBlobStore } from "../src/storage/memory-blob-store.js";
import { frozenDelete } from "./frozen-cleanup.js";
import { emulatorToken } from "./tokens.js";
import { newKey, openBody } from "./trip-helpers.js";

// The whole path end to end (docs/plans/code-search.md): the seed core imports the client's sample boards through ContentService,
// then a Code Search Trip open with DEAL_FROM_ITEMS=code-search deals ten of them at the player's rank, in Unity's wire shape.

const PREFIX = "firebase:demo-airplane-games:";
const sample = JSON.parse(readFileSync(new URL("./fixtures/code-search-sample.json", import.meta.url), "utf8")) as CodeSearchPack;

let sql: pg.Pool;
let app: NestExpressApplication;
let server: ReturnType<NestExpressApplication["getHttpServer"]>;

async function clean(): Promise<void> {
  await sql.query("DELETE FROM content_items WHERE module = 'code-search'");
  await sql.query("DELETE FROM content_imports WHERE module = 'code-search'");
  await frozenDelete(sql, "admin_audit");
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  await clean();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue({ ...loadConfig(process.env), dealFromItems: ["code-search"] })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  server = app.getHttpServer();
});

afterAll(async () => {
  await clean();
  await app.close();
  await sql.end();
});

describe("seed, then deal", () => {
  it("the seeded sample deals ten valid boards of the player's rank at every rank", async () => {
    const report = await runCodeSearchSeed(sample, "apply", {
      database: new DatabaseService(sql),
      blobs: new MemoryBlobStore(),
      operator: "tester",
      pool: sql,
    });
    expect(exitCodeOf(report)).toBe(0);

    for (const rank of RANKS) {
      const uid = `uid-${randomUUID()}`;
      const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
      expect((await request(server).put("/v1/me").set(auth)).status).toBe(201);
      await sql.query("UPDATE players SET status_points = $1 WHERE id = $2", [RANK_THRESHOLDS[rank], `${PREFIX}${uid}`]);

      const res = await request(server).post("/v1/trips").set(auth).set("Idempotency-Key", newKey()).send(openBody("code-search"));
      expect(res.status, rank).toBe(201);
      expect(res.body.trip.rank).toBe(rank);
      const boards = res.body.codeSearchBoards as { id: string; width: number; height: number; letters: string; durationSeconds: number; targets: { airportId: string; code: string; clue: string; cells: { row: number; column: number }[] }[] }[];
      expect(boards, rank).toHaveLength(10);
      expect(new Set(boards.map((b) => b.id)).size).toBe(10);
      const rung = CODE_SEARCH_LADDER[rank];
      for (const board of boards) {
        expect(CODE_SEARCH_ID_PREFIX[board.id.slice(3, 5)], board.id).toBe(rank);
        expect(board).toMatchObject({ width: rung.gridSide, height: rung.gridSide, durationSeconds: rung.durationSeconds });
        const targets = board.targets.map((t) => makeTarget(t.airportId, t.code, t.clue, t.cells));
        expect(validatePuzzle(makePuzzle(board.id, board.width, board.height, board.letters, targets), rung.directions), board.id).toEqual([]);
      }
    }
  });
});
