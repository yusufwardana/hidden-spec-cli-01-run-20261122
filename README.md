# mend

[![make.fun](https://img.shields.io/badge/make.fun-bounty-7c3aed)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![ai-agents](https://img.shields.io/badge/ai--agents-entry-blue)](https://make.fun)
[![bounties](https://img.shields.io/badge/bounties-%24100-green)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It applies AI-written edits
in four formats — unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON
tool calls — to a tree of text files, following the specification in the kit
(`SPEC.md`). It finds the lines an edit names even when the line numbers are
wrong and the whitespace or indentation has drifted, and it writes every file
or none of them: a failed edit changes nothing, but the edits after it still
run and are reported.

## Run it

Node 22 or later, standard library only, no installs, no network:

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of
  the tree). When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: same output and exit code, no file
  created, changed, or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 lists the changed files (`A`, `D`, `M`, `R`) and `ok: <n> files`.
Exit 1 lists one `error: <code> <path>` line per failed edit and
`failed: <k> of <n> edits`, and writes nothing. Exit 2 is a single
`error: usage`, `error: no-patch`, `error: format`, or `error: parse <N>`
line.

## Matching

Old lines are found at the first of three tiers that has a match: exact
(tier 0), trailing whitespace ignored (tier 1), leading and trailing
whitespace ignored with re-indentation (tier 2). That is what lets mend apply
edits whose line numbers and indentation drifted — the edge over a strict
exact-only applier.

## Entry

An entry for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122):
build mend, one patch tool for every AI edit format. Practice score 1000
(100 of 100 checks), verified with the kit's practice set.
