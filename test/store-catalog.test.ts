import { describe, expect, it } from "vitest";
import { HINT_LEDGER_KINDS, MILES_LEDGER_KINDS } from "../src/balance/ledger-kinds.js";
import { ADMIN_AUDIT_ACTIONS } from "../src/db/enums.js";
import { isListed, isSellable } from "../src/store/catalog.js";
import { DEMO_PRODUCTS } from "../src/store/demo-products.js";
import { StoreCatalogService } from "../src/store/store-catalog.service.js";
import type { ProductWrite } from "../src/store/store-catalog.service.js";
import { ApiError } from "../src/common/errors.js";

describe("catalog predicates (docs/plans/purchases.md)", () => {
  const rows = [
    { status: "active", demo: false },
    { status: "retired", demo: false },
    { status: "active", demo: true },
    { status: "retired", demo: true },
  ] as const;

  it("sellable: active or retired, never demo in production", () => {
    expect(rows.map((r) => isSellable(r, "production"))).toEqual([true, true, false, false]);
    for (const env of ["local", "test"] as const) expect(rows.map((r) => isSellable(r, env))).toEqual([true, true, true, true]);
  });

  it("listed: active only, never demo in production", () => {
    expect(rows.map((r) => isListed(r, "production"))).toEqual([true, false, false, false]);
    for (const env of ["local", "test"] as const) expect(rows.map((r) => isListed(r, env))).toEqual([true, false, true, false]);
  });
});

describe("demo products (user ruling R1)", () => {
  it("are the client's four catalog rows plus the two placeholder Miles packs (U11), all demo and active", () => {
    expect(DEMO_PRODUCTS.map((p) => [p.productId, p.kind, p.hints, p.miles, p.passPeriod])).toEqual([
      ["aa.hints.5", "hint_pack", 5, null, null],
      ["aa.hints.15", "hint_pack", 15, null, null],
      ["aa.miles.5000", "miles_pack", null, 5000, null],
      ["aa.miles.25000", "miles_pack", null, 25000, null],
      ["aa.firstclass.monthly", "first_class_pass", null, null, "P1M"],
      ["aa.firstclass.yearly", "first_class_pass", null, null, "P1Y"],
    ]);
    expect(DEMO_PRODUCTS.every((p) => p.demo && p.status === "active" && /^[a-z0-9][a-z0-9._]{0,99}$/.test(p.productId))).toBe(true);
  });
});

describe("new ledger kind and audit actions", () => {
  it("are in the TypeScript lists", () => {
    expect(HINT_LEDGER_KINDS).toContain("store_purchase");
    for (const a of ["store_product_create", "store_product_edit", "store_product_retire", "store_product_restore"]) {
      expect(ADMIN_AUDIT_ACTIONS).toContain(a);
    }
  });
});

describe("Miles ledger kinds", () => {
  it("include store_purchase", () => {
    expect(MILES_LEDGER_KINDS).toEqual(["round_award", "hint_pack", "store_purchase"]);
  });
});

describe("catalog pairing: hints, miles and passPeriod by kind", () => {
  // The pairing is checked before the database is touched, so no connection is needed.
  const service = new StoreCatalogService(null as never);
  const put = (body: Partial<ProductWrite> & Pick<ProductWrite, "kind">) =>
    service.put("firebase:demo:admin", "x.product", undefined, { title: "t", demo: true, ...body }, "test");
  const refused = async (body: Parameters<typeof put>[0]) => {
    const error = await put(body).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).code).toBe("content_invalid");
  };

  it("a hint pack needs hints and refuses miles or passPeriod", async () => {
    await refused({ kind: "hint_pack" });
    await refused({ kind: "hint_pack", hints: 5, miles: 5 });
    await refused({ kind: "hint_pack", hints: 5, passPeriod: "P1M" });
  });

  it("a Miles pack needs miles and refuses hints or passPeriod", async () => {
    await refused({ kind: "miles_pack" });
    await refused({ kind: "miles_pack", miles: 5000, hints: 5 });
    await refused({ kind: "miles_pack", miles: 5000, passPeriod: "P1M" });
  });

  it("a Pass needs passPeriod and refuses hints or miles", async () => {
    await refused({ kind: "first_class_pass" });
    await refused({ kind: "first_class_pass", passPeriod: "P1M", hints: 5 });
    await refused({ kind: "first_class_pass", passPeriod: "P1M", miles: 5 });
  });
});
