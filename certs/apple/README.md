# Apple root certificates

Public certificates only (no keys). The Apple adapter (`src/purchases/apple-store-verifier.ts`) passes every `*.cer` in this
folder to the App Store Server Library's `SignedDataVerifier` as the trust anchor for signed transactions. The Dockerfile runtime
stage copies `certs/`. `test/apple-store-verifier.test.ts` hashes each `.cer` against the table below, so a changed or missing
file fails the unit tests.

| File | SHA-256 (DER) | Subject | Valid until | Retrieved |
|---|---|---|---|---|
| `AppleRootCA-G3.cer` | `63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179` | CN=Apple Root CA - G3, OU=Apple Certification Authority, O=Apple Inc., C=US (ECDSA P-384, self-signed) | 2039-04-30 18:19:06 UTC | 2026-11-05 |

- Source: https://www.apple.com/certificateauthority/AppleRootCA-G3.cer (Apple PKI, "Apple Root Certificates").
- Second source: Apple Support, "Available trusted root certificates for Apple operating systems"
  (https://support.apple.com/en-us/105116) lists Apple Root CA - G3 with SHA-256 fingerprint
  `63 34 3A BF B8 9A 6A 03 EB B5 7E 9B 3F 5F A7 BE 7C 4F 5C 75 6F 30 17 B3 A8 C4 88 C3 65 3E 91 79`, which equals the hash above.
  Checked 2026-11-05. (crt.sh was unavailable, 502, at the time.)
- Why only G3: Apple signs StoreKit transactions with a leaf and the WWDR intermediate that chain to Apple Root CA - G3; the
  library README says to use the roots from the Apple PKI page and names no further root for signed transactions.
- To add or replace a root: download it from the Apple PKI page, check its fingerprint against the Apple Support list, add a row
  here with the new SHA-256, and keep the file name stable.
