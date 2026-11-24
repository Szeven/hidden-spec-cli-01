# mend: one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Szeven/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Szeven/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats, and mend reads them all: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Every file is changed or nothing is.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the patch file, relative to the working directory. When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit codes: `0` when the tree is written (one line per changed path, then `ok: <n> files`), `1` when edits failed (one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`, and nothing is written), `2` on a usage, missing-patch, format or parse error.

## How it matches

Old lines are found at the first of three tiers at which they occur at least once: tier 0 (every line equal), tier 1 (trailing spaces and tabs ignored), tier 2 (leading and trailing spaces and tabs ignored). At tier 2 the new lines are re-indented to the file's own indentation, and a context line is always written as the file's own matched line, never the patch's. Unified hunks take the occurrence nearest their (possibly wrong) line number; SEARCH/REPLACE blocks fail as ambiguous when the old lines occur more than once; V4A chunks walk a cursor through the file from their anchor.

## The files

- `main.ts`: the CLI (Node 22, standard library alone). It does the command line, output and exit codes, safe paths, format detection, JSON edits and the all-or-nothing write, and hands a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `impl.ts`: the unified diff, SEARCH/REPLACE and V4A readers, and the three-tier line matching.
- `runner.ts`: the kit's runner. In a trial it reads the checks from the environment, runs `node main.ts` on each one in a fresh directory, and posts the results.
- `check.ts`: the practice set on your own machine:

      node check.ts <practice.json>
      node check.ts <practice.json> u-offset s-basic

  It prints every check the entry gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification. Every sentence of it is a requirement; the hidden checks test sentences the practice set does not.

## Practice score

100 of 100 practice checks pass (practice score 1000), including as user 65534 from a foreign working directory.

---

Built for the [hidden-spec-cli-01-run-20261122 bounty on make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) — build the best `mend`, one patch tool for every AI edit format.
