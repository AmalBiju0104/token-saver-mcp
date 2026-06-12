# Benchmark system

This document explains how the token-saver-mcp benchmark is structured, what it measures, and how to interpret results.

## Running it

```bash
node benchmark/run.js           # pretty-print table to stdout
node benchmark/run.js --json    # machine-readable JSON to stdout
```

Exit code is `0` when all cases pass, `1` when any fail.

---

## What is being measured

Effectiveness has two dimensions:

- **Efficiency** — how many tokens does the tool save?
- **Accuracy** — does the output still contain the essential information?

Each tool has test cases that cover both. Token counts use `cl100k_base` encoding via `tiktoken`, the same encoding Claude uses.

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

## Test cases by tool

### `compress_text` (4 cases)

| Case | What it checks |
|------|---------------|
| `js_with_jsdoc` | JSDoc blocks and inline comments stripped; function names and logic preserved; ≥1 token saved |
| `python_with_docstrings` | Docstrings and `#` comments stripped; `def` lines and logic preserved |
| `minified_code_passthrough` | Already-minified input causes no token growth (≤5% tolerance for trim edge effects) |
| `url_string_not_corrupted` | `https://` URLs inside string literals are preserved; only the trailing `// comment` is stripped |

### `smart_read_file` (5 cases)

| Case | What it checks |
|------|---------------|
| `keyword_hit_large_file` | Keyword found → only surrounding ±30-line window returned; output shorter than full file |
| `keyword_miss_returns_full_file` | Keyword not found → full file returned as-is (safe fallback) |
| `keyword_near_eof` | Keyword in last function → no off-by-one crash; valid string returned |
| `multiple_keywords_union` | Two keywords → both sections present in output (union of windows) |
| `no_keywords_full_file` | Empty keyword list → full file returned (same as no-op) |

### `summarize_output` (4 cases)

| Case | What it checks |
|------|---------------|
| `under_budget_passthrough` | Text under the token budget → returned verbatim, `wasSummarized: false` |
| `long_build_output_truncated` | Long output → truncated, marker appended, within budget + 50 tokens (marker overhead) |
| `priority_lines_preserved` | `FAIL` line in jest output (at ~816 cumulative tokens) is hoisted into the summary via priority-line detection even at a 400-token budget |
| `empty_string` | Empty input → no crash, returns string |

### `count_tokens` (4 cases)

| Case | What it checks |
|------|---------------|
| `known_string` | `"Hello, world!"` → exactly 4 tokens (pre-computed ground truth) |
| `empty_string` | `""` → 0 tokens |
| `unicode_and_emoji` | Mixed Unicode + emoji → positive integer, no crash |
| `linear_scaling` | 100 repetitions ≈ 10× the tokens of 10 repetitions (within 1.5× tolerance for BPE edge effects) |

### `optimize_prompt` (5 cases)

| Case | What it checks |
|------|---------------|
| `filler_stripped_verbose_1` | Filler phrases (`please`, `could you`, `I would like you to`) removed; output shorter |
| `filler_stripped_verbose_2` | Same for a code-review prompt (`please note that`, `due to the fact that`) |
| `filler_stripped_verbose_3` | Same for an AI-preamble prompt (`As an AI language model`, `kindly`, `in the event that`) |
| `clean_prompt_minimal_change` | Technical prompt with no filler → ≤10% token reduction (no over-stripping) |
| `code_snippet_preserved` | Prompt containing a JS code block → `fetch`, `async` keywords intact after optimization |

### `generate_claudeignore` (3 cases)

| Case | What it checks |
|------|---------------|
| `bare_project_defaults` | Output contains all default entries; no extras added when `public/`, `migrations/`, `fixtures/` are absent |
| `project_with_fixtures_dir` | `fixtures/` entry added when that directory exists in the project root |
| `no_duplicate_entries` | All output lines are unique |

---

## How to add a new test case

1. Add a fixture file to `benchmark/fixtures/` if needed.
2. In `benchmark/run.js`, call `run(toolName, caseName, fn)` inside the appropriate `bench*()` function.
3. Inside `fn`, call the tool's helper function directly, write assertions with `assert(condition, label)`, and return `{ before, after, tokenReductionPct, note? }`.

`run()` catches any thrown error and records the case as `FAIL` with the error message — no try/catch needed inside your case.

---

## Interpreting results

- **Reduction %** is `(before - after) / before * 100`. Cases that test correctness rather than compression (e.g. passthrough, structural tests) report 0% and include a note explaining this is expected.
- **Known limitation cases** are written to assert the limitation exists, not to pass despite it. If one of these unexpectedly passes, it likely means the tool was improved and the test should be updated to assert the new positive behavior.
- The per-tool average shown at the bottom of the report only includes cases where reduction > 0, so passthrough and structural cases don't drag the average down.
