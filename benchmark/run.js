#!/usr/bin/env node
/**
 * Benchmark runner for token-saver-mcp.
 *
 * Tests each tool for:
 *   - Token reduction (efficiency)
 *   - Correctness / meaning preservation (accuracy)
 *
 * Usage:
 *   node benchmark/run.js
 *   node benchmark/run.js --json   (machine-readable output)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { get_encoding } from "tiktoken";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const JSON_MODE = process.argv.includes("--json");

// ── Import helpers directly from source (avoids stdio MCP overhead) ──────────
// We re-implement the same helpers here so we can unit-test them in isolation.

const enc = get_encoding("cl100k_base");

function countTokens(text) {
  return enc.encode(text).length;
}

function compressText(text) {
  return text
    .replace(/(?<!:)\/\/(?!.*["'`].*["'`]).*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)#(?!!).*$/gm, "$1")
    .replace(/^\s*[\r\n]/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractRelevantLines(content, keywords, windowSize = 30) {
  const lines = content.split("\n");
  if (!keywords || keywords.length === 0) return content;
  const relevant = new Set();
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    if (keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      for (let j = Math.max(0, i - windowSize); j <= Math.min(lines.length - 1, i + windowSize); j++) {
        relevant.add(j);
      }
    }
  });
  if (relevant.size === 0) return content;
  const sorted = [...relevant].sort((a, b) => a - b);
  const chunks = [];
  let prev = -2, chunk = [];
  for (const idx of sorted) {
    if (idx > prev + 1) { if (chunk.length) chunks.push(chunk.join("\n")); chunk = []; }
    chunk.push(lines[idx]);
    prev = idx;
  }
  if (chunk.length) chunks.push(chunk.join("\n"));
  return chunks.join("\n\n... [snipped] ...\n\n");
}

const PRIORITY_LINE_RE = /\b(FAIL|FAILED|ERROR|error:|Exception|Traceback|TypeError|SyntaxError|ReferenceError|AssertionError|✗|✕|ENOENT|EACCES|npm ERR!)\b/i;

function summarizeLongOutput(text, maxTokens = 400) {
  const tokens = countTokens(text);
  if (tokens <= maxTokens) return { summary: text, wasSummarized: false, originalTokens: tokens };

  const MARKER_BUDGET = 20;
  const budget = maxTokens - MARKER_BUDGET;
  const lines = text.split("\n").filter(Boolean);

  const priorityBudget = Math.floor(budget * 0.2);
  const priorityIndices = new Set();
  let priorityUsed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (PRIORITY_LINE_RE.test(lines[i])) {
      const t = countTokens(lines[i]);
      if (priorityUsed + t <= priorityBudget) {
        priorityIndices.add(i);
        priorityUsed += t;
      }
    }
  }

  const remainingBudget = budget - priorityUsed;
  const topIndices = new Set();
  let topUsed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (priorityIndices.has(i)) continue;
    const t = countTokens(lines[i]);
    if (topUsed + t > remainingBudget) break;
    topIndices.add(i);
    topUsed += t;
  }

  const allIndices = [...new Set([...topIndices, ...priorityIndices])].sort((a, b) => a - b);
  const keptTokens = topUsed + priorityUsed;
  const summary =
    allIndices.map((i) => lines[i]).join("\n") +
    `\n\n[...truncated. Original: ${tokens} tokens → kept: ${keptTokens} tokens (${Math.round((keptTokens / tokens) * 100)}%)]`;
  return { summary, wasSummarized: true, originalTokens: tokens, keptTokens };
}

function optimizePrompt(prompt) {
  return prompt
    .replace(/\bplease\b/gi, "")
    .replace(/\bcould you\b/gi, "")
    .replace(/\bI would like you to\b/gi, "")
    .replace(/\bI want you to\b/gi, "")
    .replace(/\bcan you\b/gi, "")
    .replace(/\bkindly\b/gi, "")
    .replace(/\bAs an AI language model,?\s*/gi, "")
    .replace(/\bNote that\b/gi, "")
    .replace(/\bIt is important to note that\b/gi, "")
    .replace(/\bPlease note that\b/gi, "")
    .replace(/\bIn order to\b/gi, "To")
    .replace(/\bdue to the fact that\b/gi, "because")
    .replace(/\bat this point in time\b/gi, "now")
    .replace(/\bin the event that\b/gi, "if")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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

    return { before, after, tokenReductionPct: Math.round(((before - after) / before) * 100) };
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

    return { before, after, tokenReductionPct: Math.round(((before - after) / before) * 100) };
  });

  // Case 3: Already-minified code — should change nothing meaningful
  run("compress_text", "minified_code_passthrough", () => {
    const original = `const f=(x)=>x*2;const g=(x)=>x+1;`;
    const compressed = compressText(original);
    const before = countTokens(original);
    const after = countTokens(compressed);

    assert(compressed.includes("const f"), "content intact");
    // Should not expand (allow up to 5% growth from trim edge effects)
    assert(after <= before * 1.05, "no significant token growth on minified input");

    return { before, after, tokenReductionPct: Math.round(((before - after) / before) * 100) };
  });

  // Case 4: URL inside a string literal — should not be corrupted
  run("compress_text", "url_string_not_corrupted", () => {
    const original = `const url = "https://example.com/api/v2"; // endpoint`;
    const compressed = compressText(original);

    assert(compressed.includes("https://example.com/api/v2"), "URL inside string preserved");
    assert(!compressed.includes("// endpoint"), "trailing comment stripped");

    const before = countTokens(original);
    const after = countTokens(compressed);
    return { before, after, tokenReductionPct: Math.round(((before - after) / before) * 100) };
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
    assert(result.includes("bcrypt.compare"), "surrounding context included");

    return { before, after, tokenReductionPct: Math.round(((before - after) / before) * 100) };
  });

  // Case 2: Keyword not found — should return full file (fallback)
  run("smart_read_file", "keyword_miss_returns_full_file", () => {
    const original = fs.readFileSync(path.join(FIXTURES, "sample.js"), "utf8");
    const result = extractRelevantLines(original, ["nonexistent_xyz_keyword"]);
    const before = countTokens(original);
    const after = countTokens(result);

    assert(result === original, "full file returned on keyword miss");

    return { before, after, tokenReductionPct: 0, note: "expected 0% reduction on miss" };
  });

  // Case 3: Keyword near EOF — window should not exceed file bounds
  run("smart_read_file", "keyword_near_eof", () => {
    const original = fs.readFileSync(path.join(FIXTURES, "sample.js"), "utf8");
    const result = extractRelevantLines(original, ["deleteUser"]);

    assert(result.includes("deleteUser"), "last function found");
    // Should not throw or produce garbage
    assert(typeof result === "string" && result.length > 0, "valid string output");

    const before = countTokens(original);
    const after = countTokens(result);
    return { before, after, tokenReductionPct: Math.round(((before - after) / before) * 100) };
  });

  // Case 4: Multiple keywords — union of windows
  run("smart_read_file", "multiple_keywords_union", () => {
    const original = fs.readFileSync(path.join(FIXTURES, "sample.py"), "utf8");
    const result = extractRelevantLines(original, ["ingest_payload", "write_to_clickhouse"]);

    assert(result.includes("ingest_payload"), "first keyword found");
    assert(result.includes("write_to_clickhouse"), "second keyword found");

    const before = countTokens(original);
    const after = countTokens(result);
    return { before, after, tokenReductionPct: Math.round(((before - after) / before) * 100) };
  });

  // Case 5: No keywords provided — full file returned
  run("smart_read_file", "no_keywords_full_file", () => {
    const original = fs.readFileSync(path.join(FIXTURES, "sample.js"), "utf8");
    const result = extractRelevantLines(original, []);

    assert(result === original, "full file returned when no keywords given");

    const tokens = countTokens(original);
    return { before: tokens, after: tokens, tokenReductionPct: 0, note: "expected 0% when no keywords" };
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

  // Case 2: Long npm/build output — should truncate with marker
  // Known limitation: truncation marker (~27 tokens) is appended after the budget
  // is exhausted, so final output slightly exceeds maxTokens.
  run("summarize_output", "long_build_output_truncated", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "npm-output.txt"), "utf8");
    const budget = 200;
    const result = summarizeLongOutput(text, budget);

    assert(result.wasSummarized, "long output should be summarized");
    assert(result.summary.includes("[...truncated"), "truncation marker present");
    // Marker overhead: allow up to 50 extra tokens beyond budget
    assert(countTokens(result.summary) <= budget + 50, "output within budget + marker overhead");

    const before = result.originalTokens;
    const after = countTokens(result.summary);
    return {
      before, after,
      tokenReductionPct: Math.round(((before - after) / before) * 100),
      note: "marker adds ~27 tokens beyond budget (known: tool doesn't reserve space for marker)",
    };
  });

  // Case 3: Priority-line preservation — FAIL line in jest output should be kept
  // even though it appears well past the 400-token truncation point when reading top-down.
  run("summarize_output", "priority_lines_preserved", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "npm-output.txt"), "utf8");
    const result = summarizeLongOutput(text, 400);

    assert(result.wasSummarized, "long output should be summarized");
    assert(result.summary.includes("FAIL"), "FAIL line hoisted into summary by priority-line logic");

    const before = result.originalTokens;
    const after = countTokens(result.summary);
    return { before, after, tokenReductionPct: Math.round(((before - after) / before) * 100) };
  });

  // Case 4: Empty input — should not crash
  run("summarize_output", "empty_string", () => {
    const result = summarizeLongOutput("", 400);
    assert(typeof result.summary === "string", "returns string");
    return { before: 0, after: 0, tokenReductionPct: 0, note: "empty input passthrough" };
  });
}

// ── count_tokens ──────────────────────────────────────────────────────────────

function benchCountTokens() {
  // Case 1: Known string — pre-computed expected token count
  run("count_tokens", "known_string", () => {
    const text = "Hello, world!";
    const tokens = countTokens(text);
    // "Hello" + "," + " world" + "!" = 4 tokens in cl100k_base
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
    const text = "こんにちは 🎉 مرحبا";
    const tokens = countTokens(text);
    assert(tokens > 0, "unicode text should have >0 tokens");
    assert(Number.isInteger(tokens), "token count is an integer");
    return { before: tokens, after: tokens, tokenReductionPct: 0, note: `counted ${tokens} tokens` };
  });

  // Case 4: Long repeated string — count should scale linearly
  run("count_tokens", "linear_scaling", () => {
    const unit = "hello ";
    const t1 = countTokens(unit.repeat(10));
    const t10 = countTokens(unit.repeat(100));
    // Should be roughly 10x (within 10% tolerance for BPE edge effects)
    assert(Math.abs(t10 / t1 - 10) < 1.5, `token count should scale ~linearly: ${t1} vs ${t10}`);
    return { before: t10, after: t1, tokenReductionPct: 0, note: `10x: ${t1} → ${t10}` };
  });
}

// ── optimize_prompt ───────────────────────────────────────────────────────────

function benchOptimizePrompt() {
  const prompts = JSON.parse(fs.readFileSync(path.join(FIXTURES, "prompts.json"), "utf8"));

  // Case 1-3: Verbose prompts — should strip filler, reduce tokens
  for (const p of prompts.filter((p) => p.id.startsWith("verbose"))) {
    run("optimize_prompt", `filler_stripped_${p.id}`, () => {
      const optimized = optimizePrompt(p.text);
      const before = countTokens(p.text);
      const after = countTokens(optimized);

      assert(after < before, "optimized prompt should be shorter");
      // Check at least one filler phrase was removed
      const fillerPatterns = [/\bplease\b/i, /\bcould you\b/i, /\bkindly\b/i, /\bI would like you to\b/i, /\bcan you\b/i, /\bNote that\b/i];
      const hadFiller = fillerPatterns.some((re) => re.test(p.text));
      if (hadFiller) {
        const stillHasFiller = fillerPatterns.some((re) => re.test(optimized));
        assert(!stillHasFiller, "filler phrases should be removed");
      }

      return { before, after, tokenReductionPct: Math.round(((before - after) / before) * 100) };
    });
  }

  // Case 4: Technical prompt with no filler — should change minimally
  run("optimize_prompt", "clean_prompt_minimal_change", () => {
    const p = prompts.find((p) => p.id === "technical_clean");
    const optimized = optimizePrompt(p.text);
    const before = countTokens(p.text);
    const after = countTokens(optimized);

    // Allow at most 10% reduction — should not mangle technical content
    assert(after >= before * 0.9, `clean prompt over-stripped: ${before} → ${after}`);

    return { before, after, tokenReductionPct: Math.round(((before - after) / before) * 100), note: "technical prompt — minimal change expected" };
  });

  // Case 5: Prompt with code snippet — code should survive
  run("optimize_prompt", "code_snippet_preserved", () => {
    const p = prompts.find((p) => p.id === "code_snippet");
    const optimized = optimizePrompt(p.text);

    assert(optimized.includes("fetch('/api')"), "code content preserved");
    assert(optimized.includes("async"), "async keyword preserved");

    const before = countTokens(p.text);
    const after = countTokens(optimized);
    return { before, after, tokenReductionPct: Math.round(((before - after) / before) * 100) };
  });
}

// ── generate_claudeignore (static / structural test) ─────────────────────────

function benchGenerateClaudeignore() {
  function generateClaudeignore(projectPath) {
    const always = [
      "node_modules/", ".git/", "dist/", "build/", ".next/", "out/",
      "coverage/", ".nyc_output/", "*.min.js", "*.min.css", "*.map",
      "*.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
      ".env*", "*.log", "logs/", "tmp/", ".cache/", "__pycache__/",
      "*.pyc", ".pytest_cache/", "venv/", ".venv/", "*.egg-info/",
      ".DS_Store", "Thumbs.db",
    ];
    const extras = [];
    if (fs.existsSync(path.join(projectPath, "public"))) extras.push("public/fonts/", "public/images/");
    if (fs.existsSync(path.join(projectPath, "migrations"))) extras.push("migrations/*.sql");
    if (fs.existsSync(path.join(projectPath, "fixtures"))) extras.push("fixtures/");
    return [...always, ...extras].join("\n");
  }

  // Case 1: Bare project — only default entries
  run("generate_claudeignore", "bare_project_defaults", () => {
    const tmpDir = path.join(__dirname, "tmp_bare");
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const content = generateClaudeignore(tmpDir);
      assert(content.includes("node_modules/"), "node_modules/ present");
      assert(content.includes(".git/"), ".git/ present");
      assert(!content.includes("fixtures/"), "fixtures/ not added when dir absent");
      const tokens = countTokens(content);
      return { before: tokens, after: tokens, tokenReductionPct: 0, note: "structural test" };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Case 2: Project with fixtures/ dir — extras appended
  run("generate_claudeignore", "project_with_fixtures_dir", () => {
    const tmpDir = path.join(__dirname, "tmp_with_fixtures");
    fs.mkdirSync(path.join(tmpDir, "fixtures"), { recursive: true });
    try {
      const content = generateClaudeignore(tmpDir);
      assert(content.includes("fixtures/"), "fixtures/ added when dir exists");
      const tokens = countTokens(content);
      return { before: tokens, after: tokens, tokenReductionPct: 0, note: "structural test" };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Case 3: Content has no duplicate entries
  run("generate_claudeignore", "no_duplicate_entries", () => {
    const tmpDir = path.join(__dirname, "tmp_dedup");
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const content = generateClaudeignore(tmpDir);
      const lines = content.split("\n").filter(Boolean);
      const unique = new Set(lines);
      assert(unique.size === lines.length, `duplicate entries found: ${lines.length} lines, ${unique.size} unique`);
      const tokens = countTokens(content);
      return { before: tokens, after: tokens, tokenReductionPct: 0, note: "structural test" };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

// ── Run all benchmarks ────────────────────────────────────────────────────────

benchCompressText();
benchSmartReadFile();
benchSummarizeOutput();
benchCountTokens();
benchOptimizePrompt();
benchGenerateClaudeignore();

// ── Report ────────────────────────────────────────────────────────────────────

if (JSON_MODE) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);
}

// Pretty-print table
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

// Group by tool
const tools = [...new Set(results.map((r) => r.tool))];
for (const tool of tools) {
  for (const r of results.filter((r) => r.tool === tool)) {
    const reduction = r.tokenReductionPct !== undefined ? `${r.tokenReductionPct}%` : "-";
    const noteOrErr = r.error ?? r.note ?? "";
    const icon = r.status === "PASS" ? "PASS" : "FAIL";
    console.log([
      pad(tool, COL.tool),
      pad(r.case, COL.case),
      pad(icon, COL.status),
      pad(reduction, COL.reduction),
      pad(noteOrErr, COL.note),
    ].join(" │ "));
  }
  console.log(divider);
}

// Summary + per-tool average reduction
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
