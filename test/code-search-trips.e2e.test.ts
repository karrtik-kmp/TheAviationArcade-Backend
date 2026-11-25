import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { APP_CONFIG, loadConfig } from "../src/config/config.module.js";
import { CODE_SEARCH_LADDER } from "../src/rules/code-search-ladder.js";
import { RANK_THRESHOLDS, RANKS } from "../src/rules/ranks.js";
import type { Rank } from "../src/rules/ranks.js";
import { makePuzzle, makeTarget, validatePuzzle } from "../src/rules/word-grid.js";
import { dealsDeck } from "../src/trips/trip-deck.js";
import { clearCodeSearchItems, insertCodeSearchItems, loadSampleRecords, rankOfRecord } from "./code-search-rows.js";
import { emulatorToken } from "./tokens.js";
import { newKey, openBody } from "./trip-helpers.js";

// Code Search on the server (docs/plans/code-search.md, migration 0030): POST /v1/trips deals ten boards from approved content items
// when DEAL_FROM_ITEMS=code-search. Two apps on one test database: switch on and switch off. Rows are inserted directly from the
// client's pack sample (12 boards per rank). This file owns the module's rows while it runs: it clears them before and after.

const PREFIX = "firebase:demo-airplane-games:";
const records = loadSampleRecords();

type Booted = { app: NestExpressApplication; server: ReturnType<NestExpressApplication["getHttpServer"]> };
let on: Booted;
let off: Booted;
let sql: pg.Pool;

async function boot(dealFromItems: string[]): Promise<Booted> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue({ ...loadConfig(process.env), dealFromItems })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  return { app, server: app.getHttpServer() };
}

beforeAll(async () => {
  sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await clearCodeSearchItems(sql);
  if (records) await insertCodeSearchItems(sql, records);
  on = await boot(["code-search"]);
  off = await boot([]);
});

afterAll(async () => {
  await clearCodeSearchItems(sql);
  await sql.end();
  await on.app.close();
  await off.app.close();
});

async function newPlayer(options: { statusPoints?: number; activeRank?: Rank } = {}) {
  const uid = `uid-${randomUUID()}`;
  const auth = { Authorization: `Bearer ${emulatorToken(uid)}` };
  expect((await request(on.server).put("/v1/me").set(auth)).status).toBe(201);
  const principal = `${PREFIX}${uid}`;
  if (options.statusPoints !== undefined || options.activeRank !== undefined) {
    await sql.query("UPDATE players SET status_points = COALESCE($1, status_points), active_rank = COALESCE($2, active_rank) WHERE id = $3", [
      options.statusPoints ?? null,
      options.activeRank ?? null,
      principal,
    ]);
  }
  return { auth, principal };
}

const atRank = (rank: Rank) => newPlayer({ statusPoints: RANK_THRESHOLDS[rank] });
const open = (b: Booted, p: { auth: Record<string, string> }, module: string, key = newKey()) =>
  request(b.server).post("/v1/trips").set(p.auth).set("Idempotency-Key", key).send(openBody(module));
const deckRows = async (tripId: string) => (await sql.query("SELECT format, deck FROM trip_decks WHERE trip_id = $1", [tripId])).rows;

/** A wire board rebuilt as a puzzle: the answer cells are the ones the server sent. */
function puzzleErrors(board: any): string[] {
  const targets = board.targets.map((t: any) => makeTarget(t.airportId, t.code, t.clue, t.cells));
  return validatePuzzle(makePuzzle(board.id, board.width, board.height, board.letters, targets));
}

describe.skipIf(!records)("Code Search Trip open", () => {
  it("fixture sample holds 12 boards at every rank", () => {
    for (const rank of RANKS) expect(records!.filter((r) => rankOfRecord(r) === rank), rank).toHaveLength(12);
  });

  it("switch off (the default): a Code Search Trip opens in client mode, no codeSearchBoards, no deck row", async () => {
    const p = await atRank("trainee");
    const res = await open(off, p, "code-search");
    expect(res.status).toBe(201);
    expect(res.body.trip.module).toBe("code-search");
    expect(res.body).not.toHaveProperty("codeSearchBoards");
    expect(Object.keys(res.body).sort()).toEqual(["progress", "trip"]);
    expect(await deckRows(res.body.trip.tripId)).toEqual([]);
  });

  it("switch on, Trainee: ten distinct Trainee boards in Unity's wire shape, each valid, stored as grid.v1", async () => {
    const p = await atRank("trainee");
    const res = await open(on, p, "code-search");
    expect(res.status).toBe(201);
    const boards = res.body.codeSearchBoards as any[];
    expect(boards).toHaveLength(10);
    expect(new Set(boards.map((b) => b.id)).size).toBe(10);
    const rung = CODE_SEARCH_LADDER.trainee;
    for (const board of boards) {
      expect(board.id).toMatch(/^CS-TR-\d{4}$/);
      // Unity's key order (ApiWireModels.cs CodeSearchBoardWire), not jsonb's.
      expect(Object.keys(board)).toEqual(["id", "width", "height", "letters", "durationSeconds", "clueMode", "targets"]);
      expect(board).toMatchObject({ width: rung.gridSide, height: rung.gridSide, durationSeconds: rung.durationSeconds, clueMode: "Code" });
      expect(board.letters).toHaveLength(rung.gridSide * rung.gridSide);
      expect(board.targets).toHaveLength(rung.targetCount);
      for (const target of board.targets) {
        expect(Object.keys(target)).toEqual(["airportId", "code", "clue", "cityClue", "cells"]);
        expect(target.cells).toHaveLength(target.code.length);
        for (const cell of target.cells) expect(Object.keys(cell)).toEqual(["row", "column"]);
      }
      expect(puzzleErrors(board), board.id).toEqual([]);
    }
    const rows = await deckRows(res.body.trip.tripId);
    expect(rows).toHaveLength(1);
    expect(rows[0].format).toBe("grid.v1");
    expect(rows[0].deck.map((e: any) => ({ itemId: e.itemId, itemVersion: e.itemVersion }))).toEqual(boards.map((b) => ({ itemId: b.id, itemVersion: 1 })));
    expect(rows[0].deck.map((e: any) => e.board.id)).toEqual(boards.map((b) => b.id));
  });

  it("every rank deals its own ten boards with its rung's clock, clue mode and target count", async () => {
    const prefixes: Record<Rank, string> = { trainee: "TR", "first-officer": "FO", captain: "CA", "check-airman": "CH", "chief-pilot": "CP" };
    const modes: Record<Rank, string> = { trainee: "Code", "first-officer": "Mixed", captain: "Mixed", "check-airman": "City", "chief-pilot": "City" };
    for (const rank of RANKS) {
      const res = await open(on, await atRank(rank), "code-search");
      expect(res.body.trip.rank).toBe(rank);
      const boards = res.body.codeSearchBoards as any[];
      expect(boards, rank).toHaveLength(10);
      for (const b of boards) {
        expect(b.id).toMatch(new RegExp(`^CS-${prefixes[rank]}-`));
        expect(b.durationSeconds).toBe(CODE_SEARCH_LADDER[rank].durationSeconds);
        expect(b.targets).toHaveLength(CODE_SEARCH_LADDER[rank].targetCount);
        expect(b.targets.filter((t: any) => t.cityClue)).toHaveLength(CODE_SEARCH_LADDER[rank].cityClues);
        expect(puzzleErrors(b), b.id).toEqual([]);
      }
      expect(new Set(boards.map((b) => b.clueMode))).toEqual(new Set([modes[rank]]));
    }
  });

  it("replay with the same Idempotency-Key answers 200 with deeply equal boards, in the same order and key order, and draws nothing new", async () => {
    const p = await atRank("trainee");
    const key = newKey();
    const first = await open(on, p, "code-search", key);
    const again = await open(on, p, "code-search", key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.codeSearchBoards).toEqual(first.body.codeSearchBoards);
    expect(JSON.stringify(again.body.codeSearchBoards)).toBe(JSON.stringify(first.body.codeSearchBoards));
    expect(await deckRows(first.body.trip.tripId)).toHaveLength(1);
    // The replay also answers when the switch is off: it reads the stored deck, not the config.
    const offReplay = await open(off, p, "code-search", key);
    expect(offReplay.status).toBe(200);
    expect(offReplay.body.codeSearchBoards).toEqual(first.body.codeSearchBoards);
  });

  it("two Trips of the same rank draw independently (the seed is the Trip id)", async () => {
    const a = await open(on, await atRank("captain"), "code-search");
    const b = await open(on, await atRank("captain"), "code-search");
    expect(a.body.codeSearchBoards.map((x: any) => x.id)).not.toEqual(b.body.codeSearchBoards.map((x: any) => x.id));
  });

  it("a board retired or edited after the open does not change the stored deck on replay", async () => {
    const p = await atRank("first-officer");
    const key = newKey();
    const first = await open(on, p, "code-search", key);
    const dealt = first.body.codeSearchBoards as any[];
    const victim = dealt[0].id as string;
    try {
      await sql.query("UPDATE content_items SET status = 'retired', version = version + 1 WHERE module = 'code-search' AND id = $1", [victim]);
      await sql.query("UPDATE content_items SET data = jsonb_set(data, '{letters}', '\"X\"') WHERE module = 'code-search' AND id = $1", [dealt[1].id]);
      const again = await open(on, p, "code-search", key);
      expect(again.status).toBe(200);
      expect(again.body.codeSearchBoards).toEqual(dealt);
    } finally {
      await sql.query("DELETE FROM content_items WHERE module = 'code-search'");
      await insertCodeSearchItems(sql, records!);
    }
  });

  it("Pleasure Cruise: the deck is dealt at the Trip's Active Rank, not the Certified Rank", async () => {
    const p = await newPlayer({ statusPoints: RANK_THRESHOLDS.captain, activeRank: "trainee" });
    const res = await open(on, p, "code-search");
    expect(res.body.trip).toMatchObject({ rank: "trainee", pleasureCruise: true });
    expect((res.body.codeSearchBoards as any[]).every((b) => /^CS-TR-/.test(b.id))).toBe(true);
  });

  it("fewer than ten dealable boards at the rank: client mode, no boards, no deck row; other ranks still deal", async () => {
    try {
      const chief = records!.filter((r) => rankOfRecord(r) === "chief-pilot").slice(0, 3).map((r) => r.id);
      await sql.query("UPDATE content_items SET status = 'retired' WHERE module = 'code-search' AND id = ANY($1)", [chief]);
      const short = await open(on, await atRank("chief-pilot"), "code-search");
      expect(short.status).toBe(201);
      expect(short.body).not.toHaveProperty("codeSearchBoards");
      expect(await deckRows(short.body.trip.tripId)).toEqual([]);
      const fine = await open(on, await atRank("trainee"), "code-search");
      expect(fine.body.codeSearchBoards).toHaveLength(10);
    } finally {
      await sql.query("DELETE FROM content_items WHERE module = 'code-search'");
      await insertCodeSearchItems(sql, records!);
    }
  });

  it("a stored board that misfits its rank is not dealt (a rank-only edit leaves a pool short of ten)", async () => {
    try {
      const id = records!.find((r) => rankOfRecord(r) === "trainee")!.id;
      await sql.query("UPDATE content_items SET rank = 'captain', version = version + 1 WHERE module = 'code-search' AND id = $1", [id]);
      // 11 Trainee rows remain: still deals, and never the moved board.
      const trainee = await open(on, await atRank("trainee"), "code-search");
      expect((trainee.body.codeSearchBoards as any[]).map((b) => b.id)).not.toContain(id);
      // 13 Captain rows, one of which does not fit the rung (an id prefix of another rank): never dealt.
      for (let i = 0; i < 4; i++) {
        const captain = await open(on, await atRank("captain"), "code-search");
        expect((captain.body.codeSearchBoards as any[]).map((b) => b.id)).not.toContain(id);
      }
    } finally {
      await sql.query("DELETE FROM content_items WHERE module = 'code-search'");
      await insertCodeSearchItems(sql, records!);
    }
  });

  it("other modules never carry codeSearchBoards or a deck, with the switch on", async () => {
    for (const module of ["identifier", "aircraft-identifier-military", "atc-match", "airport-spotter"]) {
      const res = await open(on, await atRank("trainee"), module);
      expect(res.status, module).toBe(201);
      expect(res.body, module).not.toHaveProperty("codeSearchBoards");
      expect(await deckRows(res.body.trip.tripId), module).toEqual([]);
    }
    expect(dealsDeck("identifier", ["code-search"])).toBe(false);
    expect(dealsDeck("aircraft-identifier-military", ["code-search"])).toBe(false);
    expect(dealsDeck("code-search", [])).toBe(false);
    expect(dealsDeck("code-search", ["code-search"])).toBe(true);
  });

  it("complete, abandon and the next open leave the stored deck alone and carry no boards", async () => {
    const p = await atRank("trainee");
    const first = await open(on, p, "code-search");
    const tripId = first.body.trip.tripId as string;
    const abandoned = await request(on.server).post(`/v1/trips/${tripId}/abandon`).set(p.auth);
    expect(abandoned.status).toBe(200);
    expect(abandoned.body).not.toHaveProperty("codeSearchBoards");
    expect(await deckRows(tripId)).toHaveLength(1);
    const next = await open(on, p, "code-search");
    expect(next.body.trip.tripId).not.toBe(tripId);
    expect(await deckRows(tripId)).toHaveLength(1);
    expect(await deckRows(next.body.trip.tripId)).toHaveLength(1);
  });
});
