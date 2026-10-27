/**
 * Backend module IDs. These follow the Unity ModuleRegistry and the website catalog
 * (website/lib/catalog.ts), so all three agree. "military-identifier" is a working title.
 */
export const MODULE_IDS = [
  "airport-spotter",
  "atc-match",
  "call-sign-match",
  "identifier",
  "military-identifier",
  "code-search",
  "runway-identifier",
  "tail-identifier",
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
