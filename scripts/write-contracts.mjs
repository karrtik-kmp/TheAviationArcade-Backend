// Regenerate the published contract files under contracts/ from the compiled rules.
// Run `npm run contracts:write` (it builds first). Generated files are never hand-edited; consumers vendor them.
import { mkdirSync, writeFileSync } from "node:fs";

const { renderCatalogJson } = await import("../dist/rules/catalog.js");

mkdirSync("contracts", { recursive: true });
writeFileSync("contracts/catalog.v1.json", renderCatalogJson(), { encoding: "utf8" });
console.log("wrote contracts/catalog.v1.json");
