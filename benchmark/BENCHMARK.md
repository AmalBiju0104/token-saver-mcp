# Benchmark system

This document explains how the token-saver-mcp benchmark is structured, what it measures, and how to interpret results.

## Running it

```bash
npm run benchmark               # pretty-print table to stdout
node benchmark/run.js --json    # machine-readable JSON to stdout
```

Exit code is `0` when all cases pass, `1` when any fail.

## Architecture

The benchmark imports every helper directly from [`src/lib.js`](../src/lib.js) — the same module the MCP server uses. There is no duplicated logic, so the benchmark can never silently drift from the shipped implementation.

---

## What is being measured

Effectiveness has two dimensions:

- **Efficiency** — how many tokens does the tool save?
- **Accuracy** — does the output still contain the essential information?

Each tool has test cases that cover both. Token counts use `cl100k_base` encoding via `tiktoken`. Note this is OpenAI's encoding — Claude's tokenizer differs, so absolute counts are approximations; the relative reduction percentages are what matter.

---

## Fixtures

Real-world inputs stored in `benchmark/fixtures/`:

| File | Used by | Description |
|------|---------|-------------|
| `sample.js` | `compress_text`, `smart_read_file` | ~120-line JS module with JSDoc, inline comments, and multiple named functions |
| `sample.py` | `compress_text`, `smart_read_file` | ~160-line Python ETL pipeline with docstrings and `#` comments |
| `npm-output.txt` | `summarize_output` | Realistic `npm install` + `webpack` + `jest` output including a test failure |
| `prompts.json` | `optimize_prompt` | 5 prompts: 3 verbose (with filler phrases), 1 clean technical, 1 with an inline code snippet |

---

## Test cases by tool (34 total)

### `compress_text` (5 cases)

Comment stripping is implemented as a character-level state machine that tracks string/comment context, not regexes.

| Case | What it checks |
|------|---------------|
| `js_with_jsdoc` | JSDoc blocks and inline comments stripped; function names and logic preserved |
| `python_with_docstrings` | `#` comments and blank lines stripped; `def` lines and logic preserved |
| `minified_code_passthrough` | Already-minified input causes no token growth (≤5% tolerance for trim edge effects) |
| `url_string_not_corrupted` | `https://` inside a string literal is preserved; only the trailing `// comment` is stripped |
| `hash_inside_string_preserved` | `"#hashtag"` inside a string is preserved; the real `# comment` after it is stripped |

### `smart_read_file` (7 cases)

| Case | What it checks |
|------|---------------|
| `keyword_hit_large_file` | Keyword inside a function → the complete enclosing function is returned; unrelated functions excluded |
| `keyword_miss_returns_full_file` | Keyword not found → full file returned as-is (safe fallback) |
| `keyword_near_eof` | Keyword in last function → no off-by-one crash; valid output |
| `multiple_keywords_union` | Two keywords → both extracts present in output |
| `no_keywords_full_file` | Empty keyword list → full file returned |
| `enclosing_function_extracted` | Structure-aware extraction returns one complete function and excludes its neighbors — tighter than the old ±30-line window |
| `line_numbers_option` | `lineNumbers: true` prefixes each line with its number (opt-in; costs extra tokens) |

### `summarize_output` (6 cases)

| Case | What it checks |
|------|---------------|
| `under_budget_passthrough` | Text under the token budget → returned verbatim, `wasSummarized: false` |
| `long_build_output_truncated` | Long output → truncated with marker; budget reserves space for markers so output stays within budget |
| `priority_lines_preserved` | The jest `FAIL` line, deep in the output past the head-truncation point, is hoisted into the summary by priority-line detection |
| `tail_preserved` | The final `Tests:` / `Time:` summary lines of the log survive truncation (tail pass) |
| `duplicate_lines_collapsed` | A warning repeated 30× appears once, annotated `[×30]` |
| `empty_string` | Empty input → no crash |

### `count_tokens` (4 cases)

| Case | What it checks |
|------|---------------|
| `known_string` | `"Hello, world!"` → exactly 4 tokens (pre-computed ground truth) |
| `empty_string` | `""` → 0 tokens |
| `unicode_and_emoji` | Mixed Unicode + emoji → positive integer, no crash |
| `linear_scaling` | 100 repetitions ≈ 10× the tokens of 10 repetitions (tolerance for BPE edge effects) |

### `optimize_prompt` (7 cases)

| Case | What it checks |
|------|---------------|
| `filler_stripped_verbose_1/2/3` | Filler phrases (`please`, `could you`, `kindly`, `note that`, …) removed; output shorter |
| `clean_prompt_minimal_change` | Technical prompt with no filler → ≤10% token reduction (no over-stripping) |
| `code_snippet_preserved` | Code in a fenced block survives; filler in the prose around it is removed |
| `code_fence_filler_untouched` | The word "please" inside a code fence (comment, string, identifier) is NOT stripped |
| `punctuation_artifacts_cleaned` | Filler removal leaves no `" ,"`, double spaces, or orphan commas behind |

### `generate_claudeignore` (5 cases)

| Case | What it checks |
|------|---------------|
| `bare_project_defaults` | Output contains all default entries; no extras when marker dirs/files are absent |
| `project_with_fixtures_dir` | `fixtures/` entry added when that directory exists |
| `no_duplicate_entries` | All output lines are unique |
| `rust_project_target_ignored` | `Cargo.toml` present → `target/` added |
| `gitignore_entries_seeded` | Entries from an existing `.gitignore` are included; comments and `!negations` are not |

---

## How to add a new test case

1. Add a fixture file to `benchmark/fixtures/` if needed.
2. In `benchmark/run.js`, call `run(toolName, caseName, fn)` inside the appropriate `bench*()` function.
3. Inside `fn`, call the helper imported from `src/lib.js`, write assertions with `assert(condition, label)`, and return `{ before, after, tokenReductionPct, note? }`.

`run()` catches any thrown error and records the case as `FAIL` with the error message — no try/catch needed inside your case.

If you add a new helper to the server, export it from `src/lib.js` and import it here — never copy the implementation into the benchmark.

---

## Interpreting results

- **Reduction %** is `(before - after) / before * 100`. Cases that test correctness rather than compression (e.g. passthrough, structural tests) report 0% and include a note explaining this is expected.
- The per-tool average shown at the bottom of the report only includes cases where reduction > 0, so passthrough and structural cases don't drag the average down.
- Absolute token counts are `cl100k_base` approximations of Claude's tokenizer; treat the relative percentages as the meaningful signal.
