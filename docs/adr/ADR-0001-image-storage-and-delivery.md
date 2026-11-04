# Backend ADR-0001: Game image storage and delivery through a token-protected Bunny CDN

**Status:** Accepted (user, 2026-11-03). Live Bunny changes (pull zone, token key, Edge Rule) still need the user's
explicit sign-off and a passing `npm run bunny:check` before any real use.
**Date:** 2026-11-03
**Deciders:** the user (product owner of this backend); the backend session implements.

Numbering: this is the backend repo's own ADR series, separate from the Unity repo's ADR-0001…0008.

## Context

Wave B moves game content to the backend (see [releases-and-dealing.md](../design/releases-and-dealing.md)). Every
photo-based module needs images that the Unity app and the website can download.

Forces at play:

- **Images are never bundled.** The app and the website load every image by URL, because content changes after release.
  Plane of the Day changes daily. A Trip already needs a network connection.
- **Storage is private Bunny Storage.** The only zone, `aviation-arcade-website` (Frankfurt, `de`), is shared with the
  website, which keeps photographers' private submissions in it. The backend writes under the prefix `backend/`.
  Storage files can only be read with the zone password. No pull zone (CDN) exists today. Sources:
  `src/storage/blob-store.ts:5-11`, which has put/get/delete only, and the website's Worker, which streams private photos
  itself (`website/lib/request/routes.ts:125`).
- **Bunny facts** (current docs, checked 2026-11-03):
  - A pull zone on a storage zone exposes the **whole** zone unless token authentication is on. Token auth applies to the
    whole pull zone.
  - There is no per-file ACL. The S3 API does not support ACLs, and S3 metadata is ignored by pull zones.
  - Advanced tokens are `HS256-` plus base64url of HMAC-SHA256(key, path + expires [+ ip] [+ signed params]), passed as
    query parameters. They work with clients that send no headers.
  - Enabling token auth disables IPv6 on that pull zone.
  - The S3 API is in **public preview**.
  - Sources: bunny.net/docs/storage/s3.md, bunny.net/docs/cdn/security/token-authentication/advanced.md,
    bunny.net/docs/cdn/edge-rules/index.md.
- **The Unity client loads images with a plain `UnityWebRequestTexture.GetTexture(url)`.** It sends no headers and keeps
  no cache (`Assets/_Project/Scripts/Presentation/UI/RemoteImageLoader.cs:25`). The wire models already carry image URL
  fields (`ApiWireModels.cs:13,125,132,154`).
- **Licensing.** Photos come with client-stated licences, for example "Unsplash License per Josh" for the Military set.
  The credit has to travel with the image.
- **Project rules.** Real Bunny is contacted only with the user's sign-off. Tests use the memory blob store or a stubbed
  fetcher. No secret may be committed.

## Decision

**Store each game image once in the shared zone under a content-addressed key, describe it in a backend media table, and
deliver it through a Bunny pull zone that requires a token on every request. The backend signs a fresh 24-hour link for
each image only when the caller is allowed to see it.**

1. **Storage key:** `backend/content/photos/<sha256>.<jpg|png>`. A key's bytes never change, and nothing is overwritten
   or deleted. A changed image is a new file plus a version bump on its media row.
2. **Media table (backend Postgres).** One row per image holds:
   - the storage path, sha256, byte size, content type, width, height and version;
   - the licence fields: credit name, licence name, licence URL, source URL, attribution text, and a "credit must be
     shown" flag;
   - the publication state (`unverified` → `published`, or `withdrawn`), the creator, and the database-clock timestamps.

   The row **never stores a full URL.**
3. **Upload through the backend only.** Staff upload the raw bytes. The backend checks magic bytes and dimensions, hashes
   the bytes, puts the file through the Bunny S3 API (the HTTP Storage API is the fallback if the preview changes), reads
   it back to verify the hash, then inserts the row. Staff never hold Bunny credentials.
4. **Upload stores; publish makes live.** A staff publish (a content release, or a Plane of the Day entry) moves an image
   to `published`. Until then the backend signs links for it for staff only, for preview.
5. **CDN:** a pull zone on `aviation-arcade-website` with **token authentication on**, using advanced HS256 tokens.
   - One signature per file (no folder-wide `token_path`).
   - No IP binding.
   - Expiry is **24 hours** from issue.
   - The signing key lives only in the backend environment (`BUNNY_CDN_TOKEN_KEY`, a placeholder row in `.env.example`).
     The hostname is `BUNNY_CDN_HOST`, defaulting to Bunny's `<name>.b-cdn.net`; a custom domain is a later setting change.
   - Rotating the key in the Bunny dashboard immediately invalidates every link already issued.
6. **Defence in depth:** an Edge Rule on the pull zone blocks every path outside `/backend/content/photos/`. Even a
   leaked signing key cannot reach the website's private files through this CDN.
7. **Caching** (set by Edge Rules, because pull zones ignore S3 metadata): edge cache 1 year, which is safe because files
   are content-addressed; browser and device cache 24 hours, matching the link lifetime. No purge is ever needed.
8. **Who receives links:**
   - `POST /v1/trips` returns all ten image links of a dealt Trip for preloading.
   - Each `POST /v1/rounds` returns its own image link again, signed fresh.
   - The website gets image records (link + licence fields) from the backend API, server to server with the staff or
     player token, exactly as the app does. It never signs links and never reads Bunny for game images.
   - Each link is sent with the image's sha256 (the stable id for device caching) and its licence fields.

   **Amendment 2026-11-04 (user ruling).** Guests may see published images on the public website. The backend adds an
   anonymous, published-only read, `GET /v1/public/media?ids=`: the same signed 24-hour links, licence fields and
   50-id limit as the signed-in read, no owner or principal in the answer, and no website secret (the route is public and
   rate limited per IP; an Authorization header is ignored). Unpublished and withdrawn images stay unreachable. A signed
   24-hour link is still not a public image URL: it is issued per request and expires.
9. **Plane of the Day** is the next slice built on this pipeline: a dated schedule of published images and text.

## Options Considered

### Option A: Token-protected pull zone on the shared zone, links signed by the backend (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: one pull zone, one Edge Rule, an HMAC signer, a media table |
| Cost | CDN egress only; no origin load on our servers |
| Scalability | High: Bunny edge serves and caches; signing is one HMAC per link |
| Team familiarity | Medium: Bunny S3 is already used for imports; tokens are new |

**Pros:** images come straight from the CDN; the website's private files stay unreachable without a key we never sign
them with; publish and unpublish are a database flag; no file copying; the app loader works unchanged.
**Cons:** token auth disables IPv6 on the pull zone; an unpublished image's links stay valid up to 24 h, unless the key
is rotated; the S3 API is a preview; the signing key is a high-value secret for the whole shared zone.

### Option B: Backend-streamed images behind backend-signed links

| Dimension | Assessment |
|---|---|
| Complexity | Low-medium: a `@Public` streaming route, an LRU cache |
| Cost | Every image byte passes through our servers |
| Scalability | Limited by backend egress and memory |
| Team familiarity | High: the same pattern as the website's Worker |

**Pros:** no Bunny account change; instant revocation.
**Cons:** origin load and latency on every cache miss; a second public route; it does not use the CDN the user chose.

### Option C: A separate storage zone and pull zone just for game content

| Dimension | Assessment |
|---|---|
| Complexity | Low on the CDN side; one more zone to manage |
| Cost | Similar to A |
| Scalability | High |
| Team familiarity | Medium |

**Pros:** isolates private website files by construction; token auth optional.
**Cons:** another zone and password to manage. The user preferred keeping the shared zone, with access controlled by
permission (2026-11-03).

### Option D: Truly public, unsigned URLs after publish

Publishing copies the file into a public folder, and an Edge Rule disables token auth there.

**Pros:** permanent, simple URLs.
**Cons:** published links can never be revoked; it relies on per-path token-disable behaviour that Bunny's docs do not
describe in detail; it needs a copy on every publish.

Rejected details: overwrite-in-place files (stale caches, purges); a folder-wide `token_path` (one link would also unlock
unpublished images); IP-bound tokens (they break when phones switch networks, and when the website's server requests a
link that a visitor's browser then opens).

## Trade-off Analysis

The deciding forces were **CDN delivery** (the user's choice) and **keeping the website's private submissions safe in a
shared zone**. Bunny offers no per-file permission, so the permission has to live in our database and be enforced by
signing. Zone-wide token auth gives exactly that, and the Edge Rule caps the damage of a key leak to the game folder.

Content-addressed keys make the long edge cache and the "never overwrite or delete" rule free, and versions live on the
media row. The cost we accept is a revocation window of up to 24 hours, the user's choice for link and device cache
lifetime; key rotation is the emergency override.

## Consequences

- **Easier:**
  - The app and the website load images by plain URL.
  - Content updates, including daily Plane of the Day, need no app release.
  - Credits travel with every image.
  - A changed image never breaks an open Trip.
- **Harder:**
  - The signing key must be protected and rotated with care: rotation invalidates every link, including the website's.
  - IPv6 is off for this pull zone.
  - Links expire, so long-lived screens must re-request them.
  - Withdrawing an image takes up to 24 hours to take effect without a rotation.
- **To revisit:**
  - the S3 API leaving preview (or the switch to the HTTP Storage API);
  - a custom image domain;
  - whether Plane of the Day wants a different link lifetime;
  - whether to split into a separate content zone later (Option C) if the shared zone becomes a risk.

## Action Items

1. [ ] P1: media table migration (path, sha256, size, type, dimensions, version, licence fields, state); staff upload,
   link and preview routes; image sniffer; tests against `MemoryBlobStore` only.
2. [ ] P2: CDN link signer (HS256 per-file, 24 h, `BUNNY_CDN_TOKEN_KEY`, `BUNNY_CDN_HOST`), unit-tested against Bunny's
   documented algorithm with fixed vectors; image links and licence fields in the Trip open and Round issue responses;
   website-facing image record route.
3. [ ] Update `docs/openapi.yaml`, `.env.example`, `README.md` and ARCHITECTURE "File storage".
   [releases-and-dealing.md](../design/releases-and-dealing.md) §2.3 already defers to this ADR.
4. [ ] With the user's sign-off: create the pull zone on `aviation-arcade-website` and enable advanced token auth; add
   the Edge Rules (block outside `/backend/content/photos/`; edge cache 1 year; browser cache 24 h); set the env vars;
   run `npm run bunny:check`; then curl-test that an unsigned URL is 403, a signed one is 200, and
   `/<other prefix>/x` is 403 even when signed.
5. [ ] Plane of the Day slice on top of this pipeline.
6. [ ] Tell the website and Unity sessions about the contract: image link + sha256 + licence fields on Trip open and
   Round issue; links expire after 24 h; the app may cache by sha256.
