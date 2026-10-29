import type { ContentModuleMapping } from "./content-module.js";
import { militaryMapping } from "./modules/military.js";

/** Modules that can be imported and exported today. Others are 404 until their mapping exists. */
const MAPPINGS: ReadonlyMap<string, ContentModuleMapping> = new Map(
  [militaryMapping].map((mapping) => [mapping.module, mapping]),
);

export function contentMappingFor(module: string): ContentModuleMapping | undefined {
  return MAPPINGS.get(module);
}

/** Natural id order: mil-a2 before mil-a10. */
export function compareIds(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}
