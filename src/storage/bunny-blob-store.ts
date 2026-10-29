import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { StorageRequestError, StorageUnavailableError, validateBlobKey } from "./blob-store.js";
import type { BlobStore } from "./blob-store.js";
import { BUNNY_REGIONS } from "../config/config.module.js";
import type { BunnyConfig } from "../config/config.module.js";

const REQUEST_TIMEOUT_MS = 15_000;

type StorageFetcher = (request: Request) => Promise<Response>;

/**
 * Bunny Storage over its S3-compatible API (path-style, SigV4), signed exactly like the website's
 * lib/bunny-storage.ts: access key = zone name, secret = the zone's read-write password, service "s3",
 * region = the zone's region code. Every request has a timeout and refuses redirects. Network failures,
 * timeouts, 5xx and 429 are StorageUnavailableError; any other refusal is a StorageRequestError that
 * carries only the status. Credentials and signed URLs are never logged or put in an error.
 */
export class BunnyBlobStore implements BlobStore {
  private readonly client: AwsClient;
  private readonly baseUrl: string;
  private readonly prefix: string;

  constructor(
    config: BunnyConfig,
    private readonly fetcher: StorageFetcher = fetch,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(config.zone)) throw new TypeError("Invalid Bunny Storage zone.");
    if (!config.password.trim()) throw new TypeError("Bunny Storage password is required.");
    if (!(BUNNY_REGIONS as readonly string[]).includes(config.region)) throw new TypeError("Invalid Bunny Storage region.");
    if (!/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\/$/.test(config.prefix)) throw new TypeError("Invalid Bunny Storage prefix.");
    this.client = new AwsClient({
      accessKeyId: config.zone,
      secretAccessKey: config.password,
      region: config.region,
      service: "s3",
      retries: 0,
    });
    this.baseUrl = `https://${config.region}-s3.storage.bunnycdn.com/${encodeURIComponent(config.zone)}`;
    this.prefix = config.prefix;
  }

  /** The object URL for a relative key: validated, prefixed, each segment percent-encoded. */
  objectUrl(key: string): string {
    validateBlobKey(key);
    return `${this.baseUrl}/${(this.prefix + key).split("/").map(encodeURIComponent).join("/")}`;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const body = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    body.set(bytes);
    const response = await this.send(key, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "X-Amz-Content-Sha256": createHash("sha256").update(body).digest("hex"),
      },
      body,
    });
    await discard(response);
    if (!response.ok) throw failure(response.status);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const response = await this.send(key, { method: "GET" });
    if (response.status === 404) {
      await discard(response);
      return null;
    }
    if (!response.ok) {
      await discard(response);
      throw failure(response.status);
    }
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new StorageUnavailableError();
    }
  }

  async delete(key: string): Promise<void> {
    const response = await this.send(key, { method: "DELETE" });
    await discard(response);
    if (response.ok || response.status === 404) return;
    throw failure(response.status);
  }

  /** Sign and send one request; any transport failure (network, timeout) is "unavailable". */
  private async send(
    key: string,
    init: { method: string; headers?: Record<string, string>; body?: Uint8Array<ArrayBuffer> },
  ): Promise<Response> {
    const url = this.objectUrl(key); // a bad key is a programming error (TypeError), not "unavailable"
    const request = new Request(url, {
      method: init.method,
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body ? { body: init.body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    try {
      const signed = await this.client.sign(request, { redirect: "error", signal: request.signal });
      return await this.fetcher(signed);
    } catch {
      throw new StorageUnavailableError();
    }
  }
}

function failure(status: number): Error {
  return status >= 500 || status === 429 ? new StorageUnavailableError() : new StorageRequestError(status);
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancelling must not hide the storage result.
  }
}
