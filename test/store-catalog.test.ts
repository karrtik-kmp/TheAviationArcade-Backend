import { describe, expect, it } from "vitest";
import { HINT_LEDGER_KINDS } from "../src/balance/ledger-kinds.js";
import { ADMIN_AUDIT_ACTIONS } from "../src/db/enums.js";
import { isListed, isSellable } from "../src/store/catalog.js";
import { DEMO_PRODUCTS } from "../src/store/demo-products.js";

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
  it("are the client's four catalog rows, all demo and active", () => {
    expect(DEMO_PRODUCTS.map((p) => [p.productId, p.kind, p.hints, p.passPeriod])).toEqual([
      ["aa.hints.5", "hint_pack", 5, null],
      ["aa.hints.15", "hint_pack", 15, null],
      ["aa.firstclass.monthly", "first_class_pass", null, "P1M"],
      ["aa.firstclass.yearly", "first_class_pass", null, "P1Y"],
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
