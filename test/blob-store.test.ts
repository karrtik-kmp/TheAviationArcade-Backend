import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StorageRequestError, StorageUnavailableError, validateBlobKey } from "../src/storage/blob-store.js";
import { BunnyBlobStore } from "../src/storage/bunny-blob-store.js";
import { MemoryBlobStore } from "../src/storage/memory-blob-store.js";
import { createBlobStore } from "../src/storage/storage.module.js";
import { UnavailableBlobStore } from "../src/storage/unavailable-blob-store.js";

const PASSWORD = "zone-secret-password-123";
const config = { zone: "aviation-arcade-website", password: PASSWORD, region: "de" as const, prefix: "backend/" };

type Seen = { method: string; url: string; headers: Headers; body: Uint8Array };

/** A fetcher that records the signed request and answers with `respond`. No network. */
function stub(respond: (request: Request) => Response | Promise<Response> | never) {
  const seen: Seen[] = [];
  const fetcher = async (request: Request) => {
    seen.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: new Uint8Array(await request.clone().arrayBuffer()),
    });
    return respond(request);
  };
  return { seen, fetcher };
}

describe("validateBlobKey", () => {
  it("accepts relative, content-addressed keys", () => {
    for (const key of ["imports/aircraft-identifier-military/" + "a".repeat(64) + ".xlsx", "setup-checks/abc-123", "a.b/c_d"]) {
      expect(() => validateBlobKey(key), key).not.toThrow();
    }
  });

  it("rejects empty, absolute, traversal, backslash, control and odd-character keys", () => {
    for (const key of ["", "/abs", "a//b", "a/", "../x", "a/../b", "a/./b", ".hidden", "a\\b", "a\u0000b", "a\nb", "a b", "café", "a?b", "x".repeat(513)]) {
      expect(() => validateBlobKey(key), JSON.stringify(key)).toThrow(TypeError);
    }
  });
});

describe("MemoryBlobStore", () => {
  it("stores, returns copies, and deletes idempotently", async () => {
    const store = new MemoryBlobStore("p/");
    const bytes = new Uint8Array([1, 2, 3]);
    await store.put("a/b.bin", bytes, "application/octet-stream");
    bytes[0] = 9; // the caller mutating its buffer must not change what is stored
    expect([...((await store.get("a/b.bin")) ?? [])]).toEqual([1, 2, 3]);
    expect(store.contentTypeOf("a/b.bin")).toBe("application/octet-stream");
    expect(await store.get("missing")).toBeNull();
    await store.delete("a/b.bin");
    await store.delete("a/b.bin");
    expect(store.size).toBe(0);
  });

  it("validates keys", async () => {
    await expect(new MemoryBlobStore().put("../x", new Uint8Array(1), "x/y")).rejects.toThrow(TypeError);
  });
});

describe("UnavailableBlobStore (BLOB_STORE=none)", () => {
  it("fails every call as unavailable", async () => {
    const store = new UnavailableBlobStore();
    await expect(store.put()).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(store.get()).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(store.delete()).rejects.toBeInstanceOf(StorageUnavailableError);
  });
});

describe("createBlobStore", () => {
  it("follows the configured kind", () => {
    expect(createBlobStore({ blobStore: "memory", bunny: undefined })).toBeInstanceOf(MemoryBlobStore);
    expect(createBlobStore({ blobStore: "none", bunny: undefined })).toBeInstanceOf(UnavailableBlobStore);
    expect(createBlobStore({ blobStore: "bunny", bunny: config })).toBeInstanceOf(BunnyBlobStore);
  });
});

describe("BunnyBlobStore (stubbed fetch, no network)", () => {
  it("PUTs path-style under the prefix, SigV4-signed, with the body hash and content type", async () => {
    const { seen, fetcher } = stub(() => new Response(null, { status: 200 }));
    const body = new TextEncoder().encode("xlsx bytes");
    await new BunnyBlobStore(config, fetcher).put("imports/m/abc.xlsx", body, "application/vnd.test");
    const request = seen[0];
    expect(request?.method).toBe("PUT");
    expect(request?.url).toBe("https://de-s3.storage.bunnycdn.com/aviation-arcade-website/backend/imports/m/abc.xlsx");
    expect(request?.headers.get("content-type")).toBe("application/vnd.test");
    expect(request?.headers.get("x-amz-content-sha256")).toBe(createHash("sha256").update(body).digest("hex"));
    const auth = request?.headers.get("authorization") ?? "";
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=aviation-arcade-website\/\d{8}\/de\/s3\/aws4_request, SignedHeaders=.*Signature=[0-9a-f]{64}$/);
    expect(auth).not.toContain(PASSWORD);
    expect(new TextDecoder().decode(request?.body)).toBe("xlsx bytes");
  });

  it("uses the configured region's endpoint", async () => {
    const { seen, fetcher } = stub(() => new Response(null, { status: 200 }));
    await new BunnyBlobStore({ ...config, region: "ny", prefix: "x/y/" }, fetcher).put("k", new Uint8Array(1), "a/b");
    expect(seen[0]?.url).toBe("https://ny-s3.storage.bunnycdn.com/aviation-arcade-website/x/y/k");
  });

  it("GET returns the bytes, 404 is null; DELETE treats 404 as success", async () => {
    const found = stub(() => new Response(new Uint8Array([7, 8]), { status: 200 }));
    expect([...((await new BunnyBlobStore(config, found.fetcher).get("k")) ?? [])]).toEqual([7, 8]);
    const missing = stub(() => new Response(null, { status: 404 }));
    expect(await new BunnyBlobStore(config, missing.fetcher).get("k")).toBeNull();
    await expect(new BunnyBlobStore(config, missing.fetcher).delete("k")).resolves.toBeUndefined();
    expect(missing.seen.map((s) => s.method)).toEqual(["GET", "DELETE"]);
  });

  it("5xx, 429, network errors and timeouts are StorageUnavailableError", async () => {
    for (const status of [500, 502, 503, 429]) {
      const { fetcher } = stub(() => new Response(null, { status }));
      await expect(new BunnyBlobStore(config, fetcher).put("k", new Uint8Array(1), "a/b"), String(status)).rejects.toBeInstanceOf(StorageUnavailableError);
    }
    const down = new BunnyBlobStore(config, async () => {
      throw new TypeError("fetch failed");
    });
    await expect(down.get("k")).rejects.toBeInstanceOf(StorageUnavailableError);
    const hang = new BunnyBlobStore(config, (request) => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason))), 30);
    await expect(hang.delete("k")).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it("other refusals carry only the status and never the credentials", async () => {
    const { fetcher } = stub(() => new Response(`denied ${PASSWORD}`, { status: 403 }));
    const error = await new BunnyBlobStore(config, fetcher).put("k", new Uint8Array(1), "a/b").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageRequestError);
    expect((error as StorageRequestError).status).toBe(403);
    expect(String(error)).not.toContain(PASSWORD);
  });

  it("rejects bad keys before any request, and bad construction", async () => {
    const { seen, fetcher } = stub(() => new Response(null, { status: 200 }));
    const store = new BunnyBlobStore(config, fetcher);
    await expect(store.put("../escape", new Uint8Array(1), "a/b")).rejects.toThrow(TypeError);
    await expect(store.get("a//b")).rejects.toThrow(TypeError);
    expect(seen).toHaveLength(0);
    expect(() => new BunnyBlobStore({ ...config, zone: "Bad_Zone" })).toThrow(TypeError);
    expect(() => new BunnyBlobStore({ ...config, password: "  " })).toThrow(TypeError);
    expect(() => new BunnyBlobStore({ ...config, region: "mars" as never })).toThrow(TypeError);
    expect(() => new BunnyBlobStore({ ...config, prefix: "/abs/" })).toThrow(TypeError);
    expect(() => new BunnyBlobStore({ ...config, prefix: "a/../" })).toThrow(TypeError);
    expect(() => new BunnyBlobStore({ ...config, prefix: "no-trailing-slash" })).toThrow(TypeError);
  });

  it("refuses redirects instead of following them", async () => {
    const { seen, fetcher } = stub(() => new Response(null, { status: 200 }));
    await new BunnyBlobStore(config, fetcher).delete("k");
    expect(seen).toHaveLength(1);
  });
});
