/**
 * Backend module IDs: exactly the Unity ModuleRegistry BackendIds (the ids the app sends on the wire).
 * The website catalog keys Military as "military-identifier"; that id never reaches this API.
 * The Military game's final name is a working title.
 */
export const MODULE_IDS = [
  "airport-spotter",
  "atc-match",
  "call-sign-match",
  "identifier",
  "aircraft-identifier-military",
  "code-search",
  "runway-identifier",
  "tail-identifier",
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
