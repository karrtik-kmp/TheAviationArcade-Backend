import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0017 (plan docs/plans/media-pipeline.md, T2): the media tables' CHECKs and keys against the real test database,
// written as raw SQL so a drifted constraint fails here whatever the services do. Every test uses its own owner principal and
// the suite deletes only its own rows (media is never deleted by the app).

const SHA = "a".repeat(64);
const OWNER = `firebase:demo-airplane-games:media-schema-${randomUUID()}`;
const OTHER = `firebase:demo-airplane-games:media-schema-${randomUUID()}`;

let pool: pg.Pool;
const itemIds: number[] = [];

beforeAll(() => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
});

afterAll(async () => {
  if (itemIds.length) {
    await pool.query("DELETE FROM media_upload_keys WHERE media_id = ANY($1)", [itemIds]);
    await pool.query("DELETE FROM media_versions WHERE media_id = ANY($1)", [itemIds]);
    await pool.query("DELETE FROM media_items WHERE id = ANY($1)", [itemIds]);
  }
  await pool.query("DELETE FROM account_roles WHERE principal = ANY($1)", [[OWNER, OTHER]]);
  await pool.end();
});

async function item(owner = OWNER, state = "unverified", published: number | null = null, draft = 1): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO media_items (owner, state, draft_version, published_version, created_by, updated_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5, clock_timestamp(), clock_timestamp()) RETURNING id`,
    [owner, state, draft, published, OWNER],
  );
  const id = Number(rows[0]?.id);
  itemIds.push(id);
  return id;
}

interface VersionOverrides {
  version?: number;
  sha256?: string;
  contentType?: string;
  byteSize?: number;
  width?: number;
  height?: number;
  creditName?: string | null;
  creditRequired?: boolean;
  licenceName?: string | null;
  licenceUrl?: string | null;
  sourceUrl?: string | null;
  attribution?: string | null;
  publishedAt?: "now" | null;
}

function version(mediaId: number, o: VersionOverrides = {}): Promise<pg.QueryResult> {
  const has = <K extends keyof VersionOverrides>(k: K, d: VersionOverrides[K]): VersionOverrides[K] => (k in o ? o[k] : d);
  return pool.query(
    `INSERT INTO media_versions (media_id, version, sha256, content_type, byte_size, width, height, credit_name, credit_required,
        licence_name, licence_url, source_url, attribution_text, published_at, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $14::text = 'now' THEN clock_timestamp() END, $15, clock_timestamp())`,
    [
      mediaId,
      o.version ?? 1,
      o.sha256 ?? SHA,
      o.contentType ?? "image/jpeg",
      o.byteSize ?? 1000,
      o.width ?? 800,
      o.height ?? 600,
      has("creditName", "Jane Photographer"),
      o.creditRequired ?? true,
      has("licenceName", "CC BY 4.0"),
      has("licenceUrl", "https://creativecommons.org/licenses/by/4.0/"),
      has("sourceUrl", "https://example.com/photo"),
      has("attribution", null),
      has("publishedAt", null),
      OWNER,
    ],
  );
}

/** The violated constraint's name, or null when the statement succeeded. */
async function violated(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
    return null;
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    return err.constraint ?? err.code ?? "unknown";
  }
}

function key(principal: string, idempotencyKey: string, mediaId: number, o: { operation?: string; sha256?: string; version?: number } = {}) {
  return pool.query(
    `INSERT INTO media_upload_keys (principal, idempotency_key, operation, media_id, version, sha256, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())`,
    [principal, idempotencyKey, o.operation ?? "create", mediaId, o.version ?? 1, o.sha256 ?? SHA],
  );
}

describe("media_items", () => {
  it("accepts a draft and a published item, and rejects the inconsistent ones", async () => {
    expect(await violated(item())).toBeNull();
    expect(await violated(item(OWNER, "published", 2, 2))).toBeNull();
    // A published item keeps its published version when a newer draft is uploaded (user 2026-11-03).
    expect(await violated(item(OWNER, "published", 1, 3))).toBeNull();
    expect(await violated(item(OWNER, "published", null))).toBe("media_items_published_state_check");
    expect(await violated(item(OWNER, "unverified", 1))).toBe("media_items_published_state_check");
    expect(await violated(item(OWNER, "withdrawn", 1))).toBe("media_items_published_state_check");
    expect(await violated(item(OWNER, "published", 3, 2))).toBe("media_items_published_version_check");
    expect(await violated(item(OWNER, "unverified", null, 0))).toBe("media_items_draft_version_check");
    expect(await violated(item(OWNER, "archived"))).toBe("media_items_state_check");
  });

  it("rejects an empty owner and a zero revision, and the revision starts at 1", async () => {
    expect(await violated(item(""))).toBe("media_items_owner_check");
    const id = await item();
    const { rows } = await pool.query<{ revision: number }>("SELECT revision FROM media_items WHERE id = $1", [id]);
    expect(rows[0]?.revision).toBe(1);
    expect(await violated(pool.query("UPDATE media_items SET revision = 0 WHERE id = $1", [id]))).toBe("media_items_revision_check");
  });

  it("generates the id (cannot be supplied) and has no default for the timestamps", async () => {
    const supplied = pool.query(
      `INSERT INTO media_items (id, owner, state, draft_version, created_by, updated_by, created_at, updated_at)
       VALUES (999999999, $1, 'unverified', 1, $1, $1, clock_timestamp(), clock_timestamp())`,
      [OWNER],
    );
    expect(await violated(supplied)).toBe("428C9");
    const noClock = pool.query(
      "INSERT INTO media_items (owner, state, draft_version, created_by, updated_by) VALUES ($1, 'unverified', 1, $1, $1)",
      [OWNER],
    );
    expect(await violated(noClock)).toBe("23502");
  });
});

describe("media_versions", () => {
  it("accepts a complete version and rejects a duplicate (media_id, version)", async () => {
    const id = await item();
    expect(await violated(version(id))).toBeNull();
    expect(await violated(version(id))).toBe("media_versions_pk");
    expect(await violated(version(id, { version: 2 }))).toBeNull();
  });

  it("needs an existing media item", async () => {
    expect(await violated(version(2147483647))).toBe("media_versions_media_id_media_items_id_fk");
  });

  it("rejects a bad sha256", async () => {
    const id = await item();
    for (const bad of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), `${"a".repeat(63)}g`]) {
      expect(await violated(version(id, { sha256: bad })), bad).toBe("media_versions_sha256_check");
    }
  });

  it("rejects an unknown content type, oversize bytes and out-of-range dimensions", async () => {
    const id = await item();
    expect(await violated(version(id, { contentType: "image/gif" }))).toBe("media_versions_content_type_check");
    expect(await violated(version(id, { byteSize: 5242880 }))).toBeNull();
    expect(await violated(version(id, { version: 2, byteSize: 5242881 }))).toBe("media_versions_byte_size_check");
    expect(await violated(version(id, { version: 3, byteSize: 0 }))).toBe("media_versions_byte_size_check");
    expect(await violated(version(id, { version: 4, width: 4096, height: 4096 }))).toBeNull();
    expect(await violated(version(id, { version: 5, width: 4097 }))).toBe("media_versions_width_check");
    expect(await violated(version(id, { version: 6, width: 0 }))).toBe("media_versions_width_check");
    expect(await violated(version(id, { version: 7, height: 4097 }))).toBe("media_versions_height_check");
    expect(await violated(version(id, { version: 8, height: 0 }))).toBe("media_versions_height_check");
    expect(await violated(version(id, { version: 0 }))).toBe("media_versions_version_check");
  });

  it("allows only http(s) licence and source URLs of at most 2048 characters", async () => {
    const id = await item();
    expect(await violated(version(id, { licenceUrl: "ftp://example.com/l" }))).toBe("media_versions_licence_url_check");
    expect(await violated(version(id, { licenceUrl: "javascript:alert(1)" }))).toBe("media_versions_licence_url_check");
    expect(await violated(version(id, { sourceUrl: "example.com/photo" }))).toBe("media_versions_source_url_check");
    expect(await violated(version(id, { sourceUrl: "data:text/html,x" }))).toBe("media_versions_source_url_check");
    const long = `https://example.com/${"a".repeat(2048 - 20)}`;
    expect(long.length).toBe(2048);
    expect(await violated(version(id, { sourceUrl: `${long}a` }))).toBe("media_versions_source_url_check");
    expect(await violated(version(id, { licenceUrl: `${long}a` }))).toBe("media_versions_licence_url_check");
    expect(await violated(version(id, { licenceUrl: long, sourceUrl: "http://example.com/p" }))).toBeNull();
  });

  it("bounds the text fields", async () => {
    const id = await item();
    expect(await violated(version(id, { creditName: "x".repeat(201) }))).toBe("media_versions_credit_name_check");
    expect(await violated(version(id, { creditName: "" }))).toBe("media_versions_credit_name_check");
    expect(await violated(version(id, { licenceName: "x".repeat(201) }))).toBe("media_versions_licence_name_check");
    expect(await violated(version(id, { attribution: "x".repeat(1001) }))).toBe("media_versions_attribution_check");
    expect(await violated(version(id, { creditName: "x".repeat(200), licenceName: "y".repeat(200), attribution: "z".repeat(1000) }))).toBeNull();
  });

  it("refuses to mark a version published without a licence name, or without a credit name when credit is required", async () => {
    const id = await item();
    expect(await violated(version(id, { licenceName: null, publishedAt: "now" }))).toBe("media_versions_publishable_check");
    expect(await violated(version(id, { creditName: null, creditRequired: true, publishedAt: "now" }))).toBe(
      "media_versions_publishable_check",
    );
    // Credit not required: no credit name needed, but the licence name still is.
    expect(await violated(version(id, { version: 2, creditName: null, creditRequired: false, publishedAt: "now" }))).toBeNull();
    expect(await violated(version(id, { version: 3, licenceName: null, creditRequired: false, publishedAt: "now" }))).toBe(
      "media_versions_publishable_check",
    );
    expect(await violated(version(id, { version: 4, publishedAt: "now" }))).toBeNull();
    // A draft (not published) may be incomplete.
    expect(await violated(version(id, { version: 5, licenceName: null, creditName: null }))).toBeNull();
    // Edits after the fact are held to the same rule.
    expect(
      await violated(pool.query("UPDATE media_versions SET licence_name = NULL WHERE media_id = $1 AND version = 4", [id])),
    ).toBe("media_versions_publishable_check");
  });
});

describe("media_upload_keys", () => {
  it("accepts the trip-shaped key and rejects other shapes", async () => {
    const id = await item();
    await version(id);
    expect(await violated(key(OWNER, "ok_key-1", id))).toBeNull();
    expect(await violated(key(OWNER, "a".repeat(128), id))).toBeNull();
    for (const bad of ["", "a".repeat(129), "has space", "slash/key", "dot.key", "ünï"]) {
      expect(await violated(key(OWNER, bad, id)), JSON.stringify(bad)).toBe("media_upload_keys_idempotency_key_check");
    }
  });

  it("rejects a duplicate (principal, key) but allows the same key from two principals", async () => {
    const a = await item(OWNER);
    const b = await item(OTHER);
    await version(a);
    await version(b);
    const shared = `shared-${randomUUID()}`;
    expect(await violated(key(OWNER, shared, a))).toBeNull();
    expect(await violated(key(OWNER, shared, a))).toBe("media_upload_keys_pk");
    expect(await violated(key(OWNER, shared, b))).toBe("media_upload_keys_pk");
    expect(await violated(key(OTHER, shared, b))).toBeNull();
    const { rows } = await pool.query("SELECT media_id FROM media_upload_keys WHERE idempotency_key = $1 ORDER BY media_id", [shared]);
    expect(rows.map((r: { media_id: string }) => Number(r.media_id))).toEqual([a, b]);
  });

  it("claims with ON CONFLICT DO NOTHING RETURNING: the second claim returns no row", async () => {
    const id = await item();
    await version(id);
    const k = `claim-${randomUUID()}`;
    const claim = () =>
      pool.query(
        `INSERT INTO media_upload_keys (principal, idempotency_key, operation, media_id, version, sha256, created_at)
         VALUES ($1, $2, 'create', $3, 1, $4, clock_timestamp()) ON CONFLICT DO NOTHING RETURNING media_id`,
        [OWNER, k, id, SHA],
      );
    expect((await claim()).rowCount).toBe(1);
    expect((await claim()).rowCount).toBe(0);
  });

  it("rejects an unknown operation, a bad sha256, and a key whose version does not exist", async () => {
    const id = await item();
    await version(id);
    expect(await violated(key(OWNER, `op-${randomUUID()}`, id, { operation: "delete" }))).toBe("media_upload_keys_operation_check");
    expect(await violated(key(OWNER, `op-${randomUUID()}`, id, { operation: "version", version: 1 }))).toBeNull();
    expect(await violated(key(OWNER, `sha-${randomUUID()}`, id, { sha256: "xyz" }))).toBe("media_upload_keys_sha256_check");
    expect(await violated(key(OWNER, `ver-${randomUUID()}`, id, { version: 9 }))).toBe("media_upload_keys_version_fk");
    expect(await violated(key("", `p-${randomUUID()}`, id))).toBe("media_upload_keys_principal_check");
  });
});

describe("content_items.media_id", () => {
  it("is nullable, indexed, and refuses an unknown media id", async () => {
    const { rows } = await pool.query<{ is_nullable: string }>(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'content_items' AND column_name = 'media_id'",
    );
    expect(rows[0]?.is_nullable).toBe("YES");
    const idx = await pool.query("SELECT 1 FROM pg_indexes WHERE tablename = 'content_items' AND indexname = 'content_items_media_id'");
    expect(idx.rowCount).toBe(1);
    const fk = await pool.query(
      `SELECT confdeltype FROM pg_constraint WHERE conname = 'content_items_media_id_media_items_id_fk'`,
    );
    expect(fk.rows[0]?.confdeltype).toBe("a"); // NO ACTION: media is never deleted
  });
});

describe("indexes", () => {
  it("has the three listing and lookup indexes", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename IN ('media_items', 'media_versions') ORDER BY 1",
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toEqual(expect.arrayContaining(["media_items_owner_id", "media_items_state_id", "media_versions_sha256"]));
  });
});

describe("account_roles.request_email", () => {
  const insert = (email: string | null) =>
    pool.query(
      `INSERT INTO account_roles (principal, role, state, requested_at, request_email)
       VALUES ($1, 'photographer', 'pending', clock_timestamp(), $2)
       ON CONFLICT (principal, role) DO UPDATE SET request_email = EXCLUDED.request_email`,
      [OWNER, email],
    );

  it("is nullable and bounded to 3-320 characters", async () => {
    expect(await violated(insert(null))).toBeNull();
    expect(await violated(insert("a@b"))).toBeNull();
    expect(await violated(insert("ab"))).toBe("account_roles_request_email_check");
    expect(await violated(insert(""))).toBe("account_roles_request_email_check");
    expect(await violated(insert("x".repeat(320)))).toBeNull();
    expect(await violated(insert("x".repeat(321)))).toBe("account_roles_request_email_check");
  });
});

describe("account_roles R-d checks (migration 0018)", () => {
  const insert = (role: string, state: string, grantEmail: string | null = null, decided = true) =>
    pool.query(
      `INSERT INTO account_roles (principal, role, state, requested_at, decided_at, decided_by, grant_email)
       VALUES ($1, $2, $3, clock_timestamp(), CASE WHEN $4::boolean THEN clock_timestamp() END, CASE WHEN $4::boolean THEN 'test:seed' END, $5)
       ON CONFLICT (principal, role) DO UPDATE SET state = EXCLUDED.state, decided_at = EXCLUDED.decided_at, decided_by = EXCLUDED.decided_by, grant_email = EXCLUDED.grant_email`,
      [OTHER, role, state, decided, grantEmail],
    );

  it("`blocked` is a photographer-only state, and a blocked row still needs decided_at and decided_by", async () => {
    expect(await violated(insert("photographer", "blocked"))).toBeNull();
    expect(await violated(insert("admin", "blocked"))).toBe("account_roles_blocked_role_check");
    expect(await violated(insert("player", "blocked"))).toBe("account_roles_blocked_role_check");
    expect(await violated(insert("photographer", "blocked", null, false))).toBe("account_roles_decided_check");
    expect(await violated(insert("photographer", "approved"))).toBe("account_roles_state_check");
  });

  it("grant_email lives on admin rows only and is bounded to 3-320 characters", async () => {
    expect(await violated(insert("admin", "active", "a@b"))).toBeNull();
    expect(await violated(insert("admin", "active", null))).toBeNull();
    expect(await violated(insert("admin", "active", "x".repeat(320)))).toBeNull();
    expect(await violated(insert("admin", "active", "ab"))).toBe("account_roles_grant_email_check");
    expect(await violated(insert("admin", "active", ""))).toBe("account_roles_grant_email_check");
    expect(await violated(insert("admin", "active", "x".repeat(321)))).toBe("account_roles_grant_email_check");
    expect(await violated(insert("photographer", "active", "a@b.test"))).toBe("account_roles_grant_email_check");
    expect(await violated(insert("player", "active", "a@b.test"))).toBe("account_roles_grant_email_check");
  });

  it("the audit log accepts role_block, role_unblock and role_email_edit", async () => {
    const run = (action: string) =>
      pool.query("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES ($1, $2, 'media-schema-test', '{}'::jsonb, clock_timestamp())", [
        OWNER,
        action,
      ]);
    try {
      for (const a of ["role_block", "role_unblock", "role_email_edit"]) expect(await violated(run(a)), a).toBeNull();
    } finally {
      await pool.query("DELETE FROM admin_audit WHERE target = 'media-schema-test'");
    }
  });

  it("has the partial blocked-queue index", async () => {
    const { rows } = await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'account_roles_blocked_queue'");
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("state = 'blocked'");
  });
});

describe("admin_audit actions", () => {
  it("accepts the six media actions and still refuses an unknown one", async () => {
    const run = (action: string) =>
      pool.query("INSERT INTO admin_audit (actor, action, target, detail, created_at) VALUES ($1, $2, 'media-schema-test', '{}'::jsonb, clock_timestamp())", [
        OWNER,
        action,
      ]);
    try {
      for (const a of ["media_upload", "media_version", "media_edit", "media_publish", "media_withdraw", "content_media_link"]) {
        expect(await violated(run(a)), a).toBeNull();
      }
      expect(await violated(run("media_delete"))).toBe("admin_audit_action_check");
    } finally {
      await pool.query("DELETE FROM admin_audit WHERE target = 'media-schema-test'");
    }
  });
});
