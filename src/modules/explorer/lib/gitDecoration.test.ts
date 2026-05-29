import { describe, expect, it } from "vitest";
import type { GitChangedFile, GitStatusSnapshot } from "@/modules/ai/lib/native";
import {
  buildGitDecoration,
  sameGitDecoration,
  statusColorClass,
  statusLetter,
} from "./gitDecoration";

function file(partial: Partial<GitChangedFile> & { path: string }): GitChangedFile {
  return {
    originalPath: null,
    indexStatus: " ",
    worktreeStatus: " ",
    staged: false,
    unstaged: false,
    untracked: false,
    statusLabel: "",
    ...partial,
  };
}

function snapshot(
  repoRoot: string,
  changedFiles: GitChangedFile[],
): GitStatusSnapshot {
  return {
    repoRoot,
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    isDetached: false,
    truncated: false,
    changedFiles,
  };
}

describe("buildGitDecoration", () => {
  it("returns empty decoration for null or clean status", () => {
    expect(buildGitDecoration(null).files.size).toBe(0);
    expect(buildGitDecoration(snapshot("/repo", [])).dirtyDirs.size).toBe(0);
  });

  it("maps repo-relative paths onto absolute keys", () => {
    const dec = buildGitDecoration(
      snapshot("/repo", [file({ path: "src/a.ts", worktreeStatus: "M" })]),
    );
    expect(dec.files.get("/repo/src/a.ts")).toBe("modified");
    expect(dec.files.has("src/a.ts")).toBe(false);
  });

  it("classifies index/worktree status pairs", () => {
    const dec = buildGitDecoration(
      snapshot("/r", [
        file({ path: "m.ts", worktreeStatus: "M" }),
        file({ path: "a.ts", indexStatus: "A" }),
        file({ path: "d.ts", worktreeStatus: "D" }),
        file({ path: "u.ts", indexStatus: "?", worktreeStatus: "?", untracked: true }),
        file({ path: "r.ts", indexStatus: "R" }),
      ]),
    );
    expect(dec.files.get("/r/m.ts")).toBe("modified");
    expect(dec.files.get("/r/a.ts")).toBe("added");
    expect(dec.files.get("/r/d.ts")).toBe("deleted");
    expect(dec.files.get("/r/u.ts")).toBe("untracked");
    expect(dec.files.get("/r/r.ts")).toBe("modified");
  });

  it("rolls a dirty file up through every ancestor dir to the root", () => {
    const dec = buildGitDecoration(
      snapshot("/repo", [file({ path: "a/b/c.ts", worktreeStatus: "M" })]),
    );
    expect([...dec.dirtyDirs].sort()).toEqual(["/repo/a", "/repo/a/b"]);
  });

  it("does not mark the repo root as a dirty dir", () => {
    const dec = buildGitDecoration(
      snapshot("/repo", [file({ path: "top.ts", worktreeStatus: "M" })]),
    );
    expect(dec.dirtyDirs.has("/repo")).toBe(false);
    expect(dec.dirtyDirs.size).toBe(0);
  });

  it("never climbs above the repo root", () => {
    const dec = buildGitDecoration(
      snapshot("/home/u/repo", [
        file({ path: "a/b.ts", worktreeStatus: "M" }),
      ]),
    );
    expect([...dec.dirtyDirs]).toEqual(["/home/u/repo/a"]);
  });

  it("tolerates a repo root with a trailing slash", () => {
    const dec = buildGitDecoration(
      snapshot("/repo/", [file({ path: "src/x.ts", worktreeStatus: "M" })]),
    );
    expect(dec.files.get("/repo/src/x.ts")).toBe("modified");
  });
});

describe("sameGitDecoration", () => {
  const snap = (root: string, files: GitChangedFile[]) =>
    buildGitDecoration(snapshot(root, files));

  it("treats two builds of identical status as equal", () => {
    const a = snap("/r", [file({ path: "a.ts", worktreeStatus: "M" })]);
    const b = snap("/r", [file({ path: "a.ts", worktreeStatus: "M" })]);
    expect(a).not.toBe(b); // distinct objects
    expect(sameGitDecoration(a, b)).toBe(true);
  });

  it("two empty decorations are equal", () => {
    expect(sameGitDecoration(snap("/r", []), snap("/r", []))).toBe(true);
  });

  it("detects a changed status code on the same path", () => {
    const a = snap("/r", [file({ path: "a.ts", worktreeStatus: "M" })]);
    const b = snap("/r", [file({ path: "a.ts", indexStatus: "A" })]);
    expect(sameGitDecoration(a, b)).toBe(false);
  });

  it("detects an added file", () => {
    const a = snap("/r", [file({ path: "a.ts", worktreeStatus: "M" })]);
    const b = snap("/r", [
      file({ path: "a.ts", worktreeStatus: "M" }),
      file({ path: "b.ts", worktreeStatus: "M" }),
    ]);
    expect(sameGitDecoration(a, b)).toBe(false);
  });

  it("detects a removed file", () => {
    const a = snap("/r", [
      file({ path: "a.ts", worktreeStatus: "M" }),
      file({ path: "b.ts", worktreeStatus: "M" }),
    ]);
    const b = snap("/r", [file({ path: "a.ts", worktreeStatus: "M" })]);
    expect(sameGitDecoration(a, b)).toBe(false);
  });
});

describe("status display helpers", () => {
  it("maps each status to a stable letter", () => {
    expect(statusLetter("modified")).toBe("M");
    expect(statusLetter("added")).toBe("A");
    expect(statusLetter("deleted")).toBe("D");
    expect(statusLetter("untracked")).toBe("U");
  });

  it("shares the added/untracked color", () => {
    expect(statusColorClass("added")).toBe(statusColorClass("untracked"));
    expect(statusColorClass("modified")).not.toBe(statusColorClass("deleted"));
  });
});
