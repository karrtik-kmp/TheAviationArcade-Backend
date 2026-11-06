import { readFileSync } from "node:fs";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/purchases/stores-check.js";
import { DEMO_PRODUCTS } from "../src/store/demo-products.js";

const PACKAGE = "com.airplane.games";
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ACCESS_TOKEN = "ya29.access-token-that-must-never-be-printed-0123456789";
const REAL_PROJECT = "airplane-games-auth-20261022";
const NOT_ROOT = { uid: 1000 };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const googleError = (status: number, reason: string, message = "x") => json(status, { error: { code: status, message, errors: [{ reason }] } });

type Call = { url: string; method: string; body: string | undefined };

/** Every request any scenario made. The afterEach below asserts the check stays read-only in all of them. */
const allCalls: Call[] = [];
afterEach(() => {
  const seen = allCalls.splice(0);
  for (const call of seen) {
    if (call.method === "POST") expect(call.url, "the only POST is the token exchange").toBe(TOKEN_URL);
    else expect(call.method, `${call.method} ${call.url}`).toBe("GET");
  }
});

/** A fake network. The handler answers by URL; an unexpected URL throws, so a test fails if the script strays. */
function network(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined };
    calls.push(call);
    allCalls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchFn, calls };
}

let rsaPem = "";
let ecPem = "";
let google: Record<string, string> = {};
let apple: Record<string, string> = {};
const SECRET_FRAGMENTS: string[] = [];

beforeAll(async () => {
  const rsa = await generateKeyPair("RS256", { extractable: true, modulusLength: 2048 });
  rsaPem = await exportPKCS8(rsa.privateKey);
  const ec = await generateKeyPair("ES256", { extractable: true });
  ecPem = await exportPKCS8(ec.privateKey);
  google = {
    GOOGLE_PLAY_PACKAGE_NAME: PACKAGE,
    GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: "service_account",
      client_email: "play-check@example-project.iam.gserviceaccount.com",
      private_key_id: "0123456789abcdef0123456789abcdef01234567",
      private_key: rsaPem,
    }),
  };
  apple = {
    APPLE_BUNDLE_ID: "com.airplane.games",
    APPLE_IAP_KEY_ID: "ABCDE12345",
    APPLE_IAP_ISSUER_ID: "69a6de70-03db-47e3-e053-5b8c7c11a4d1",
    APPLE_APP_APPLE_ID: "1234567890",
    APPLE_IAP_KEY: ecPem.trim().replaceAll("\n", "\\n"),
  };
  // Pieces that must never reach the output: key body lines and the service-account email's key id.
  SECRET_FRAGMENTS.push(...rsaPem.split("\n").filter((line) => line.length > 20), ...ecPem.split("\n").filter((line) => line.length > 20), "0123456789abcdef0123456789abcdef01234567");
});

const env = (extra: Record<string, string | undefined>): NodeJS.ProcessEnv => ({ APP_ENV: "local", FIREBASE_PROJECT_ID: REAL_PROJECT, STORE_VERIFIER: "stores", ...extra });

const productList = (items: unknown[]) => json(200, { oneTimeProducts: items });
const oneTimeItems = DEMO_PRODUCTS.filter((p) => p.kind !== "first_class_pass").map((p) => ({ productId: p.productId, purchaseOptions: [{ purchaseOptionId: "buy", state: "ACTIVE" }] }));
const subscriptionItems = DEMO_PRODUCTS.filter((p) => p.kind === "first_class_pass").map((p) => ({ productId: p.productId, basePlans: [{ basePlanId: "p", state: "ACTIVE" }] }));

/** Healthy Google: token, both lists with the six ids, and "unknown token" probe answers. */
function healthyGoogle(overrides: Partial<Record<string, () => Response>> = {}) {
  return (call: Call): Response => {
    if (call.url === TOKEN_URL) return (overrides.token ?? (() => json(200, { access_token: ACCESS_TOKEN, expires_in: 3600, token_type: "Bearer" })))();
    const path = call.url.replace(API, "").replace(/\?.*$/, "");
    if (path === "/oneTimeProducts") return (overrides.oneTime ?? (() => productList(oneTimeItems)))();
    if (path === "/subscriptions") return (overrides.subs ?? (() => json(200, { subscriptions: subscriptionItems })))();
    if (path.startsWith("/purchases/productsv2/tokens/")) return (overrides.productProbe ?? (() => googleError(404, "notFound")))();
    if (path.startsWith("/purchases/subscriptionsv2/tokens/")) return (overrides.subProbe ?? (() => googleError(410, "purchaseTokenNoLongerValid")))();
    throw new Error(`unexpected request ${call.method} ${call.url}`);
  };
}

const text = (lines: string[]) => lines.join("\n");

describe("stores:check Google", () => {
  it("passes with a healthy account: every step PASS, the six ids reported, exit 0", async () => {
    const net = network(healthyGoogle());
    const result = await run(env(google), net.fetchFn, NOT_ROOT);
    expect(result.code).toBe(0);
    const out = text(result.lines);
    expect(out).toContain("PASS  Google token exchange");
    expect(out).toContain("PASS  Play access");
    expect(out).toContain("PASS  token probe productsv2");
    expect(out).toContain("PASS  token probe subscriptionsv2");
    expect(out).toContain("stores check passed");
    for (const product of DEMO_PRODUCTS) expect(out).toContain(`${product.productId}: ${product.kind === "first_class_pass" ? "subscription" : "one-time product"}, `);
    expect(out).not.toContain("WARN");
    expect(net.calls.map((c) => `${c.method} ${c.url.replace(API, "").replace(/\?.*$/, "").replace(/tokens\/.*/, "tokens/<probe>")}`)).toEqual([
      `POST ${TOKEN_URL}`,
      "GET /oneTimeProducts",
      "GET /subscriptions",
      "GET /purchases/productsv2/tokens/<probe>",
      "GET /purchases/subscriptionsv2/tokens/<probe>",
    ]);
  });

  it("is read-only: only the token POST and GETs to androidpublisher; no acknowledge, no database or Pub/Sub code", async () => {
    const net = network(healthyGoogle());
    await run(env(google), net.fetchFn, NOT_ROOT);
    for (const call of net.calls) {
      const allowedPost = call.method === "POST" && call.url === TOKEN_URL;
      const allowedGet = call.method === "GET" && call.url.startsWith("https://androidpublisher.googleapis.com/androidpublisher/v3/applications/");
      expect(allowedPost || allowedGet, `${call.method} ${call.url}`).toBe(true);
      expect(call.url).not.toContain(":acknowledge");
      expect(call.url).not.toContain("/consume");
      expect(call.url).not.toContain(":cancel");
      expect(call.url).not.toContain(":revoke");
    }
    // The token POST carries the JWT assertion only; nothing else is written.
    expect(net.calls.filter((c) => c.method !== "GET")).toHaveLength(1);
    // Static proof: the check and its entry point import neither a database nor Pub/Sub code, and name no write endpoint.
    for (const file of ["../src/purchases/stores-check.ts", "../scripts/stores-check.mjs"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const imports = [...source.matchAll(/^(?:import|export)[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1] as string);
      for (const specifier of imports) expect(specifier, `${file} imports ${specifier}`).not.toMatch(/database|drizzle|pg$|pubsub|\/db\/|store-purchase|purchases\.service|rtdn/i);
      expect(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(/:acknowledge|\bPUT\b|\bDELETE\b|\bPATCH\b/);
    }
  });

  it("reports missing, mistyped and inactive catalog ids as WARN without failing the run", async () => {
    const net = network(
      healthyGoogle({
        // aa.hints.15 missing; aa.miles.5000 exists only as a subscription; aa.firstclass.yearly has no active base plan.
        oneTime: () => productList(oneTimeItems.filter((item) => item.productId !== "aa.hints.15" && item.productId !== "aa.miles.5000")),
        subs: () =>
          json(200, {
            subscriptions: [
              { productId: "aa.firstclass.monthly", basePlans: [{ basePlanId: "p", state: "ACTIVE" }] },
              { productId: "aa.firstclass.yearly", basePlans: [{ basePlanId: "p", state: "INACTIVE" }, { basePlanId: "q", state: "DRAFT" }] },
              { productId: "aa.miles.5000", basePlans: [{ basePlanId: "p", state: "ACTIVE" }] },
            ],
          }),
      }),
    );
    const result = await run(env(google), net.fetchFn, NOT_ROOT);
    const out = text(result.lines);
    expect(result.code).toBe(0);
    expect(out).toContain("WARN  aa.hints.15: MISSING");
    expect(out).toContain("WARN  aa.miles.5000: WRONG TYPE");
    expect(out).toContain("WARN  aa.firstclass.yearly: subscription exists but has no ACTIVE base plan");
    expect(out).toContain("3 of 6 catalog product ids need attention");
    expect(out).toContain("aa.hints.5: one-time product");
    expect(out).toContain("aa.firstclass.monthly: subscription");
  });

  it("follows nextPageToken when listing", async () => {
    let page = 0;
    const net = network(
      healthyGoogle({
        oneTime: () => {
          page += 1;
          return page === 1 ? json(200, { oneTimeProducts: oneTimeItems.slice(0, 1), nextPageToken: "page-2" }) : productList(oneTimeItems.slice(1));
        },
      }),
    );
    const result = await run(env(google), net.fetchFn, NOT_ROOT);
    expect(result.code).toBe(0);
    expect(net.calls.some((c) => c.url.includes("pageToken=page-2"))).toBe(true);
    expect(text(result.lines)).not.toContain("MISSING");
  });

  it("says so when the 10-page cap is hit, and stops when nextPageToken repeats", async () => {
    let pages = 0;
    const endless = network(
      healthyGoogle({
        oneTime: () => {
          pages += 1;
          return json(200, { oneTimeProducts: [], nextPageToken: `page-${pages + 1}` });
        },
      }),
    );
    const capped = await run(env(google), endless.fetchFn, NOT_ROOT);
    expect(pages).toBe(10);
    expect(text(capped.lines)).toContain("WARN  one-time product list: list truncated after 10 pages");
    let repeats = 0;
    const loop = network(
      healthyGoogle({
        oneTime: () => {
          repeats += 1;
          return json(200, { oneTimeProducts: [], nextPageToken: "same" });
        },
      }),
    );
    const looped = await run(env(google), loop.fetchFn, NOT_ROOT);
    expect(repeats).toBe(2);
    expect(text(looped.lines)).toContain("WARN  one-time product list: list stopped: nextPageToken repeated");
  });

  it("a rejected token exchange FAILs with Google's error and sends nothing else", async () => {
    const net = network(healthyGoogle({ token: () => json(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." }) }));
    const result = await run(env(google), net.fetchFn, NOT_ROOT);
    expect(result.code).toBe(1);
    expect(text(result.lines)).toContain("FAIL  Google token exchange: HTTP 400 error=invalid_grant description=Invalid JWT Signature.");
    expect(net.calls).toHaveLength(1);
  });

  it("redacts anything token-like from Google's error text and never prints the assertion", async () => {
    const jwtLike = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ4In0.c2lnbmF0dXJlc2lnbmF0dXJlc2lnbmF0dXJl";
    const net = network(healthyGoogle({ token: () => json(400, { error: "invalid_grant", error_description: `Bad assertion ${jwtLike}` }) }));
    const result = await run(env(google), net.fetchFn, NOT_ROOT);
    const out = text(result.lines);
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("eyJ");
    const assertion = new URLSearchParams(net.calls[0]?.body ?? "").get("assertion") ?? "";
    expect(assertion.length).toBeGreaterThan(100);
    expect(out).not.toContain(assertion);
  });

  it("a network failure on the token exchange FAILs without detail", async () => {
    const net = network(() => {
      throw new TypeError("fetch failed: https://secret.example/?key=abc");
    });
    const result = await run(env(google), net.fetchFn, NOT_ROOT);
    expect(result.code).toBe(1);
    expect(text(result.lines)).toContain("FAIL  Google token exchange: key import, signing or network failure");
    expect(text(result.lines)).not.toContain("secret.example");
  });

  describe("access proof", () => {
    it.each([
      [401, "authError", /FAIL {2}Play access, one-time product list: HTTP 401 reason=authError/],
      [403, "androidPublisherApiNotEnabled", /FAIL {2}Play access, one-time product list: HTTP 403 reason=androidPublisherApiNotEnabled/],
    ])("HTTP %i on the list is a FAIL with Google's reason", async (status, reason, expected) => {
      const net = network(healthyGoogle({ oneTime: () => googleError(status, reason, "API disabled") }));
      const result = await run(env(google), net.fetchFn, NOT_ROOT);
      expect(result.code).toBe(1);
      expect(text(result.lines)).toMatch(expected);
      expect(text(result.lines)).toContain("API disabled");
      expect(text(result.lines)).not.toContain("PASS  Play access");
    });

    it("404 applicationNotFound is a package FAIL", async () => {
      const net = network(healthyGoogle({ subs: () => googleError(404, "applicationNotFound") }));
      const result = await run(env(google), net.fetchFn, NOT_ROOT);
      expect(result.code).toBe(1);
      expect(text(result.lines)).toContain("FAIL  Play access, subscription list: HTTP 404 reason=applicationNotFound");
      expect(text(result.lines)).toContain("Check GOOGLE_PLAY_PACKAGE_NAME");
    });

    it("any other answer is INCONCLUSIVE and says the access is not proven", async () => {
      const net = network(healthyGoogle({ oneTime: () => googleError(500, "backendError", ""), subs: () => new Response("<html>", { status: 502 }) }));
      const result = await run(env(google), net.fetchFn, NOT_ROOT);
      expect(result.code).toBe(1);
      expect(text(result.lines)).toContain("INCONCLUSIVE  Play access not proven by this check (one-time product list: HTTP 500 reason=backendError)");
      expect(text(result.lines)).toContain("INCONCLUSIVE  Play access not proven by this check (subscription list: HTTP 502 reason=none)");
    });

    it("204 No Content on the lists (seen live before the Play invite grants product access) is INCONCLUSIVE, never a PASS", async () => {
      const net = network(healthyGoogle({ oneTime: () => new Response(null, { status: 204 }), subs: () => new Response(null, { status: 204 }) }));
      const result = await run(env(google), net.fetchFn, NOT_ROOT);
      expect(result.code).toBe(1);
      expect(text(result.lines)).not.toContain("PASS  Play access");
      expect(text(result.lines)).toContain("INCONCLUSIVE  Play access not proven by this check (one-time product list: HTTP 204 reason=noContent");
      expect(text(result.lines)).toContain("INCONCLUSIVE  Play access not proven by this check (subscription list: HTTP 204 reason=noContent");
    });
  });

  describe("token probe", () => {
    it.each([
      ["400 invalidValue", () => googleError(400, "invalidValue")],
      ["ASSUMPTION: 400 invalid (seen live 2026-11-06 for a made-up token)", () => googleError(400, "invalid", "Invalid Value")],
      ["404 notFound", () => googleError(404, "notFound")],
      ["410 purchaseTokenNoLongerValid", () => googleError(410, "purchaseTokenNoLongerValid")],
    ])("%s passes", async (_name, answer) => {
      const net = network(healthyGoogle({ productProbe: answer, subProbe: answer }));
      const result = await run(env(google), net.fetchFn, NOT_ROOT);
      expect(result.code).toBe(0);
      expect(text(result.lines)).toContain("PASS  token probe productsv2");
    });

    it.each([401, 403])("HTTP %i FAILs", async (status) => {
      const net = network(healthyGoogle({ productProbe: () => googleError(status, "authError"), subProbe: () => googleError(status, "authError") }));
      const result = await run(env(google), net.fetchFn, NOT_ROOT);
      expect(result.code).toBe(1);
      expect(text(result.lines)).toContain(`FAIL  token probe productsv2: HTTP ${status}`);
      expect(text(result.lines)).toContain(`FAIL  token probe subscriptionsv2: HTTP ${status}`);
    });

    it("anything else is INCONCLUSIVE with its reason (404 applicationNotFound, 500, a network error)", async () => {
      const net = network(healthyGoogle({ productProbe: () => googleError(404, "applicationNotFound"), subProbe: () => googleError(500, "backendError") }));
      const result = await run(env(google), net.fetchFn, NOT_ROOT);
      expect(result.code).toBe(1);
      expect(text(result.lines)).toContain("INCONCLUSIVE  token probe productsv2: HTTP 404 reason=applicationNotFound");
      expect(text(result.lines)).toContain("INCONCLUSIVE  token probe subscriptionsv2: HTTP 500 reason=backendError");
      const down = network((call) => {
        if (call.url.includes("/purchases/")) throw new TypeError("fetch failed");
        return healthyGoogle()(call);
      });
      const result2 = await run(env(google), down.fetchFn, NOT_ROOT);
      expect(result2.code).toBe(1);
      expect(text(result2.lines)).toContain("INCONCLUSIVE  token probe productsv2: no usable answer");
    });
  });

  it("never prints a token, key, key id, JWT or Authorization header, in the pass or the fail case", async () => {
    const outputs = [
      await run(env(google), network(healthyGoogle()).fetchFn, NOT_ROOT),
      await run(env(google), network(healthyGoogle({ oneTime: () => googleError(403, "forbidden"), productProbe: () => googleError(401, "authError") })).fetchFn, NOT_ROOT),
    ];
    for (const result of outputs) {
      const out = text(result.lines);
      expect(out).not.toContain(ACCESS_TOKEN);
      expect(out).not.toMatch(/ya29\.|eyJ|Bearer|BEGIN|PRIVATE KEY|private_key/i);
      for (const fragment of SECRET_FRAGMENTS) expect(out).not.toContain(fragment);
    }
  });
});

describe("stores:check Apple", () => {
  const appleNet = (answer: (environment: "production" | "sandbox") => Response) =>
    network((call) => {
      const environment = call.url.startsWith("https://api.storekit-sandbox.apple.com/") ? "sandbox" : "production";
      if (!call.url.startsWith("https://api.storekit.apple.com/inApps/v1/transactions/") && environment === "production") throw new Error(`unexpected request ${call.url}`);
      return answer(environment);
    });

  it("passes when both environments say 4040010 for a made-up numeric transaction id (GETs only)", async () => {
    const net = appleNet(() => json(404, { errorCode: 4040010, errorMessage: "Transaction id not found." }));
    const result = await run(env(apple), net.fetchFn, NOT_ROOT);
    expect(result.code).toBe(0);
    expect(text(result.lines)).toContain("PASS  Apple production: HTTP 404 code=4040010");
    expect(text(result.lines)).toContain("PASS  Apple sandbox: HTTP 404 code=4040010");
    expect(net.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    for (const call of net.calls) expect(call.url).toMatch(/^https:\/\/api\.storekit(-sandbox)?\.apple\.com\/inApps\/v1\/transactions\/\d{15}\?$/);
    expect(text(result.lines)).toContain("not covered here: APPLE_APP_APPLE_ID");
  });

  it("a 401 with no body FAILs as a rejected JWT", async () => {
    const net = appleNet(() => new Response(null, { status: 401 }));
    const result = await run(env(apple), net.fetchFn, NOT_ROOT);
    expect(result.code).toBe(1);
    expect(text(result.lines)).toContain("FAIL  Apple production: HTTP 401 code=none (JWT rejected: check the key, Key ID, Issuer ID and bundle id)");
  });

  it("4000006 (auth ok, probe id malformed) and other answers are INCONCLUSIVE; 429 is rate limited", async () => {
    const malformed = await run(env(apple), appleNet(() => json(400, { errorCode: 4000006 })).fetchFn, NOT_ROOT);
    expect(malformed.code).toBe(1);
    expect(text(malformed.lines)).toContain("INCONCLUSIVE  Apple production: HTTP 400 code=4000006 (auth ok");
    const other = await run(env(apple), appleNet(() => json(500, { errorCode: 5000000 })).fetchFn, NOT_ROOT);
    expect(text(other.lines)).toContain("INCONCLUSIVE  Apple production: HTTP 500 code=5000000");
    const limited = await run(env(apple), appleNet(() => new Response("{}", { status: 429, headers: { "retry-after": "3" } })).fetchFn, NOT_ROOT);
    expect(text(limited.lines)).toContain("INCONCLUSIVE  Apple production: HTTP 429 (rate limited)");
  });

  it("a network failure is INCONCLUSIVE without printing the URL", async () => {
    const net = network(() => {
      throw new TypeError("fetch failed: https://secret.example/");
    });
    const result = await run(env(apple), net.fetchFn, NOT_ROOT);
    expect(result.code).toBe(1);
    expect(text(result.lines)).toContain("INCONCLUSIVE  Apple production: no usable answer");
    expect(text(result.lines)).not.toContain("secret.example");
  });

  it("never prints the key or a JWT", async () => {
    const net = appleNet(() => new Response(null, { status: 401 }));
    const result = await run(env(apple), net.fetchFn, NOT_ROOT);
    const out = text(result.lines);
    expect(out).not.toMatch(/eyJ|Bearer|BEGIN|PRIVATE KEY/i);
    for (const fragment of SECRET_FRAGMENTS) expect(out).not.toContain(fragment);
  });

  it("both stores configured: Google and Apple are both checked and both must pass", async () => {
    const google1 = healthyGoogle();
    const net = network((call) => (call.url.includes("apple.com") ? json(404, { errorCode: 4040010 }) : google1(call)));
    const result = await run(env({ ...google, ...apple }), net.fetchFn, NOT_ROOT);
    expect(result.code).toBe(0);
    expect(text(result.lines)).toContain("Google Play, package");
    expect(text(result.lines)).toContain("Apple App Store Server API");
    const broken = network((call) => (call.url.includes("apple.com") ? new Response(null, { status: 401 }) : google1(call)));
    expect((await run(env({ ...google, ...apple }), broken.fetchFn, NOT_ROOT)).code).toBe(1);
  });
});

describe("stores:check refusals (no request is sent)", () => {
  const silent = () => {
    const net = network(() => {
      throw new Error("no request may be sent");
    });
    return net;
  };

  it("refuses to run as root", async () => {
    const net = silent();
    const result = await run(env(google), net.fetchFn, { uid: 0 });
    expect(result.code).toBe(1);
    expect(text(result.lines)).toContain("Refusing to run as root");
    expect(net.calls).toHaveLength(0);
  });

  it("refuses APP_ENV=test (the demo-project workaround)", async () => {
    const net = silent();
    const result = await run(env({ ...google, APP_ENV: "test", FIREBASE_PROJECT_ID: "demo-airplane-games" }), net.fetchFn, NOT_ROOT);
    expect(result.code).toBe(1);
    expect(text(result.lines)).toContain("Refusing APP_ENV=test");
    expect(net.calls).toHaveLength(0);
  });

  it("refuses a demo- FIREBASE_PROJECT_ID", async () => {
    const net = silent();
    const result = await run(env({ ...google, FIREBASE_PROJECT_ID: "demo-airplane-games" }), net.fetchFn, NOT_ROOT);
    expect(result.code).toBe(1);
    expect(text(result.lines)).toContain("demo- FIREBASE_PROJECT_ID");
    expect(net.calls).toHaveLength(0);
  });

  it("nothing configured: exit 1, 'No request was sent'", async () => {
    const net = silent();
    const result = await run(env({}), net.fetchFn, NOT_ROOT);
    expect(result.code).toBe(1);
    expect(text(result.lines)).toContain("No request was sent.");
    expect(net.calls).toHaveLength(0);
  });

  it("a bad setting is named, never its value; blank settings count as unset (the server's trimming rules)", async () => {
    const net = silent();
    const bad = await run(env({ ...google, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: `{"private_key": "${rsaPem.split("\n")[1]}` }), net.fetchFn, NOT_ROOT);
    expect(bad.code).toBe(1);
    expect(text(bad.lines)).toContain("Invalid environment configuration: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON. No request was sent.");
    for (const fragment of SECRET_FRAGMENTS) expect(text(bad.lines)).not.toContain(fragment);
    const blank = await run(env({ GOOGLE_PLAY_PACKAGE_NAME: "   ", GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: "" }), net.fetchFn, NOT_ROOT);
    expect(text(blank.lines)).toContain("needs the APPLE_* or GOOGLE_PLAY_* settings");
    expect(net.calls).toHaveLength(0);
  });

  it("applies the server's production rule: STORE_ENABLED must match the configured stores", async () => {
    const net = silent();
    const result = await run(env({ ...google, APP_ENV: "production" }), net.fetchFn, NOT_ROOT);
    expect(text(result.lines)).toContain("STORE_ENABLED required");
    const ok = network(healthyGoogle());
    expect((await run(env({ ...google, APP_ENV: "production", STORE_ENABLED: "google" }), ok.fetchFn, NOT_ROOT)).code).toBe(0);
  });

  it("uses STORE_VERIFIER=stores whatever the environment says (the server's file may still say none)", async () => {
    const ok = network(healthyGoogle());
    const none = await run(env({ ...google, STORE_VERIFIER: "none" }), ok.fetchFn, NOT_ROOT);
    expect(none.code).toBe(0);
    expect(text(none.lines)).toContain("WARN  STORE_VERIFIER in the environment is not `stores`: the server will not use these settings (or will refuse to start)");
  });

  it("warns when STORE_VERIFIER is unset or not exactly `stores` after trimming, and not when it is `stores`", async () => {
    const warning = "STORE_VERIFIER in the environment is not `stores`";
    for (const value of [undefined, "", "fake", "Stores"]) {
      const result = await run(env({ ...google, STORE_VERIFIER: value }), network(healthyGoogle()).fetchFn, NOT_ROOT);
      expect(text(result.lines), String(value)).toContain(warning);
    }
    const trimmed = await run(env({ ...google, STORE_VERIFIER: " stores " }), network(healthyGoogle()).fetchFn, NOT_ROOT);
    expect(text(trimmed.lines)).not.toContain(warning);
  });

  it("passes APP_ENV through unchanged: missing, blank or odd values are refused like loadConfig does, with no request", async () => {
    for (const value of [undefined, "", "  ", " local ", "Local", "staging"]) {
      const net = silent();
      const result = await run(env({ ...google, APP_ENV: value }), net.fetchFn, NOT_ROOT);
      expect(result.code, String(value)).toBe(1);
      expect(text(result.lines)).toContain("Invalid environment configuration: APP_ENV. No request was sent.");
      expect(net.calls).toHaveLength(0);
    }
  });

  it("refuses the raw APP_ENV=test only (no trimming, no defaulting)", async () => {
    const net = silent();
    expect(text((await run(env({ ...google, APP_ENV: "test" }), net.fetchFn, NOT_ROOT)).lines)).toContain("Refusing APP_ENV=test");
    // " test " is not the enum value either, so loadConfig-style validation refuses it.
    expect(text((await run(env({ ...google, APP_ENV: " test " }), net.fetchFn, NOT_ROOT)).lines)).toContain("Invalid environment configuration: APP_ENV");
    expect(net.calls).toHaveLength(0);
  });
});
