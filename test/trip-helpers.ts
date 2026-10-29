import { randomUUID } from "node:crypto";
import pg from "pg";
import request from "supertest";

/**
 * Test helpers for the Flight Segment (Trip) flow. Since slice T2 every Round belongs to an open segment, so tests that
 * only want "a Round" open one first. The segment is kept per player and module (keyed by the Authorization header), so
 * several Rounds of one test share a segment, as the app does, and the Perfect Streak accumulates across them.
 */

/** The UTC calendar date of now (the tests open segments at offset 0). */
export function utcToday(plusMinutes = 0): string {
  return new Date(Date.now() + plusMinutes * 60_000).toISOString().slice(0, 10);
}

/** A valid POST /v1/trips body. */
export function openBody(module = "atc-match", overrides: Record<string, unknown> = {}) {
  return {
    module,
    flightCount: 10,
    localDate: utcToday(),
    utcOffsetMinutes: 0,
    contentVersion: "test-pack-1",
    ...overrides,
  };
}

/** Flight facts that pass the module rules: Identifier needs a seeded commercial family, the other modules null. */
export function factsFor(module = "atc-match", overrides: Record<string, unknown> = {}) {
  return {
    aircraftKey: module === "identifier" ? "787" : module === "aircraft-identifier-military" ? "mil-a1" : null,
    answerMs: 1500,
    attempts: 1,
    ...overrides,
  };
}

/** A well-formed content item for the Military module (ids mil-aN), so a Military Round can name it. */
export async function ensureMilitaryItem(sql: pg.Pool, id = "mil-a1", answer = "Aircraft 1") {
  await sql.query(
    `INSERT INTO content_items (module, id, rank, status, source, data, version, created_at, updated_at, updated_by)
     VALUES ('aircraft-identifier-military', $1, 'trainee', 'approved', 'client_sheet', $2::jsonb, 1, now(), now(), 'test')
     ON CONFLICT DO NOTHING`,
    [id, JSON.stringify({ answer, wrong: ["a", "b", "c"], sourceFile: `${id}.jpg`, photographer: "T" })],
  );
}

let freshKey = 0;
export const newKey = () => `key-${randomUUID()}-${freshKey++}`;

const segments = new Map<string, { id: string; module: string }>();

/**
 * The player's current segment for `module`: the one remembered from an earlier call when it is for the same module,
 * otherwise a newly opened one (which abandons the previous segment, as the app does when it picks another module).
 */
export async function ensureTrip(
  server: Parameters<typeof request>[0],
  auth: Record<string, string>,
  module = "atc-match",
): Promise<string> {
  const cacheKey = auth["Authorization"] ?? "";
  const known = segments.get(cacheKey);
  if (known && known.module === module) return known.id;
  const opened = await request(server)
    .post("/v1/trips")
    .set(auth)
    .set("Idempotency-Key", newKey())
    .send(openBody(module));
  if (opened.status !== 201) throw new Error(`could not open a segment: ${opened.status} ${JSON.stringify(opened.body)}`);
  const id = opened.body.trip.tripId as string;
  segments.set(cacheKey, { id, module });
  return id;
}

/** Forget the remembered segment (a test that closed or replaced it by hand). */
export function forgetTrip(auth: Record<string, string>) {
  segments.delete(auth["Authorization"] ?? "");
}

/** Issue the next Round of the player's segment for `module` (opening one if needed). Returns the supertest response. */
export async function issueRound(
  server: Parameters<typeof request>[0],
  auth: Record<string, string>,
  module = "atc-match",
) {
  const tripId = await ensureTrip(server, auth, module);
  return request(server).post("/v1/rounds").set(auth).send({ tripId });
}
