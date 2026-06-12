#!/usr/bin/env node
/**
 * Benchmark runner for token-saver-mcp.
 *
 * Tests each tool for:
 *   - Token reduction (efficiency)
 *   - Correctness / meaning preservation (accuracy)
 *
 * Helpers are imported directly from src/lib.js — the same code the MCP
 * server ships — so the benchmark can never drift from the implementation.
 *
 * Usage:
 *   node benchmark/run.js
 *   node benchmark/run.js --json   (machine-readable output)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  countTokens,
  compressText,
  extractRelevantLines,
  summarizeLongOutput,
  summarizeDiff,
  optimizePrompt,
  generateClaudeignore,
  isProbablyBinary,
} from "../src/lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const JSON_MODE = process.argv.includes("--json");

// ── Result accumulator ────────────────────────────────────────────────────────

const results = [];

function assert(condition, label) {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
}

function run(tool, caseName, fn) {
  try {
    const r = fn();
    results.push({ tool, case: caseName, status: "PASS", ...r });
  } catch (err) {
    results.push({ tool, case: caseName, status: "FAIL", error: err.message, tokenReductionPct: 0 });
  }
}

function reduction(before, after) {
  return before > 0 ? Math.round(((before - after) / before) * 100) : 0;
}

// ── compress_text ─────────────────────────────────────────────────────────────

function benchCompressText() {
  // Case 1: JS file with heavy JSDoc + inline comments
  run("compress_text", "js_with_jsdoc", () => {
    const original = fs.readFileSync(path.join(FIXTURES, "sample.js"), "utf8");
    const compressed = compressText(original);
    const before = countTokens(original);
    const after = countTokens(compressed);

    assert(after < before, "compressed should have fewer tokens");
    assert(compressed.includes("createUser"), "function name preserved");
    assert(compressed.includes("bcrypt.hash"), "logic preserved");
    assert(!compressed.includes("@param"), "JSDoc stripped");
    assert(!compressed.includes("@returns"), "JSDoc stripped");

    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 2: Python file with docstrings + # comments
  run("compress_text", "python_with_docstrings", () => {
    const original = fs.readFileSync(path.join(FIXTURES, "sample.py"), "utf8");
    const compressed = compressText(original);
    const before = countTokens(original);
    const after = countTokens(compressed);

    assert(after < before, "compressed should have fewer tokens");
    assert(compressed.includes("def ingest_payload"), "function def preserved");
    assert(compressed.includes("json.loads"), "logic preserved");

    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 3: Already-minified code — should change nothing meaningful
  run("compress_text", "minified_code_passthrough", () => {
    const original = `const f=(x)=>x*2;const g=(x)=>x+1;`;
    const compressed = compressText(original);
    const before = countTokens(original);
    const after = countTokens(compressed);

    assert(compressed.includes("const f"), "content intact");
    assert(after <= before * 1.05, "no significant token growth on minified input");

    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 4: URL inside a string literal — must not be corrupted
  run("compress_text", "url_string_not_corrupted", () => {
    const original = `const url = "https://example.com/api/v2"; // endpoint`;
    const compressed = compressText(original);

    assert(compressed.includes("https://example.com/api/v2"), "URL inside string preserved");
    assert(!compressed.includes("endpoint"), "trailing comment stripped");

    const before = countTokens(original);
    const after = countTokens(compressed);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 5: # inside a string literal — must not be treated as a comment
  run("compress_text", "hash_inside_string_preserved", () => {
    const original = `tag = "#hashtag"  # strip this comment`;
    const compressed = compressText(original);

    assert(compressed.includes('"#hashtag"'), "# inside string preserved");
    assert(!compressed.includes("strip this comment"), "real # comment stripped");

    const before = countTokens(original);
    const after = countTokens(compressed);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 6: CSS hex colors after whitespace — must not be treated as # comments
  run("compress_text", "css_hex_color_preserved", () => {
    const original = `.btn { color: #fff; background: #1a2b3c; } /* theme colors */`;
    const compressed = compressText(original);

    assert(compressed.includes("#fff"), "hex color after space preserved");
    assert(compressed.includes("#1a2b3c"), "second hex color preserved");
    assert(!compressed.includes("theme colors"), "block comment stripped");

    const before = countTokens(original);
    const after = countTokens(compressed);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 7: Bare URL outside any string — :// must not trigger the // comment rule
  run("compress_text", "bare_url_in_prose_preserved", () => {
    const original = `Visit https://example.com/docs for setup // remove this note`;
    const compressed = compressText(original);

    assert(compressed.includes("https://example.com/docs"), "bare URL preserved");
    assert(!compressed.includes("remove this note"), "real // comment stripped");

    const before = countTokens(original);
    const after = countTokens(compressed);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 8: Comments inside template-literal ${} expressions are stripped
  run("compress_text", "template_literal_expr_comment_stripped", () => {
    const original = "const msg = `total: ${items.length // count of items\n} done`;";
    const compressed = compressText(original);

    assert(!compressed.includes("count of items"), "comment inside ${} stripped");
    assert(compressed.includes("items.length"), "expression code preserved");
    assert(compressed.includes("done`"), "template literal closes correctly");

    const before = countTokens(original);
    const after = countTokens(compressed);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 9: HTML comments stripped, markup preserved
  run("compress_text", "html_comment_stripped", () => {
    const original = `<div class="header">Hello</div>\n<!-- TODO: remove this banner -->\n<span>World</span>`;
    const compressed = compressText(original);

    assert(!compressed.includes("TODO"), "HTML comment stripped");
    assert(compressed.includes('<div class="header">Hello</div>'), "markup before comment preserved");
    assert(compressed.includes("<span>World</span>"), "markup after comment preserved");

    const before = countTokens(original);
    const after = countTokens(compressed);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });
}

// ── smart_read_file ───────────────────────────────────────────────────────────

function benchSmartReadFile() {
  // Case 1: Keyword found in a large file — only relevant section returned
  run("smart_read_file", "keyword_hit_large_file", () => {
    const original = fs.readFileSync(path.join(FIXTURES, "sample.js"), "utf8");
    const result = extractRelevantLines(original, ["loginUser"]);
    const before = countTokens(original);
    const after = countTokens(result);

    assert(result.includes("loginUser"), "keyword present in output");
    assert(after < before, "output shorter than full file");
    assert(result.includes("bcrypt.compare"), "enclosing function body included");
    assert(!result.includes("async function createUser"), "unrelated function excluded");

    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 2: Keyword not found — should return full file (fallback)
  run("smart_read_file", "keyword_miss_returns_full_file", () => {
    const original = fs.readFileSync(path.join(FIXTURES, "sample.js"), "utf8");
    const result = extractRelevantLines(original, ["nonexistent_xyz_keyword"]);

    assert(result === original, "full file returned on keyword miss");

    const tokens = countTokens(original);
    return { before: tokens, after: tokens, tokenReductionPct: 0, note: "expected 0% reduction on miss" };
  });

  // Case 3: Keyword near EOF — no off-by-one, valid output
  run("smart_read_file", "keyword_near_eof", () => {
    const original = fs.readFileSync(path.join(FIXTURES, "sample.js"), "utf8");
    const result = extractRelevantLines(original, ["deleteUser"]);

    assert(result.includes("deleteUser"), "last function found");
    assert(typeof result === "string" && result.length > 0, "valid string output");

    const before = countTokens(original);
    const after = countTokens(result);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 4: Multiple keywords — union of extracts
  run("smart_read_file", "multiple_keywords_union", () => {
    const original = fs.readFileSync(path.join(FIXTURES, "sample.py"), "utf8");
    const result = extractRelevantLines(original, ["ingest_payload", "write_to_clickhouse"]);

    assert(result.includes("ingest_payload"), "first keyword found");
    assert(result.includes("write_to_clickhouse"), "second keyword found");

    const before = countTokens(original);
    const after = countTokens(result);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 5: No keywords provided — full file returned
  run("smart_read_file", "no_keywords_full_file", () => {
    const original = fs.readFileSync(path.join(FIXTURES, "sample.js"), "utf8");
    const result = extractRelevantLines(original, []);

    assert(result === original, "full file returned when no keywords given");

    const tokens = countTokens(original);
    return { before: tokens, after: tokens, tokenReductionPct: 0, note: "expected 0% when no keywords" };
  });

  // Case 6: Structure-aware extraction — complete enclosing function, not a blunt ±30 window
  run("smart_read_file", "enclosing_function_extracted", () => {
    const original = fs.readFileSync(path.join(FIXTURES, "sample.py"), "utf8");
    const result = extractRelevantLines(original, ["validate_measurements"]);

    assert(result.includes("def validate_measurements"), "function definition included");
    assert(result.includes("math.isfinite"), "full function body included");
    assert(!result.includes("def write_to_clickhouse"), "neighboring function excluded (tighter than ±30 window)");

    const before = countTokens(original);
    const after = countTokens(result);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 7: Optional line numbers
  run("smart_read_file", "line_numbers_option", () => {
    const original = fs.readFileSync(path.join(FIXTURES, "sample.js"), "utf8");
    const result = extractRelevantLines(original, ["loginUser"], { lineNumbers: true });

    assert(/^\d+: /m.test(result), "lines prefixed with line numbers");

    const before = countTokens(original);
    const after = countTokens(result);
    return { before, after, tokenReductionPct: reduction(before, after), note: "line numbers cost extra tokens" };
  });

  // Case 8: TypeScript interface recognized as an enclosing block
  run("smart_read_file", "typescript_interface_extracted", () => {
    const original = [
      "export interface UserProfile {",
      "  id: string;",
      "  email: string;",
      "  displayName: string;",
      "}",
      "",
      "export function unrelatedHelper() {",
      "  return 42;",
      "}",
    ].join("\n");
    const result = extractRelevantLines(original, ["displayName"]);

    assert(result.includes("interface UserProfile"), "interface definition included");
    assert(result.includes("id: string"), "full interface body included");
    assert(!result.includes("unrelatedHelper"), "neighboring function excluded");

    const before = countTokens(original);
    const after = countTokens(result);
    return { before, after, tokenReductionPct: reduction(before, after), note: "tiny fixture — correctness, not savings" };
  });

  // Case 9: Go func recognized as an enclosing block
  run("smart_read_file", "go_function_extracted", () => {
    const original = [
      "package main",
      "",
      "func fetchRecords(db *sql.DB) ([]Record, error) {",
      '\trows, err := db.Query("SELECT * FROM records")',
      "\tif err != nil {",
      "\t\treturn nil, err",
      "\t}",
      "\treturn scanRecords(rows), nil",
      "}",
      "",
      "func unrelatedThing() {",
      '\tfmt.Println("hi")',
      "}",
    ].join("\n");
    const result = extractRelevantLines(original, ["db.Query"]);

    assert(result.includes("func fetchRecords"), "Go func definition included");
    assert(result.includes("return scanRecords(rows), nil"), "full func body included");
    assert(!result.includes("unrelatedThing"), "neighboring func excluded");

    const before = countTokens(original);
    const after = countTokens(result);
    return { before, after, tokenReductionPct: reduction(before, after), note: "tiny fixture — correctness, not savings" };
  });

  // Case 10: Rust fn recognized as an enclosing block
  run("smart_read_file", "rust_function_extracted", () => {
    const original = [
      "use std::fs;",
      "",
      "pub fn parse_config(input: &str) -> Result<Config, ParseError> {",
      "    let raw: toml::Value = input.parse()?;",
      "    Config::from_value(raw)",
      "}",
      "",
      "pub fn unrelated_helper() -> u32 {",
      "    42",
      "}",
    ].join("\n");
    const result = extractRelevantLines(original, ["toml::Value"]);

    assert(result.includes("pub fn parse_config"), "Rust fn definition included");
    assert(result.includes("Config::from_value"), "full fn body included");
    assert(!result.includes("unrelated_helper"), "neighboring fn excluded");

    const before = countTokens(original);
    const after = countTokens(result);
    return { before, after, tokenReductionPct: reduction(before, after), note: "tiny fixture — correctness, not savings" };
  });

  // Case 11: Binary detection — null bytes flagged, plain text not
  run("smart_read_file", "binary_detection", () => {
    const pngLike = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
    assert(isProbablyBinary(pngLike), "PNG-like bytes flagged as binary");
    assert(!isProbablyBinary(Buffer.from("plain text file\nwith several lines\n")), "text not flagged");
    return { before: 0, after: 0, tokenReductionPct: 0, note: "structural test" };
  });
}

// ── summarize_output ──────────────────────────────────────────────────────────

function benchSummarizeOutput() {
  // Case 1: Short text (under budget) — returned verbatim
  run("summarize_output", "under_budget_passthrough", () => {
    const text = "Build succeeded in 3.2s\n2 warnings, 0 errors";
    const result = summarizeLongOutput(text, 400);

    assert(!result.wasSummarized, "should not summarize short text");
    assert(result.summary === text, "text returned verbatim");

    const tokens = countTokens(text);
    return { before: tokens, after: tokens, tokenReductionPct: 0, note: "expected passthrough" };
  });

  // Case 2: Long build output — truncated, marker present, within budget
  run("summarize_output", "long_build_output_truncated", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "npm-output.txt"), "utf8");
    const budget = 200;
    const result = summarizeLongOutput(text, budget);

    assert(result.wasSummarized, "long output should be summarized");
    assert(result.summary.includes("[...truncated"), "truncation marker present");
    // Budget reserves space for markers; small slack for gap markers
    assert(countTokens(result.summary) <= budget + 25, "output within budget");

    const before = result.originalTokens;
    const after = countTokens(result.summary);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 3: Priority lines — FAIL line deep in the output is hoisted into the summary
  run("summarize_output", "priority_lines_preserved", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "npm-output.txt"), "utf8");
    const result = summarizeLongOutput(text, 400);

    assert(result.wasSummarized, "long output should be summarized");
    assert(result.summary.includes("FAIL"), "FAIL line preserved regardless of position");

    const before = result.originalTokens;
    const after = countTokens(result.summary);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 4: Tail preservation — final summary lines of a log survive truncation
  run("summarize_output", "tail_preserved", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "npm-output.txt"), "utf8");
    const result = summarizeLongOutput(text, 400);

    assert(result.summary.includes("Time:"), "last line of log preserved (tail pass)");
    assert(result.summary.includes("Tests:"), "test summary line preserved");

    const before = result.originalTokens;
    const after = countTokens(result.summary);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 5: Duplicate lines collapsed with a repeat count
  run("summarize_output", "duplicate_lines_collapsed", () => {
    const warn = "npm warn deprecated foo@1.0.0: legacy package, do not use";
    const filler = (i) => `output line ${i} with some padding text to fill the budget`;
    const text = Array.from({ length: 60 }, (_, i) => (i % 2 ? warn : filler(i))).join("\n");
    const result = summarizeLongOutput(text, 150);

    assert(result.wasSummarized, "input exceeds budget");
    const occurrences = result.summary.split("legacy package").length - 1;
    assert(occurrences === 1, `duplicate line should appear once, found ${occurrences}`);
    assert(result.summary.includes("[×30]"), "repeat count annotation present");

    const before = result.originalTokens;
    const after = countTokens(result.summary);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 6: Empty input — should not crash
  run("summarize_output", "empty_string", () => {
    const result = summarizeLongOutput("", 400);
    assert(typeof result.summary === "string", "returns string");
    return { before: 0, after: 0, tokenReductionPct: 0, note: "empty input passthrough" };
  });
}

// ── summarize_diff ────────────────────────────────────────────────────────────

function benchSummarizeDiff() {
  const diff = fs.readFileSync(path.join(FIXTURES, "sample.diff"), "utf8");

  // Case 1: Context lines stripped by default — significant reduction
  run("summarize_diff", "context_stripped_default", () => {
    const result = summarizeDiff(diff);
    const before = countTokens(diff);
    const after = countTokens(result.summary);

    assert(!result.summary.includes("bcrypt.compare"), "pure context line stripped");
    assert(result.summary.includes('await audit.log("login.success", user.id)'), "added line preserved");
    assert(result.summary.includes('throw new Error("User not found")'), "removed line preserved");
    assert(after < before * 0.7, `expected >30% reduction, got ${reduction(before, after)}%`);

    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 2: Noise headers dropped, file headers rewritten tersely
  run("summarize_diff", "headers_compacted", () => {
    const result = summarizeDiff(diff);

    assert(!result.summary.includes("index 3f9c2ab"), "index lines dropped");
    assert(!result.summary.includes("similarity index"), "similarity lines dropped");
    assert(!result.summary.includes("+++ "), "redundant +++ header dropped");
    assert(result.summary.includes("=== src/auth/login.js"), "terse file header present");
    assert(result.summary.includes("@@ -12,9 +12,12 @@"), "hunk header preserved");

    const before = countTokens(diff);
    const after = countTokens(result.summary);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 3: Renames and binary files annotated on the file header
  run("summarize_diff", "rename_and_binary_annotated", () => {
    const result = summarizeDiff(diff);

    assert(
      result.summary.includes("=== src/auth/utils/session.js (renamed from src/auth/session.js)"),
      "rename annotated"
    );
    assert(result.summary.includes("=== assets/logo.png (binary)"), "binary file annotated");

    const before = countTokens(diff);
    const after = countTokens(result.summary);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 4: context_lines option keeps nearby context, still drops distant context
  run("summarize_diff", "context_lines_option", () => {
    const result = summarizeDiff(diff, { contextLines: 1 });

    assert(result.summary.includes("return createSession(user);"), "adjacent context kept");
    assert(!result.summary.includes("async function loginUser"), "distant context still dropped");

    const before = countTokens(diff);
    const after = countTokens(result.summary);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 5: File/addition/deletion stats counted correctly
  run("summarize_diff", "stats_counted", () => {
    const result = summarizeDiff(diff);

    assert(result.files === 3, `expected 3 files, got ${result.files}`);
    assert(result.additions === 6, `expected 6 additions, got ${result.additions}`);
    assert(result.deletions === 3, `expected 3 deletions, got ${result.deletions}`);

    return { before: 0, after: 0, tokenReductionPct: 0, note: "structural test" };
  });
}

// ── count_tokens ──────────────────────────────────────────────────────────────

function benchCountTokens() {
  // Case 1: Known string — pre-computed expected token count
  run("count_tokens", "known_string", () => {
    const tokens = countTokens("Hello, world!");
    assert(tokens === 4, `expected 4 tokens, got ${tokens}`);
    return { before: tokens, after: tokens, tokenReductionPct: 0 };
  });

  // Case 2: Empty string
  run("count_tokens", "empty_string", () => {
    const tokens = countTokens("");
    assert(tokens === 0, "empty string should be 0 tokens");
    return { before: 0, after: 0, tokenReductionPct: 0 };
  });

  // Case 3: Unicode + emoji — should not throw
  run("count_tokens", "unicode_and_emoji", () => {
    const tokens = countTokens("こんにちは 🎉 مرحبا");
    assert(tokens > 0, "unicode text should have >0 tokens");
    assert(Number.isInteger(tokens), "token count is an integer");
    return { before: tokens, after: tokens, tokenReductionPct: 0, note: `counted ${tokens} tokens` };
  });

  // Case 4: Long repeated string — count should scale linearly
  run("count_tokens", "linear_scaling", () => {
    const unit = "hello ";
    const t1 = countTokens(unit.repeat(10));
    const t10 = countTokens(unit.repeat(100));
    assert(Math.abs(t10 / t1 - 10) < 1.5, `token count should scale ~linearly: ${t1} vs ${t10}`);
    return { before: t10, after: t1, tokenReductionPct: 0, note: `10x: ${t1} → ${t10}` };
  });
}

// ── optimize_prompt ───────────────────────────────────────────────────────────

function benchOptimizePrompt() {
  const prompts = JSON.parse(fs.readFileSync(path.join(FIXTURES, "prompts.json"), "utf8"));
  const fillerPatterns = [
    /\bplease\b/i, /\bcould you\b/i, /\bkindly\b/i,
    /\bI would like you to\b/i, /\bcan you\b/i, /\bNote that\b/i,
  ];

  // Cases 1-3: Verbose prompts — filler stripped, tokens reduced
  for (const p of prompts.filter((p) => p.id.startsWith("verbose"))) {
    run("optimize_prompt", `filler_stripped_${p.id}`, () => {
      const optimized = optimizePrompt(p.text);
      const before = countTokens(p.text);
      const after = countTokens(optimized);

      assert(after < before, "optimized prompt should be shorter");
      if (fillerPatterns.some((re) => re.test(p.text))) {
        assert(!fillerPatterns.some((re) => re.test(optimized)), "filler phrases should be removed");
      }

      return { before, after, tokenReductionPct: reduction(before, after) };
    });
  }

  // Case 4: Technical prompt with no filler — should change minimally
  run("optimize_prompt", "clean_prompt_minimal_change", () => {
    const p = prompts.find((p) => p.id === "technical_clean");
    const optimized = optimizePrompt(p.text);
    const before = countTokens(p.text);
    const after = countTokens(optimized);

    assert(after >= before * 0.9, `clean prompt over-stripped: ${before} → ${after}`);

    return { before, after, tokenReductionPct: reduction(before, after), note: "technical prompt — minimal change expected" };
  });

  // Case 5: Prompt with code snippet — code survives, surrounding filler removed
  run("optimize_prompt", "code_snippet_preserved", () => {
    const p = prompts.find((p) => p.id === "code_snippet");
    const optimized = optimizePrompt(p.text);

    assert(optimized.includes("fetch('/api')"), "code content preserved");
    assert(optimized.includes("async"), "async keyword preserved");
    assert(!/\bplease note that\b/i.test(optimized), "filler outside fence removed");

    const before = countTokens(p.text);
    const after = countTokens(optimized);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 6: Filler words INSIDE a code fence are untouched
  run("optimize_prompt", "code_fence_filler_untouched", () => {
    const prompt = 'please fix this:\n```js\n// please keep this comment\nconst please = "kindly";\n```';
    const optimized = optimizePrompt(prompt);

    assert(optimized.includes("// please keep this comment"), "comment inside fence untouched");
    assert(optimized.includes('const please = "kindly";'), "identifiers/strings inside fence untouched");
    assert(!/^please/i.test(optimized), "filler outside fence removed");

    const before = countTokens(prompt);
    const after = countTokens(optimized);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 7: Expanded filler rules — newer phrases removed/replaced
  run("optimize_prompt", "expanded_filler_rules", () => {
    const prompt =
      "I need you to refactor this module. Feel free to rename variables. Basically, make sure to keep the tests passing prior to committing. Thanks in advance!";
    const optimized = optimizePrompt(prompt);
    const before = countTokens(prompt);
    const after = countTokens(optimized);

    assert(!/\bI need you to\b/i.test(optimized), "'I need you to' removed");
    assert(!/\bfeel free to\b/i.test(optimized), "'feel free to' removed");
    assert(!/\bbasically\b/i.test(optimized), "'basically' removed");
    assert(!/\bmake sure to\b/i.test(optimized), "'make sure to' removed");
    assert(!/\bthanks in advance\b/i.test(optimized), "'thanks in advance' removed");
    assert(/\bbefore\b/.test(optimized), "'prior to' replaced with 'before'");
    assert(optimized.includes("refactor this module"), "core instruction kept");
    assert(after < before, "optimized prompt should be shorter");

    return { before, after, tokenReductionPct: reduction(before, after) };
  });

  // Case 8: No punctuation artifacts left behind after filler removal
  run("optimize_prompt", "punctuation_artifacts_cleaned", () => {
    const prompt = "Could you please help me , thanks .";
    const optimized = optimizePrompt(prompt);

    assert(optimized.includes("help me, thanks."), `clean punctuation expected, got: "${optimized}"`);
    assert(!/[ \t],/.test(optimized), "no space before comma");
    assert(!/ {2,}/.test(optimized), "no double spaces");

    const before = countTokens(prompt);
    const after = countTokens(optimized);
    return { before, after, tokenReductionPct: reduction(before, after) };
  });
}

// ── generate_claudeignore ─────────────────────────────────────────────────────

function withTmpDir(name, setup, fn) {
  const tmpDir = path.join(__dirname, name);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    setup(tmpDir);
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function benchGenerateClaudeignore() {
  // Case 1: Bare project — only default entries
  run("generate_claudeignore", "bare_project_defaults", () => {
    return withTmpDir("tmp_bare", () => {}, (dir) => {
      const content = generateClaudeignore(dir);
      assert(content.includes("node_modules/"), "node_modules/ present");
      assert(content.includes(".git/"), ".git/ present");
      assert(!content.includes("fixtures/"), "fixtures/ not added when dir absent");
      const tokens = countTokens(content);
      return { before: tokens, after: tokens, tokenReductionPct: 0, note: "structural test" };
    });
  });

  // Case 2: Project with fixtures/ dir — extras appended
  run("generate_claudeignore", "project_with_fixtures_dir", () => {
    return withTmpDir("tmp_fixtures", (dir) => fs.mkdirSync(path.join(dir, "fixtures")), (dir) => {
      const content = generateClaudeignore(dir);
      assert(content.includes("fixtures/"), "fixtures/ added when dir exists");
      const tokens = countTokens(content);
      return { before: tokens, after: tokens, tokenReductionPct: 0, note: "structural test" };
    });
  });

  // Case 3: No duplicate entries
  run("generate_claudeignore", "no_duplicate_entries", () => {
    return withTmpDir("tmp_dedup", () => {}, (dir) => {
      const content = generateClaudeignore(dir);
      const lines = content.split("\n").filter(Boolean);
      const unique = new Set(lines);
      assert(unique.size === lines.length, `duplicate entries found: ${lines.length} lines, ${unique.size} unique`);
      const tokens = countTokens(content);
      return { before: tokens, after: tokens, tokenReductionPct: 0, note: "structural test" };
    });
  });

  // Case 4: Rust project — target/ ignored
  run("generate_claudeignore", "rust_project_target_ignored", () => {
    return withTmpDir("tmp_rust", (dir) => fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\n"), (dir) => {
      const content = generateClaudeignore(dir);
      assert(content.includes("target/"), "target/ added for Cargo project");
      const tokens = countTokens(content);
      return { before: tokens, after: tokens, tokenReductionPct: 0, note: "structural test" };
    });
  });

  // Case 5: Terraform project — .terraform/ and state files ignored
  run("generate_claudeignore", "terraform_project", () => {
    return withTmpDir("tmp_tf", (dir) => fs.writeFileSync(path.join(dir, "main.tf"), 'provider "aws" {}\n'), (dir) => {
      const content = generateClaudeignore(dir);
      assert(content.includes(".terraform/"), ".terraform/ added for Terraform project");
      assert(content.includes("*.tfstate"), "*.tfstate added for Terraform project");
      const tokens = countTokens(content);
      return { before: tokens, after: tokens, tokenReductionPct: 0, note: "structural test" };
    });
  });

  // Case 6: Existing .gitignore entries are seeded in (comments and negations excluded)
  run("generate_claudeignore", "gitignore_entries_seeded", () => {
    return withTmpDir(
      "tmp_gitignore",
      (dir) => fs.writeFileSync(path.join(dir, ".gitignore"), "# build output\nsecret-stuff/\n!keep-me.txt\nlocal-config.json\n"),
      (dir) => {
        const content = generateClaudeignore(dir);
        assert(content.includes("secret-stuff/"), ".gitignore entry seeded");
        assert(content.includes("local-config.json"), "second .gitignore entry seeded");
        assert(!content.includes("# build output"), "comments not seeded");
        assert(!content.includes("!keep-me.txt"), "negation patterns not seeded");
        const tokens = countTokens(content);
        return { before: tokens, after: tokens, tokenReductionPct: 0, note: "structural test" };
      }
    );
  });
}

// ── Run all benchmarks ────────────────────────────────────────────────────────

benchCompressText();
benchSmartReadFile();
benchSummarizeOutput();
benchSummarizeDiff();
benchCountTokens();
benchOptimizePrompt();
benchGenerateClaudeignore();

// ── Report ────────────────────────────────────────────────────────────────────

if (JSON_MODE) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);
}

const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL").length;

const COL = { tool: 22, case: 42, status: 6, reduction: 12, note: 45 };

function pad(s, n) { return String(s).substring(0, n).padEnd(n); }

const header = [
  pad("Tool", COL.tool),
  pad("Case", COL.case),
  pad("Status", COL.status),
  pad("Reduction", COL.reduction),
  pad("Note / Error", COL.note),
].join(" │ ");

const divider = "─".repeat(header.length);

console.log("\n" + divider);
console.log(header);
console.log(divider);

const tools = [...new Set(results.map((r) => r.tool))];
for (const tool of tools) {
  for (const r of results.filter((r) => r.tool === tool)) {
    const reductionStr = r.tokenReductionPct !== undefined ? `${r.tokenReductionPct}%` : "-";
    const noteOrErr = r.error ?? r.note ?? "";
    console.log([
      pad(tool, COL.tool),
      pad(r.case, COL.case),
      pad(r.status, COL.status),
      pad(reductionStr, COL.reduction),
      pad(noteOrErr, COL.note),
    ].join(" │ "));
  }
  console.log(divider);
}

console.log(`\nResults: ${pass} passed, ${fail} failed out of ${results.length} cases\n`);

console.log("Average token reduction by tool:");
for (const tool of tools) {
  const toolResults = results.filter((r) => r.tool === tool && r.status === "PASS" && r.tokenReductionPct > 0);
  if (toolResults.length === 0) { console.log(`  ${tool.padEnd(24)} n/a`); continue; }
  const avg = Math.round(toolResults.reduce((s, r) => s + r.tokenReductionPct, 0) / toolResults.length);
  console.log(`  ${tool.padEnd(24)} ${avg}% avg over ${toolResults.length} cases`);
}

console.log();
process.exit(fail > 0 ? 1 : 0);
