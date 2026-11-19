// The Firebase Auth Emulator for the demo project only (demo-airplane-games). `npm run auth:emulator` keeps it in the foreground; the
// e2e suite starts it the same way (test/global-setup.ts) unless one is already listening at FIREBASE_AUTH_EMULATOR_HOST.
// Port 9199 (firebase.json), so it never clashes with the website's on 9099. The admin grant uses it to mark emails verified
// (ADR-0002 follow-up 2026-11-19). It needs no login and no Java.
//
// firebase-tools is run through npm's npx at one pinned version (released 2026-11-04), not as a dependency: it adds ~500 packages
// and a native module, and the server's `npm ci` must not install them. The first run downloads it into the npm cache.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIREBASE_TOOLS = "firebase-tools@15.35.0";
export const EMULATOR_PROJECT = "demo-airplane-games";
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** npm's npx CLI next to this Node (a Windows-safe way to run it without a shell). FIREBASE_NPX_PATH overrides it. */
function npxCli() {
  const candidate = process.env.FIREBASE_NPX_PATH?.trim() || join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  if (existsSync(candidate)) return candidate;
  const unix = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js");
  if (existsSync(unix)) return unix;
  throw new Error(`Could not find npm's npx-cli.js (looked at ${candidate}); set FIREBASE_NPX_PATH.`);
}

/** Spawn the emulator; the caller owns the child process. */
export function startAuthEmulator(stdio = "inherit") {
  return spawn(
    process.execPath,
    [npxCli(), "--yes", FIREBASE_TOOLS, "emulators:start", "--only", "auth", "--project", EMULATOR_PROJECT, "--config", join(repoRoot, "firebase.json")],
    { cwd: repoRoot, stdio, windowsHide: true },
  );
}

/** Stop the emulator and the processes npx started under it (on Windows a plain kill leaves the grandchild running). */
export function stopAuthEmulator(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const child = startAuthEmulator();
  child.on("exit", (code) => process.exit(code ?? 0));
}
