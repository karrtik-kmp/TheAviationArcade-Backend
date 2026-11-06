import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "vitest";
import { readKeyFile } from "../src/config/config.module.js";

// Wave P-K slice K2: a key file may live in <repo>/secrets/ for local development, and nowhere else inside the repo.
// Every test builds its own throwaway "repo" under the OS temp directory; the real repo's secrets/ is never touched or read.
const KEY = "throwaway key bytes (not a real key)";
const OUTSIDE = "must point outside the working directory";

let root = "";
let repo = "";
let elsewhere = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "key-folder-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** A fresh repo-shaped directory with src/, a repo file and secrets/ (when asked), plus an unrelated directory outside it. */
function freshRepo(options: { secrets?: boolean } = { secrets: true }) {
  counter += 1;
  repo = join(root, `repo${counter}`);
  elsewhere = join(root, `outside${counter}`);
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(repo, "src", "key.json"), KEY);
  writeFileSync(join(repo, "repo-file.json"), KEY);
  writeFileSync(join(elsewhere, "key.json"), KEY);
  if (options.secrets) {
    mkdirSync(join(repo, "secrets"));
    writeFileSync(join(repo, "secrets", "key.json"), KEY);
  }
  return { repo, elsewhere };
}

const read = (path: string, appEnv: "local" | "test" | "production" = "local") => readKeyFile("GOOGLE_PLAY_SERVICE_ACCOUNT_FILE", path, appEnv, { repoRoot: repo, cwd: repo });
const refused = (path: string, appEnv: "local" | "test" | "production" = "local") => {
  try {
    read(path, appEnv);
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
};

/** Symlinks need privileges on Windows; skip the test cleanly when the OS refuses. */
function tryLink(context: TestContext, target: string, path: string, type?: "junction" | "dir" | "file"): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    context.skip("the OS refused to create this link");
    return false;
  }
}

describe("readKeyFile and <repo>/secrets", () => {
  it("allows a key inside <repo>/secrets outside production (local and test)", () => {
    freshRepo();
    expect(read(join(repo, "secrets", "key.json"))).toBe(KEY);
    expect(read(join(repo, "secrets", "key.json"), "test")).toBe(KEY);
    // A relative path resolves against the working directory (here the repo).
    const previous = process.cwd();
    try {
      process.chdir(repo);
      expect(readKeyFile("X", "secrets/key.json", "local", { repoRoot: repo })).toBe(KEY);
    } finally {
      process.chdir(previous);
    }
  });

  it("refuses the same key in production (server keys live in /etc/aviation-arcade/secrets/)", () => {
    freshRepo();
    expect(refused(join(repo, "secrets", "key.json"), "production")).toBe(`Invalid environment configuration: GOOGLE_PLAY_SERVICE_ACCOUNT_FILE ${OUTSIDE}`);
  });

  it("still allows a key outside the repo in every environment, and refuses repo files outside secrets", () => {
    freshRepo();
    for (const appEnv of ["local", "test", "production"] as const) expect(read(join(elsewhere, "key.json"), appEnv)).toBe(KEY);
    expect(refused(join(repo, "src", "key.json"))).toContain(OUTSIDE);
    expect(refused(join(repo, "repo-file.json"))).toContain(OUTSIDE);
    // A sibling folder that merely starts with "secrets" is not the folder.
    mkdirSync(join(repo, "secrets-old"));
    writeFileSync(join(repo, "secrets-old", "key.json"), KEY);
    expect(refused(join(repo, "secrets-old", "key.json"))).toContain(OUTSIDE);
    // Nor is a nested secrets folder.
    mkdirSync(join(repo, "src", "secrets"));
    writeFileSync(join(repo, "src", "secrets", "key.json"), KEY);
    expect(refused(join(repo, "src", "secrets", "key.json"))).toContain(OUTSIDE);
  });

  it("refuses a path that leaves secrets/ through `..`", () => {
    freshRepo();
    expect(refused(join(repo, "secrets", "..", "repo-file.json"))).toContain(OUTSIDE);
  });

  it("refuses when secrets is a symlink to src/", (context) => {
    freshRepo({ secrets: false });
    if (!tryLink(context, join(repo, "src"), join(repo, "secrets"), "dir")) return;
    expect(refused(join(repo, "secrets", "key.json"))).toContain(OUTSIDE);
  });

  it("refuses when secrets is a junction to src/ (Windows junction; a symlink elsewhere)", (context) => {
    freshRepo({ secrets: false });
    if (!tryLink(context, join(repo, "src"), join(repo, "secrets"), "junction")) return;
    expect(refused(join(repo, "secrets", "key.json"))).toContain(OUTSIDE);
  });

  it("a secrets link to a directory outside the repo is an ordinary outside-the-repo key", (context) => {
    freshRepo({ secrets: false });
    if (!tryLink(context, elsewhere, join(repo, "secrets"), "junction")) return;
    // The file's realpath is outside the repo, so the ordinary outside-the-repo rule allows it: only a link back INTO the repo is the risk.
    expect(read(join(repo, "secrets", "key.json"))).toBe(KEY);
  });

  it("refuses a symlink inside secrets/ that points back to a repo file", (context) => {
    freshRepo();
    if (!tryLink(context, join(repo, "repo-file.json"), join(repo, "secrets", "link.json"), "file")) return;
    expect(refused(join(repo, "secrets", "link.json"))).toContain(OUTSIDE);
  });

  it("refuses a case-variant `Secrets` folder (the exact directory entry `secrets` is required)", () => {
    freshRepo({ secrets: false });
    mkdirSync(join(repo, "Secrets"));
    writeFileSync(join(repo, "Secrets", "key.json"), KEY);
    // On a case-sensitive file system `secrets` does not exist and the file is simply inside the repo; on Windows both spellings resolve.
    expect(refused(join(repo, "Secrets", "key.json"))).toContain(OUTSIDE);
    expect(refused(join(repo, "secrets", "key.json"))).toBeDefined();
  });

  it("refuses when secrets is a plain file, not a directory", () => {
    freshRepo({ secrets: false });
    writeFileSync(join(repo, "secrets"), KEY);
    expect(refused(join(repo, "secrets"))).toContain(OUTSIDE);
  });

  it("a missing file names the setting only", () => {
    freshRepo();
    expect(refused(join(repo, "secrets", "missing.json"))).toBe("Invalid environment configuration: GOOGLE_PLAY_SERVICE_ACCOUNT_FILE");
  });
});

describe("secrets/ is ignored by git and by Docker", () => {
  const backend = new URL("../", import.meta.url);
  const gitIgnore = (cwd: string, path: string) => spawnSync("git", ["check-ignore", "-q", path], { cwd, encoding: "utf8" });

  it("the real repo ignores secrets/probe.json (check-ignore reads only the rules; no file is opened)", () => {
    const result = gitIgnore(fileURLToPath(backend), "secrets/probe.json");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it("holds even with a nested secrets/.gitignore of `!*`, in a throwaway repo with the real .gitignore", () => {
    const dir = mkdtempSync(join(root || tmpdir(), "ignore-"));
    expect(spawnSync("git", ["init", "-q"], { cwd: dir }).status).toBe(0);
    copyFileSync(new URL(".gitignore", backend), join(dir, ".gitignore"));
    mkdirSync(join(dir, "secrets"));
    writeFileSync(join(dir, "secrets", ".gitignore"), "!*\n");
    expect(gitIgnore(dir, "secrets/probe.json").status).toBe(0);
    expect(gitIgnore(dir, "secrets/.gitignore").status).toBe(0);
  });

  it("the nested `!*` really would re-include the file without the root /secrets/ rule (the test can fail)", () => {
    const dir = mkdtempSync(join(root || tmpdir(), "ignore-control-"));
    expect(spawnSync("git", ["init", "-q"], { cwd: dir }).status).toBe(0);
    writeFileSync(join(dir, ".gitignore"), "*.p8\n");
    mkdirSync(join(dir, "secrets"));
    writeFileSync(join(dir, "secrets", ".gitignore"), "!*\n");
    expect(gitIgnore(dir, "secrets/probe.json").status).toBe(1);
  });

  it(".dockerignore has an exact `secrets` line and no later `!secrets` (or `!/secrets`) re-include", () => {
    const lines = readFileSync(new URL(".dockerignore", backend), "utf8").split(/\r?\n/).map((line) => line.trim());
    const index = lines.indexOf("secrets");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(lines.slice(index + 1).filter((line) => /^!\/?secrets/.test(line))).toEqual([]);
    expect(existsSync(new URL(".dockerignore", backend))).toBe(true);
  });
});
