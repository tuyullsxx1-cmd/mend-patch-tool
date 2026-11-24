# mend — one patch tool for every AI edit format

[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tuyullsxx1-cmd/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tuyullsxx1-cmd/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an AI-written edit to a tree of text files. It reads a patch
from a file argument or stdin and applies it atomically: either every edit
lands, or none of them does.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `--format=NAME` — `auto` (default), `unified`, `search-replace`, `v4a`, `json`.
- `--check` — dry run: same output and exit code, no files written.
- `--strict` — tier 0 (exact) matching only.
- `PATCH` — a patch file, `-` or absent for stdin.
- `--` ends the options.

## Formats

- **unified** — `diff --git` / `---`+`+++` diffs. Wrong line numbers are
  tolerated (a hunk lands on the occurrence nearest its stated position);
  `\ No newline at end of file` controls the final break; creation,
  deletion and rename are supported.
- **search-replace** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`
  blocks. The path is the nearest non-blank, non-fence line before the
  block; an empty old block creates a file.
- **v4a** — `*** Begin Patch` / `*** End Patch` with Add/Delete/Update File
  sections, `*** Move to:` renames, and `@@` anchors with a moving cursor.
- **json** — an array of edit objects, or one JSON object per line
  (`create`, `str_replace`, `insert`).

## Matching

Each edit is matched at the first tier that has an occurrence: tier 0
exact, tier 1 (trailing whitespace ignored), tier 2 (leading and trailing
whitespace ignored). Context lines are written back as the file's own
matched line, so indentation is preserved.

## Exit codes and output

- `0` — one line per changed file (`A`/`D`/`M`, or `R <old> -> <new>` for a
  move), then `ok: <n> files`.
- `1` — one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`. No file is written.
- `2` — `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <N>`.

## Files

- `main.ts` — the whole tool (Node 22, standard library only).
- `runner.ts` — the kit's trial runner, unchanged.

Practice score: 1000/1000 (100 of 100 checks: unified 30/30,
search_replace 20/20, v4a 20/20, json 15/15, cli 15/15).
