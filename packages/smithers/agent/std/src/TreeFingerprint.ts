/**
 * The identity of one directory tree, measured where the tree is.
 *
 * `@smthrs/agent/WorkspaceObservation` measures the host workspace around
 * every frame so the loop's mutation accounting is a fact rather than a
 * claim. A command routed into a container writes to a filesystem that walk
 * never sees: the SWE-bench rig bind-mounts the checkout into its container,
 * so a container edit lands on the host too, but a container Harbor or Pier
 * starts has no such mount, and every edit an agent made there read as an
 * idle frame. Measured 2026-09-22 on Terminal-Bench 4.0: `read_only_cap`
 * ended one run after twenty-four frames of container writes, and the claim
 * judge refused another's completion as "work this run never recorded".
 *
 * This module is the same measurement taken inside the container: one POSIX
 * shell script that lists every kept file under a directory with its size and
 * modification time, in sorted order, and prints one checksum of the listing.
 * `bash` runs it through the container transport before and after a
 * containerised command and reports whether the two answers differ under the
 * reserved {@link key}. The harness reads that key as a measured write, the
 * way it reads `invalidProbe` as a measured refusal.
 *
 * The same properties as the host walk, and the same stated limits:
 *
 * - **Identity, not content.** Size and mtime per file; a rewrite that
 *   restores both is invisible.
 * - **Pruning is the signal.** {@link defaultPrune} and
 *   {@link defaultIgnoreSuffixes} are the one list both measurements use, so
 *   a derived artifact the host walk skips is skipped here too.
 * - **A partial listing says so.** The listing stops at {@link maxPaths}, and
 *   a measurement that stopped there reports `complete: false`; `bash` then
 *   reports nothing rather than a guess.
 * - **Every tool it needs is POSIX or busybox.** `find -prune`, `stat -c`,
 *   `sort`, `head`, `cksum` and `grep -c` are in every Linux base image this
 *   has been run against, GNU and busybox alike. A container that lacks one
 *   answers with a non-zero exit, which is read as "unmeasured".
 *
 * @since 1.0.0
 */

import * as Prune from "./internal/Prune.ts"

/**
 * The reserved output key a flow reports a measured write under.
 *
 * A wire contract with the harness rather than a shared type, exactly as
 * `Probe.key` is: `@smthrs/harness` reads this key off a `Schema.Json` result
 * and must not depend on the tool library to do it. `true` means the tree the
 * call targeted differed after the call from before it; `false` means it was
 * measured and held still; absent means it was not measured.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const key = "mutated"

/**
 * Directory names never descended into.
 *
 * Every entry is a place a tool writes derived state while the run is working:
 * version-control internals, dependency trees, and the caches Python, Node,
 * Rust and their test runners keep beside the sources. A run that changes only
 * these has changed nothing it will be judged on.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultPrune: ReadonlyArray<string> = [
  ...Prune.repositoryDirectories,
  // Build and environment directories a search still reads, since a project
  // may keep sources under these names, but a measurement leaves out.
  "venv",
  "target"
]

/**
 * File and directory name suffixes left out of a measurement.
 *
 * Compiled output is the case that matters: several SWE-bench projects build
 * extensions in place, which drops `.so` files next to the `.py` files they
 * came from. Those move whenever the run executes its test suite, and
 * counting them would report every probe as an edit.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultIgnoreSuffixes: ReadonlyArray<string> = [
  ".pyc",
  ".pyo",
  ".pyd",
  ".so",
  ".o",
  ".a",
  ".dylib",
  ".class",
  ".egg-info"
]

/**
 * The largest number of files one measurement covers.
 *
 * The same bound the host walk uses, for the same reason: a listing that
 * stopped here covers a prefix chosen by sort order, and a prefix holding
 * still says nothing about the files being edited outside it.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxPaths = 50_000

/**
 * One measurement, as {@link parse} reads it off the script's output.
 *
 * @category models
 * @since 1.0.0
 */
export interface Measurement {
  /** The checksum of the whole listing; equal for two measurements of an unchanged tree. */
  readonly digest: string
  /** How many files the listing covered. */
  readonly paths: number
  /** Whether the listing covered the whole tree rather than a bounded prefix. */
  readonly complete: boolean
}

/** One name, single-quoted for a POSIX shell. Every name here is a constant without quotes in it. */
const quoted = (name: string): string => `'${name.replaceAll("'", `'\\''`)}'`

/**
 * The POSIX shell script that measures the current directory.
 *
 * Prints two lines: `cksum`'s `<crc> <bytes>` over the sorted listing, then
 * the number of listing lines. The listing is capped one past
 * {@link maxPaths} so the count alone says whether the bound was reached.
 * Errors from `find` and `stat` are discarded: a path that vanished mid-walk
 * is movement the next measurement reports, and a file the shell may not
 * stat is one it could not have measured either way.
 *
 * @category constructors
 * @since 1.0.0
 */
export const script = (options: {
  readonly prune?: ReadonlyArray<string> | undefined
  readonly ignoreSuffixes?: ReadonlyArray<string> | undefined
} = {}): string => {
  const prune = (options.prune ?? defaultPrune).map((name) => `-name ${quoted(name)}`).join(" -o ")
  const skipped = (options.ignoreSuffixes ?? defaultIgnoreSuffixes)
    .map((suffix) => `! -name ${quoted(`*${suffix}`)}`)
    .join(" ")
  return [
    "set -f",
    `L=$(find . -xdev \\( ${prune} \\) -prune -o -type f ${skipped} -exec stat -c '%s %Y %n' {} + 2>/dev/null | LC_ALL=C sort | head -n ${
      maxPaths + 1
    })`,
    `printf '%s' "$L" | cksum`,
    `printf '%s' "$L" | grep -c ''`
  ].join("\n")
}

/**
 * Reads one measurement off the script's standard output.
 *
 * `undefined` for anything that is not two well-formed lines: the script did
 * not run, a tool it needs is missing, or the output was cut. An unmeasured
 * tree is reported as unmeasured, never as unchanged.
 *
 * @category conversions
 * @since 1.0.0
 */
export const parse = (stdout: string): Measurement | undefined => {
  const lines = stdout.trim().split("\n").map((line) => line.trim())
  if (lines.length !== 2) return undefined
  const checksum = /^(\d+) (\d+)$/.exec(lines[0]!)
  const count = /^(\d+)$/.exec(lines[1]!)
  if (checksum === null || count === null) return undefined
  const paths = Number(count[1])
  const bounded = paths > maxPaths
  return {
    digest: `${checksum[1]}:${checksum[2]}`,
    paths: bounded ? maxPaths : paths,
    complete: !bounded
  }
}

/**
 * Whether two measurements say the tree moved, or nothing at all.
 *
 * `true` and `false` are answers; `undefined` is the honest reading whenever
 * either measurement is absent or bounded, because a prefix that held still
 * is not a tree that held still.
 *
 * @category conversions
 * @since 1.0.0
 */
export const moved = (
  before: Measurement | undefined,
  after: Measurement | undefined
): boolean | undefined =>
  before === undefined || after === undefined || !before.complete || !after.complete
    ? undefined
    : before.digest !== after.digest
