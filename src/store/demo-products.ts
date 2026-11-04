import type { StoreProductRow } from "../db/schema.js";

/** A catalog row as seeded: the database fills `version` (1) and the timestamps. */
export type DemoProduct = Omit<StoreProductRow, "version" | "createdAt" | "updatedAt">;

/**
 * The one seed list (user ruling R1, docs/plans/purchases.md): the client's catalog from Unity `Contracts/products.v1.json`
 * (CF-33 / BLK-13). The hint counts and the monthly/yearly split are the client's numbers; the store ids are PLACEHOLDERS
 * (final ids: Unity Q4), which is why every row is `demo` (never listed or sold in production). Titles are plain staff labels.
 * Seeded by `npm run store:seed-demo` (slice P-B) and by test/store-helpers.ts. Prices are not stored: the store owns them.
 */
export const DEMO_PRODUCTS: readonly DemoProduct[] = [
  { productId: "aa.hints.5", kind: "hint_pack", hints: 5, passPeriod: null, title: "5 hints", demo: true, status: "active" },
  { productId: "aa.hints.15", kind: "hint_pack", hints: 15, passPeriod: null, title: "15 hints", demo: true, status: "active" },
  {
    productId: "aa.firstclass.monthly",
    kind: "first_class_pass",
    hints: null,
    passPeriod: "P1M",
    title: "First Class Pass, monthly",
    demo: true,
    status: "active",
  },
  {
    productId: "aa.firstclass.yearly",
    kind: "first_class_pass",
    hints: null,
    passPeriod: "P1Y",
    title: "First Class Pass, yearly",
    demo: true,
    status: "active",
  },
];
