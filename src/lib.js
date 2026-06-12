// Shared helpers for the token-saver MCP server and its benchmark suite.
// The benchmark imports these directly so it always tests the shipped code.

import fs from "fs";
import path from "path";
import { get_encoding } from "tiktoken";

const enc = get_encoding("cl100k_base");

// cl100k_base is OpenAI's encoding. Claude's tokenizer differs, so counts are
// approximations — typically within ~10-20% of Claude's actual usage.
export function countTokens(text) {
  return enc.encode(text).length;
}

// ─── compress_text ───────────────────────────────────────────────────────────

// Character-level state machine: tracks string/comment context so that
// comment markers inside string literals (e.g. "https://...") are never
// treated as comments, and string delimiters inside comments are ignored.
export function stripComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  // states: code | line (// or # comment) | block (/* */) |
  //         sq/dq (single/double-quoted string) | bt (template literal) |
  //         tsq/tdq (Python triple-quoted string)
  let state = "code";

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (c === "#") {
        // shebang at file start, or # glued to a token (this.#priv, #fff) — not a comment
        const prev = text[i - 1];
        if (i === 0 && next === "!") {
          out += c;
          i++;
          continue;
        }
        if (prev !== undefined && !/[\s]/.test(prev)) {
          out += c;
          i++;
          continue;
        }
        state = "line";
        i++;
        continue;
      }
      if (c === "'") {
        if (text.startsWith("'''", i)) {
          state = "tsq";
          out += "'''";
          i += 3;
          continue;
        }
        state = "sq";
        out += c;
        i++;
        continue;
      }
      if (c === '"') {
        if (text.startsWith('"""', i)) {
          state = "tdq";
          out += '"""';
          i += 3;
          continue;
        }
        state = "dq";
        out += c;
        i++;
        continue;
      }
      if (c === "`") {
        state = "bt";
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }

    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      i++;
      continue;
    }

    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (state === "sq" || state === "dq") {
      const quote = state === "sq" ? "'" : '"';
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      out += c;
      if (c === quote || c === "\n") state = "code"; // strings don't span lines
      i++;
      continue;
    }

    if (state === "bt") {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      out += c;
      if (c === "`") state = "code";
      i++;
      continue;
    }

    // tsq / tdq — triple-quoted strings span lines
    const q3 = state === "tsq" ? "'''" : '"""';
    if (text.startsWith(q3, i)) {
      out += q3;
      state = "code";
      i += 3;
      continue;
    }
    out += c;
    i++;
  }

  return out;
}

export function compressText(text) {
  return stripComments(text)
    .replace(/[ \t]+$/gm, "")    // trailing whitespace left where comments were removed
    .replace(/^\s*[\r\n]/gm, "") // blank lines
    .replace(/[ \t]+/g, " ")     // collapse whitespace
    .replace(/\n{3,}/g, "\n\n")  // max 2 consecutive newlines
    .trim();
}

// ─── smart_read_file ─────────────────────────────────────────────────────────

const DEF_RE =
  /^([ \t]*)(?:export\s+)?(?:async\s+)?(?:function\b|def\s|class\s|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\(|function\b|\w+\s*=>))/;

function indentOf(line) {
  return /^[ \t]*/.exec(line)[0].length;
}

// Find the function/class definition enclosing the match, so the extract is a
// complete semantic unit rather than an arbitrary ±N window. Returns
// [startIdx, endIdx] inclusive, or null if the match isn't inside one.
export function findEnclosingBlock(lines, matchIdx, maxBlockLines = 150) {
  const matchIndent = indentOf(lines[matchIdx]);
  for (let s = matchIdx; s >= 0 && matchIdx - s <= maxBlockLines; s--) {
    const m = DEF_RE.exec(lines[s]);
    if (!m || m[1].length > matchIndent) continue;
    const defIndent = m[1].length;

    let end = lines.length - 1;
    for (let e = s + 1; e < lines.length && e - s <= maxBlockLines; e++) {
      const line = lines[e];
      if (line.trim() === "") continue;
      if (indentOf(line) <= defIndent) {
        // a closing bracket at def level belongs to the block; anything else starts the next one
        end = /^[ \t]*[}\])]/.test(line) ? e : e - 1;
        break;
      }
      end = e;
    }

    if (end < matchIdx) return null; // nearest definition ends before the match — match is top-level
    return [s, end];
  }
  return null;
}

export function extractRelevantLines(content, keywords, { windowSize = 30, lineNumbers = false } = {}) {
  const lines = content.split("\n");
  if (!keywords || keywords.length === 0) return content;

  const relevant = new Set();
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    if (keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      const block = findEnclosingBlock(lines, i);
      if (block) {
        for (let j = block[0]; j <= block[1]; j++) relevant.add(j);
      } else {
        for (let j = Math.max(0, i - windowSize); j <= Math.min(lines.length - 1, i + windowSize); j++) {
          relevant.add(j);
        }
      }
    }
  });

  if (relevant.size === 0) return content; // nothing matched, return as-is

  const fmt = (j) => (lineNumbers ? `${j + 1}: ${lines[j]}` : lines[j]);
  const sorted = [...relevant].sort((a, b) => a - b);
  const parts = [];
  let buf = [];
  let prev = sorted[0] - 1;
  for (const idx of sorted) {
    if (idx > prev + 1) {
      parts.push(buf.join("\n"));
      parts.push(`... [lines ${prev + 2}–${idx} snipped] ...`);
      buf = [];
    }
    buf.push(fmt(idx));
    prev = idx;
  }
  parts.push(buf.join("\n"));

  if (sorted[0] > 0) parts.unshift(`... [lines 1–${sorted[0]} snipped] ...`);
  const last = sorted[sorted.length - 1];
  if (last < lines.length - 1) parts.push(`... [lines ${last + 2}–${lines.length} snipped] ...`);

  return parts.join("\n\n");
}

// ─── summarize_output ────────────────────────────────────────────────────────

export const PRIORITY_LINE_RE =
  /\b(FAIL|FAILED|ERROR|error:|Exception|Traceback|TypeError|SyntaxError|ReferenceError|AssertionError|✗|✕|ENOENT|EACCES|npm ERR!)\b/i;

export function summarizeLongOutput(text, maxTokens = 400) {
  const tokens = countTokens(text);
  if (tokens <= maxTokens) return { summary: text, wasSummarized: false, originalTokens: tokens };

  // Collapse exact-duplicate lines (npm prints the same warning dozens of times).
  // First occurrence is kept and annotated with the repeat count.
  const seen = new Map();
  const lines = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const key = raw.trim();
    if (seen.has(key)) {
      seen.get(key).count++;
      continue;
    }
    const entry = { text: raw, count: 1 };
    seen.set(key, entry);
    lines.push(entry);
  }
  const render = (e) => (e.count > 1 ? `${e.text} [×${e.count}]` : e.text);

  const MARKER_RESERVE = 30; // truncation marker + gap markers
  const budget = Math.max(maxTokens - MARKER_RESERVE, 20);

  const included = new Set();
  let used = 0;
  const tryAdd = (i, cap) => {
    if (included.has(i)) return true;
    const t = countTokens(render(lines[i]));
    if (used + t > cap) return false;
    included.add(i);
    used += t;
    return true;
  };

  // 1) Priority lines (errors, failures) anywhere in the output — up to 25% of budget
  const priorityCap = Math.floor(budget * 0.25);
  for (let i = 0; i < lines.length; i++) {
    if (used >= priorityCap) break;
    if (PRIORITY_LINE_RE.test(lines[i].text)) tryAdd(i, priorityCap);
  }

  // 2) Tail — summaries and final errors usually live at the end — up to another 25%
  const tailCap = used + Math.floor(budget * 0.25);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!tryAdd(i, tailCap)) break;
  }

  // 3) Head — fill the rest from the top
  for (let i = 0; i < lines.length; i++) {
    if (!tryAdd(i, budget)) break;
  }

  const sorted = [...included].sort((a, b) => a - b);
  const parts = [];
  let prev = -1;
  for (const i of sorted) {
    if (prev !== -1 && i > prev + 1) parts.push("[...]");
    parts.push(render(lines[i]));
    prev = i;
  }

  const summary =
    parts.join("\n") +
    `\n\n[...truncated. Original: ${tokens} tokens → kept: ${used} tokens (${Math.round((used / tokens) * 100)}%)]`;

  return { summary, wasSummarized: true, originalTokens: tokens, keptTokens: used };
}

// ─── optimize_prompt ─────────────────────────────────────────────────────────

const FILLER_RULES = [
  [/\bplease\b/gi, ""],
  [/\bcould you\b/gi, ""],
  [/\bI would like you to\b/gi, ""],
  [/\bI want you to\b/gi, ""],
  [/\bcan you\b/gi, ""],
  [/\bkindly\b/gi, ""],
  [/\bAs an AI language model,?\s*/gi, ""],
  [/\bIt is important to note that\b/gi, ""],
  [/\bPlease note that\b/gi, ""],
  [/\bNote that\b/gi, ""],
  [/\bIn order to\b/gi, "To"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bat this point in time\b/gi, "now"],
  [/\bin the event that\b/gi, "if"],
];

export function optimizePrompt(prompt) {
  // Fenced code blocks and inline code spans are passed through untouched —
  // filler words inside code (strings, comments) must not be stripped.
  const segments = prompt.split(/(```[\s\S]*?```|`[^`\n]+`)/);

  const out = segments
    .map((seg, idx) => {
      if (idx % 2 === 1) return seg; // protected code segment
      let s = seg;
      for (const [re, rep] of FILLER_RULES) s = s.replace(re, rep);
      return s
        .replace(/[ \t]+/g, " ")
        .replace(/[ \t]+([,.;:?!])/g, "$1") // "help me ," → "help me,"
        .replace(/(^|\n)[ \t]*,[ \t]*/g, "$1"); // orphan comma left at sentence start
    })
    .join("");

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// ─── generate_claudeignore ───────────────────────────────────────────────────

export function generateClaudeignore(projectPath) {
  const always = [
    "node_modules/", ".git/", "dist/", "build/", ".next/", "out/",
    "coverage/", ".nyc_output/", "*.min.js", "*.min.css", "*.map",
    "*.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    ".env*", "*.log", "logs/", "tmp/", ".cache/", "__pycache__/",
    "*.pyc", ".pytest_cache/", "venv/", ".venv/", "*.egg-info/",
    ".DS_Store", "Thumbs.db",
  ];

  const has = (p) => fs.existsSync(path.join(projectPath, p));
  const extras = [];
  if (has("public")) extras.push("public/fonts/", "public/images/");
  if (has("migrations")) extras.push("migrations/*.sql");
  if (has("fixtures")) extras.push("fixtures/");
  if (has("Cargo.toml")) extras.push("target/");
  if (has("go.mod")) extras.push("vendor/", "bin/");
  if (has("build.gradle") || has("build.gradle.kts") || has("pom.xml")) extras.push("build/", ".gradle/", "*.class");
  if (has("Gemfile")) extras.push(".bundle/", "vendor/bundle/");
  if (has("composer.json")) extras.push("vendor/");

  // Seed from the project's own .gitignore — anything git ignores, Claude should too
  const seeded = [];
  const gitignore = path.join(projectPath, ".gitignore");
  if (fs.existsSync(gitignore)) {
    for (const line of fs.readFileSync(gitignore, "utf8").split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#") && !t.startsWith("!")) seeded.push(t);
    }
  }

  return [...new Set([...always, ...extras, ...seeded])].join("\n");
}
