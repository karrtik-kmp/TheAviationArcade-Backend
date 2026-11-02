import { MODULE_IDS } from "../../rules/modules.js";
import type { ModuleId } from "../../rules/modules.js";
import { modulesInTicketOrder } from "../../rules/catalog.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import type { DocumentMeta } from "./document-store.js";

/** Unity `ApiWireModels.ModuleWire`: the four names and types are unchanged. */
export type ManifestModule = { id: ModuleId; enabled: true; contentVersion: null; assetBundleUrl: null };

export type ManifestDocument = {
  name: string;
  format: string;
  version: number;
  sha256: string;
  byteSize: number;
  url: string;
};

/** Unity `ApiWireModels.ManifestWire` (`version`, `generatedAtUtc`, `modules`) plus `documents`. */
export type ContentManifest = {
  version: string;
  generatedAtUtc: string;
  modules: ManifestModule[];
  documents: ManifestDocument[];
};

/** Fixed fallback for an empty store (never the case after the boot seed): a constant, not the clock, so the body stays stable. */
export const EMPTY_GENERATED_AT = "1970-01-01T00:00:00.000Z";

/** All eight modules, in Unity ticket order. The backend never disables a module (Remote Config is the kill switch); content releases (5.2+) fill the two nulls. */
export function manifestModules(): ManifestModule[] {
  const ids: readonly ModuleId[] = modulesInTicketOrder();
  if (ids.length !== MODULE_IDS.length) throw new Error("Module catalog and MODULE_IDS disagree.");
  return ids.map((id) => ({ id, enabled: true, contentVersion: null, assetBundleUrl: null }));
}

/**
 * The manifest for the highest document versions. Everything in it is a function of the stored rows and the module list,
 * so any instance, before or after a restart, builds the same bytes and the same `version`:
 *  - `version` = `m-` + the first 16 hex of SHA-256 over the canonical JSON of the sorted (name, version, sha256) list and
 *    the module entries (a change to either changes it; the hash input has its own `v` so the recipe can change).
 *  - `generatedAtUtc` = the newest `created_at` among the listed documents (database clock): the instant the manifest last
 *    CHANGED. It is not the request time, so it cannot make two reads of one version differ (the ETag is strong).
 * `documents` is sorted by name.
 */
export function buildManifest(latest: readonly DocumentMeta[]): ContentManifest {
  const documents = [...latest]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((d) => ({
      name: d.name,
      format: d.format,
      version: d.version,
      sha256: d.sha256,
      byteSize: d.byteSize,
      url: `/v1/content/documents/${d.name}/${d.version}`,
    }));
  const modules = manifestModules();
  const recipe = {
    v: 1,
    documents: documents.map((d) => ({ name: d.name, version: d.version, sha256: d.sha256 })),
    modules,
  };
  const newest = latest.reduce<Date | null>((best, d) => (best === null || d.createdAt > best ? d.createdAt : best), null);
  return {
    version: `m-${sha256Hex(canonicalJson(recipe)).slice(0, 16)}`,
    generatedAtUtc: newest ? newest.toISOString() : EMPTY_GENERATED_AT,
    modules,
    documents,
  };
}
