// Smoke check of the real UGS setup with the backend's own UgsClient and verifyUgsToken. It settles the two UNVERIFIED items
// in docs/ARCHITECTURE.md (the token claims; externalId = Firebase uid and providerId = UGS_OIDC_PROVIDER), then proves a
// progress copy reaches Cloud Save after a banked Round.
//
// Run `npm run ugs:check` (it builds first): that only checks the settings and prints the plan, and sends NOTHING.
// `npm run ugs:check -- --live` contacts UGS. Use it only with the owner's sign-off: it writes a real copy, it can create a
// UGS player, and it banks one real Round for that Firebase user in this backend's database.
//
// --live needs: every UGS_* setting; the backend running with those same settings and FIREBASE_PROJECT_ID set to the real
// project; a test user's Firebase ID token in the file UGS_CHECK_FIREBASE_TOKEN_FILE. Optional: UGS_CHECK_UGS_TOKEN_FILE, a
// UGS token from a real game sign-in (otherwise the Firebase token is exchanged here); UGS_CHECK_ENV_NAME, the name of the
// UGS environment (default development; UnityEnvironment takes the name, not the id); UGS_CHECK_BASE_URL (default
// http://localhost:<PORT>). Keep the token files outside the repo. Tokens, the secret and claim values are never printed.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: the real environment is the only source.
}

const env = (name) => process.env[name]?.trim() || undefined;
const live = process.argv.includes("--live");

const required = ["UGS_PROJECT_ID", "UGS_ENVIRONMENT_ID", "UGS_SERVICE_ACCOUNT_KEY_ID", "UGS_SERVICE_ACCOUNT_SECRET", "UGS_OIDC_PROVIDER"];
const missing = required.filter((name) => !env(name));
if (live && !env("UGS_CHECK_FIREBASE_TOKEN_FILE")) missing.push("UGS_CHECK_FIREBASE_TOKEN_FILE");
if (missing.length > 0) {
  console.error(`Set ${missing.join(", ")}. No request was sent.`);
  process.exit(1);
}

const projectId = env("UGS_PROJECT_ID");
const environmentId = env("UGS_ENVIRONMENT_ID");
const provider = env("UGS_OIDC_PROVIDER");
const environmentName = env("UGS_CHECK_ENV_NAME") ?? "development";
const baseUrl = (env("UGS_CHECK_BASE_URL") ?? `http://localhost:${env("PORT") ?? 3000}`).replace(/\/+$/, "");
const minIntervalSec = Number(env("UGS_MIRROR_MIN_INTERVAL_SEC") ?? 300);

if (!live) {
  console.log(`Settings are complete. Provider ${provider}, UGS environment "${environmentName}", backend ${baseUrl}. No request was sent.`);
  console.log("--live would: get a UGS token, verify it and report its claim names, read the external ids, link through the");
  console.log("backend, wait for the copy in Cloud Save, bank one Round, wait for the copy to catch up, abandon the Trip.");
  console.log("Run it only with the owner's sign-off.");
  process.exit(0);
}

const results = [];
function report(name, passed, detail = "") {
  results.push(passed);
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
}
function stop(message) {
  console.error(`Stopped: ${message}`);
  process.exit(1);
}
function readToken(name) {
  try {
    return readFileSync(env(name), "utf8").trim();
  } catch {
    stop(`could not read the file named by ${name}.`);
  }
}
function claimsOf(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    stop("a token is not a JWT.");
  }
}

const firebaseToken = readToken("UGS_CHECK_FIREBASE_TOKEN_FILE");
const uid = claimsOf(firebaseToken).sub;

// 1. A UGS token: from a real game sign-in when given, else exchanged here (this also proves the OIDC provider accepts Firebase).
let ugsToken;
if (env("UGS_CHECK_UGS_TOKEN_FILE")) {
  ugsToken = readToken("UGS_CHECK_UGS_TOKEN_FILE");
} else {
  const res = await fetch(`https://player-auth.services.api.unity.com/v1/authentication/external-token/${encodeURIComponent(provider)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ProjectId: projectId, UnityEnvironment: environmentName },
    body: JSON.stringify({ token: firebaseToken, signInOnly: false }),
    signal: AbortSignal.timeout(15_000),
  });
  report(`Firebase token accepted by ${provider}`, res.ok, `HTTP ${res.status}`);
  if (!res.ok) stop("the provider id, its issuer or client id, or the environment name is wrong.");
  ugsToken = (await res.json()).idToken;
}

// 2. UNVERIFIED item 1: the token claims.
const { UgsClient } = await import("../dist/ugs/ugs-client.js");
const { verifyUgsToken } = await import("../dist/ugs/ugs-token.js");
let ugsPlayerId;
try {
  ({ ugsPlayerId } = await verifyUgsToken(ugsToken, { projectId, environmentId }));
  report("UGS token passes verifyUgsToken", true);
} catch (error) {
  report("UGS token passes verifyUgsToken", false, error instanceof Error ? error.message : "unknown error");
  stop("PUT /v1/me/ugs-link would reject this token; fix the claim handling before going on.");
}
const claims = claimsOf(ugsToken);
console.log(`      claim names: ${Object.keys(claims).sort().join(", ")}`);
for (const name of ["project_id", "upid"]) {
  console.log(`      ${name}: ${name in claims ? (claims[name] === projectId ? "present, equals UGS_PROJECT_ID" : "present, DIFFERENT") : "absent"}`);
}
console.log(`      envId: ${"envId" in claims ? (claims.envId === environmentId ? "present, equals UGS_ENVIRONMENT_ID" : "present, DIFFERENT") : "absent (not checked by the code)"}`);
console.log(`      idd: ${"idd" in claims ? "present" : "absent"}`);

// 3. UNVERIFIED item 2: externalId and providerId. Also proves the Player Auth admin API is enabled and the role holds player_auth.users.get.
const client = new UgsClient(
  { projectId, environmentId, serviceAccountKeyId: env("UGS_SERVICE_ACCOUNT_KEY_ID"), serviceAccountSecret: env("UGS_SERVICE_ACCOUNT_SECRET") },
  (url, init) => fetch(url, init),
);
const identity = await client.getExternalIds(ugsPlayerId);
report("Player Auth admin answers", identity.kind === "ok", identity.kind === "ok" ? "" : `${identity.kind} ${identity.status ?? ""}`);
if (identity.kind !== "ok") stop("401/403 means the API is not enabled or the service account lacks player_auth.users.get.");
const providers = [...new Set(identity.externalIds.map((entry) => entry.providerId))];
console.log(`      providerIds on this player: ${providers.join(", ") || "none"}`);
report(`providerId equals ${provider}`, providers.includes(provider));
report(
  "externalId equals the Firebase uid",
  identity.externalIds.some((entry) => entry.providerId === provider && entry.externalId === uid),
);

// 4. The backend side: sign in, link, and the copy in Cloud Save.
const clientBuild = env("MIN_CLIENT_BUILD");
async function backend(method, path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${firebaseToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(clientBuild ? { "X-Client-Version": clientBuild } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // The status is enough.
  }
  return { status: res.status, ok: res.ok, code: json?.error?.code, body: json };
}
function require2xx(name, res) {
  report(name, res.ok, `HTTP ${res.status}${res.code ? ` ${res.code}` : ""}`);
  if (!res.ok) stop(`${name} failed. Is the backend running at ${baseUrl} with the real FIREBASE_PROJECT_ID and the same UGS_* settings?`);
  return res.body;
}

async function readCopy() {
  const url = `https://services.api.unity.com/cloud-save/v1/data/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(environmentId)}/players/${encodeURIComponent(ugsPlayerId)}/protected/items?keys=progress`;
  const credentials = Buffer.from(`${env("UGS_SERVICE_ACCOUNT_KEY_ID")}:${env("UGS_SERVICE_ACCOUNT_SECRET")}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${credentials}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) stop(`Cloud Save read answered HTTP ${res.status}. 401/403 means the role lacks cloud_save.data.read.`);
  const body = await res.json();
  return body.results?.find((item) => item.key === "progress")?.value ?? null;
}
async function waitForCopy(name, version, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let copy = null;
  while (Date.now() < deadline) {
    copy = await readCopy();
    if (copy !== null && copy.version >= version) break;
    await sleep(5_000);
  }
  const caughtUp = copy !== null && copy.version >= version;
  report(name, caughtUp, copy === null ? "no copy found" : `copy version ${copy.version}, wanted at least ${version}`);
  if (caughtUp) {
    report("copy has schemaVersion 3", copy.schemaVersion === 3);
    report("copy names this owner", copy.uid === uid);
    report("copy has evaluatedAt", typeof copy.evaluatedAt === "string");
  }
  return caughtUp;
}

const signedIn = require2xx("PUT /v1/me", await backend("PUT", "/v1/me", {}));
require2xx("PUT /v1/me/ugs-link", await backend("PUT", "/v1/me/ugs-link", { ugsToken }));
const copied = await waitForCopy("copy in Cloud Save after the link", signedIn.progress.version, 120_000);

// 5. A banked Round reaches the copy. atc-match takes no aircraft key; the wait clears the 3 s minimum Round time.
if (copied) {
  const now = new Date();
  const localDate = now.toISOString().slice(0, 10);
  const opened = require2xx(
    "POST /v1/trips",
    await backend(
      "POST",
      "/v1/trips",
      { module: "atc-match", flightCount: 10, localDate, utcOffsetMinutes: 0, contentVersion: "ugs-check" },
      { "Idempotency-Key": randomUUID() },
    ),
  );
  const { tripId } = opened.trip;
  try {
    const issued = require2xx("POST /v1/rounds", await backend("POST", "/v1/rounds", { tripId }));
    await sleep(3_500);
    const banked = require2xx(
      "POST /v1/rounds/:id/result",
      await backend("POST", `/v1/rounds/${issued.round.roundId}/result`, {
        finished: true,
        errorCount: 0,
        usedHint: false,
        timeRemainingFraction: 0.5,
        aircraftKey: null,
        answerMs: 3000,
        attempts: 1,
      }),
    );
    // The copy can wait out the per-player interval, then a worker tick.
    await waitForCopy("copy in Cloud Save after a banked Round", banked.progress.version, (minIntervalSec + 120) * 1000);
  } finally {
    await backend("POST", `/v1/trips/${tripId}/abandon`);
  }
}

const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} checks passed.`);
if (passed !== results.length) process.exitCode = 1;
