/**
 * Co-Pilot hint economy, ported from the Unity sources of truth:
 *   - HintBank.cs (StarterHints = 5): every new player starts with five hints.
 *   - TripProfiles.cs (Hints = 1): a Flight (a Round here) allows one hint.
 *   - MilesHintPack.cs (client ruling CF-53, 2026-09-28): 10 hints for 5,000 Miles.
 * Keep them in step: the app shows these numbers, the server is the one that debits them.
 *
 * HintBank's Trip-completion grant (+1 per 4 Trips) and 7-day-streak grant are pure rules in trips.ts
 * (`tripHintGrant`, `recordPlayedDay`); nothing posts them to the ledger until slices T2/T3 build Trips.
 */
export const STARTER_HINTS = 5;
export const HINTS_PER_ROUND = 1;
export const MILES_HINT_PACK = { hints: 10, priceMiles: 5000 } as const;
