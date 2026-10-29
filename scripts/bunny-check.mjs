// Probe the Bunny Storage connection with the backend's own BunnyBlobStore: upload one random object under
// <prefix>setup-checks/, read it back, compare the bytes, delete it. Like the website's `npm run bunny:check`.
//
// Run `npm run bunny:check` (it builds first). It sends NOTHING unless BUNNY_STORAGE_ZONE and
// BUNNY_STORAGE_PASSWORD are set (in the shell or .env), and never prints the password or a signed URL.
// Use it only with the owner's sign-off: it touches the real zone.
import { randomUUID } from "node:crypto";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: the real environment is the only source.
}

const zone = process.env.BUNNY_STORAGE_ZONE?.trim();
const password = process.env.BUNNY_STORAGE_PASSWORD?.trim();
if (!zone || !password) {
  console.error("Set BUNNY_STORAGE_ZONE and BUNNY_STORAGE_PASSWORD (read-write zone password). No request was sent.");
  process.exit(1);
}

const { BunnyBlobStore } = await import("../dist/storage/bunny-blob-store.js");
let store;
try {
  store = new BunnyBlobStore({
    zone,
    password,
    region: process.env.BUNNY_STORAGE_REGION?.trim() || "de",
    prefix: process.env.BUNNY_STORAGE_PREFIX?.trim() || "backend/",
  });
} catch (error) {
  console.error(`Invalid Bunny settings: ${error instanceof Error ? error.message : "unknown error"} No request was sent.`);
  process.exit(1);
}

const key = `setup-checks/${randomUUID()}`;
const content = new TextEncoder().encode("Airplane Games backend storage connection check.");
let passed = false;
try {
  await store.put(key, content, "application/octet-stream");
  const actual = await store.get(key);
  if (!actual) throw new Error("The uploaded test object was not found.");
  if (actual.length !== content.length || actual.some((byte, index) => byte !== content[index])) {
    throw new Error("The downloaded test object differs from the upload.");
  }
  passed = true;
} catch {
  console.error("Bunny connection check failed. Check the zone, region and read-write zone password; credentials were not printed.");
  process.exitCode = 1;
} finally {
  // The probe object belongs only to this run, including after an ambiguous PUT acknowledgement.
  try {
    await store.delete(key);
  } catch {
    console.error(`Probe cleanup failed. Remove this test object from Bunny manually: ${key}`);
    passed = false;
    process.exitCode = 1;
  }
}
if (passed) console.log("Bunny storage check passed: upload, exact-byte download and deletion.");
