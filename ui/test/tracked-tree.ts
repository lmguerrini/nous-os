import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { TRACKED_TREE_STATUS_COMMAND } from "#browser/parity-contract.ts";

const execFileAsync = promisify(execFile);

/** One reading of the identity of the tracked WORKTREE, not of the git index. */
export type TrackedTreeState = {
  readonly sha256: string;
  readonly statusPorcelain: string;
};

/**
 * Digests the bytes an evidence run actually executed. `git ls-files -s | shasum` was used here once
 * and was wrong: it hashes the INDEX, so an unstaged edit runs different bytes while the recorded
 * digest still reads as the clean candidate's. Lengths are framed so no two path/content splits can
 * collide.
 */
export async function currentTrackedTreeState(): Promise<TrackedTreeState> {
  const repositoryDirectory = [".."].join("/");
  const [{ stdout: trackedPaths }, { stdout: statusPorcelain }] = await Promise.all([
    execFileAsync("git", ["ls-files", "-z"], { cwd: repositoryDirectory, encoding: "utf8" }),
    execFileAsync("git", trackedTreeStatusArguments(), { cwd: repositoryDirectory, encoding: "utf8" }),
  ]);
  const hash = createHash("sha256");
  for (const path of trackedPaths.split("\0")) {
    if (path === "") {
      continue;
    }
    const pathBytes = Buffer.from(path, "utf8");
    const contents = await readFile(`${repositoryDirectory}/${path}`);
    hash.update(uint64be(pathBytes.length));
    hash.update(pathBytes);
    hash.update(uint64be(contents.length));
    hash.update(contents);
  }
  return { sha256: hash.digest("hex"), statusPorcelain };
}

function uint64be(value: number): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

/**
 * `TRACKED_TREE_STATUS_COMMAND` names the whole command, program included. Splitting it straight
 * into an argument list re-passes `git` as git's own first argument, which fails with
 * `git: 'git' is not a git command` — so the status reading threw, and with it the tree identity
 * this artifact is bound by. It went unnoticed because no evidence had been regenerated since the
 * identity was rewritten. The program name is dropped here, once, and asserted.
 */
function trackedTreeStatusArguments(): readonly string[] {
  const [program, ...args] = TRACKED_TREE_STATUS_COMMAND.split(" ");
  if (program !== "git" || args.length === 0) {
    throw new Error(`tracked-tree status command is not a git invocation: ${TRACKED_TREE_STATUS_COMMAND}`);
  }
  return args;
}
