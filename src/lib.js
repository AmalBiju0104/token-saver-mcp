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
  // states: code | line (// or # comment) | block (/* */) | htmlc (<!-- -->) |
  //         sq/dq (single/double-quoted string) | bt (template literal) |
  //         tsq/tdq (Python triple-quoted string)
  let state = "code";
  // Brace-depth stack for template-literal ${...} expressions: each level is
  // the open-brace count inside that expression, so nested {} and nested
  // template literals resolve correctly.
  const exprStack = [];

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    if (state === "code") {
      // "://" is a URL scheme separator (https://...), not a comment
      if (c === "/" && next === "/" && text[i - 1] !== ":") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (c === "<" && text.startsWith("<!--", i)) {
        state = "htmlc";
        i += 4;
        continue;
      }
      if (c === "#") {
        // A # is a comment only when detached from code: preceded by
        // start/whitespace AND followed by whitespace/EOL. Keeps shebangs,
        // this.#priv, #fff (CSS hex colors), #hashtag, and #region intact.
        const prev = text[i - 1];
        if (i === 0 && next === "!") {
          out += c;
          i++;
          continue;
        }
        const gluedBefore = prev !== undefined && !/\s/.test(prev);
        const gluedAfter = next !== undefined && !/[ \t\r\n]/.test(next);
        if (gluedBefore || gluedAfter) {
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
      // Track braces inside template-literal ${...} expressions
      if (exprStack.length > 0) {
        if (c === "{") {
          exprStack[exprStack.length - 1]++;
        } else if (c === "}") {
          if (exprStack[exprStack.length - 1] === 0) {
            exprStack.pop();
            state = "bt"; // expression closed — back inside the template literal
          } else {
            exprStack[exprStack.length - 1]--;
          }
        }
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
      if (c === "$" && next === "{") {
        // ${...} expressions contain real code — comments inside them are stripped
        out += "${";
        i += 2;
        exprStack.push(0);
        state = "code";
        continue;
      }
      out += c;
      if (c === "`") state = "code";
      i++;
      continue;
    }

    if (state === "htmlc") {
      if (text.startsWith("-->", i)) {
        state = "code";
        i += 3;
        continue;
      }
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

// Recognizes definition lines across JS/TS, Python, Go, Rust, Java, and C#.
// Heuristic by design — only used to locate the enclosing block around a match.
const DEF_RE = new RegExp(
  "^([ \\t]*)" +
    "(?:export\\s+(?:default\\s+)?)?" +
    "(?:" +
    [
      "(?:async\\s+)?function\\b", // JS/TS function declaration
      "(?:abstract\\s+)?class\\s", // JS/TS/Python/Java/C# class
      "interface\\s+\\w+", // TS/Java/C# interface
      "(?:const\\s+)?enum\\s+\\w+", // TS/Rust/Java/C# enum
      "type\\s+\\w+(?:<[^>]*>)?\\s*=", // TS type alias
      "(?:const|let|var)\\s+[\\w$]+\\s*=\\s*(?:async\\s*)?(?:\\(|function\\b|[\\w$]+\\s*=>)", // JS function expression
      "(?:async\\s+)?def\\s", // Python
      "func\\s", // Go (incl. method receivers)
      "type\\s+\\w+\\s+(?:struct|interface)\\b", // Go type declaration
      "(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:unsafe\\s+)?fn\\s", // Rust fn
      "(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|trait|mod|union)\\s+\\w+", // Rust items
      "impl[\\s<]", // Rust impl block
      "(?:(?:public|private|protected|internal|static|abstract|final|override|virtual|sealed|synchronized)\\s+)+(?:class|interface|enum|record|struct)\\s", // Java/C# types
      "(?:(?:public|private|protected|internal|static|abstract|final|override|virtual|sealed|synchronized)\\s+)+(?:[\\w$<>\\[\\],\\s]*?[\\w$<>\\[\\]]+\\s+)?[\\w$]+\\s*\\(", // Java/C# methods & constructors
    ].join("|") +
    ")"
);

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

  // Markers are kept terse — they count against the same token budget the
  // extraction is trying to save.
  const fmt = (j) => (lineNumbers ? `${j + 1}: ${lines[j]}` : lines[j]);
  const sorted = [...relevant].sort((a, b) => a - b);
  const parts = [];
  let buf = [];
  let prev = sorted[0] - 1;
  for (const idx of sorted) {
    if (idx > prev + 1) {
      parts.push(buf.join("\n"));
      parts.push(`[lines ${prev + 2}–${idx} snipped]`);
      buf = [];
    }
    buf.push(fmt(idx));
    prev = idx;
  }
  parts.push(buf.join("\n"));

  if (sorted[0] > 0) parts.unshift(`[lines 1–${sorted[0]} snipped]`);
  const last = sorted[sorted.length - 1];
  if (last < lines.length - 1) parts.push(`[lines ${last + 2}–${lines.length} snipped]`);

  return parts.join("\n");
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

// Longer phrases come before shorter overlapping ones — rules apply in order.
const FILLER_RULES = [
  [/\bI was wondering if you could\b/gi, ""],
  [/\bI(?:'|’)?d like to ask you to\b/gi, ""],
  [/\bI would like you to\b/gi, ""],
  [/\bI(?:'|’)?d like you to\b/gi, ""],
  [/\bI want you to\b/gi, ""],
  [/\bI need you to\b/gi, ""],
  [/\bwould you mind\b/gi, ""],
  [/\bcould you\b/gi, ""],
  [/\bcan you\b/gi, ""],
  [/\bplease\b/gi, ""],
  [/\bkindly\b/gi, ""],
  [/\bfeel free to\b/gi, ""],
  [/\bdon(?:'|’)?t hesitate to\b/gi, ""],
  [/\bgo ahead and\b/gi, ""],
  [/\bmake sure to\b/gi, ""],
  [/\bbe sure to\b/gi, ""],
  [/\bAs an AI language model,?\s*/gi, ""],
  [/\bIt is important to note that\b/gi, ""],
  [/\bit should be noted that\b/gi, ""],
  [/\bit(?:'|’)?s worth noting that\b/gi, ""],
  [/\bas mentioned (?:above|previously|earlier),?[ \t]*/gi, ""],
  [/\bPlease note that\b/gi, ""],
  [/\bNote that\b/gi, ""],
  [/\bthanks in advance[.!]?/gi, ""],
  [/\bbasically,?[ \t]*/gi, ""],
  [/\bessentially,?[ \t]*/gi, ""],
  [/\bif possible,?[ \t]*/gi, ""],
  [/\bIn order to\b/gi, "To"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bat this point in time\b/gi, "now"],
  [/\bin the event that\b/gi, "if"],
  [/\bin the process of\b/gi, ""],
  [/\bfor the purpose of\b/gi, "for"],
  [/\bwith regard to\b/gi, "about"],
  [/\ba large number of\b/gi, "many"],
  [/\bthe majority of\b/gi, "most"],
  [/\bprior to\b/gi, "before"],
  [/\bsubsequent to\b/gi, "after"],
  [/\bin the near future\b/gi, "soon"],
  [/\bhas the ability to\b/gi, "can"],
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

// ─── summarize_diff ──────────────────────────────────────────────────────────

// Compacts a unified git diff: keeps file headers (rewritten tersely), hunk
// headers, and +/- lines; strips context lines, index/mode noise, and
// "\ No newline" markers. contextLines > 0 keeps that many context lines
// around each change.
export function summarizeDiff(diffText, { contextLines = 0 } = {}) {
  const lines = diffText.split("\n");
  const keep = new Array(lines.length).fill(false);
  const fileMeta = new Map(); // line index of "diff --git" → {path, notes[]}
  let files = 0;
  let additions = 0;
  let deletions = 0;
  let inHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("diff --git ")) {
      files++;
      inHeader = true;
      const m = / b\/(.+)$/.exec(l);
      fileMeta.set(i, { path: m ? m[1] : l.slice(11), notes: [] });
      continue;
    }
    if (inHeader) {
      const meta = [...fileMeta.values()].pop();
      if (l.startsWith("new file")) meta.notes.push("new file");
      else if (l.startsWith("deleted file")) meta.notes.push("deleted");
      else if (l.startsWith("rename from ")) meta.notes.push(`renamed from ${l.slice(12)}`);
      else if (l.startsWith("Binary files ")) {
        meta.notes.push("binary");
        inHeader = false;
      } else if (l.startsWith("@@")) {
        inHeader = false;
        keep[i] = true;
      }
      // index/mode/---/+++/similarity lines: dropped
      continue;
    }
    if (l.startsWith("@@")) {
      keep[i] = true;
    } else if (l.startsWith("+")) {
      additions++;
      keep[i] = true;
    } else if (l.startsWith("-")) {
      deletions++;
      keep[i] = true;
    }
    // context lines (" ") and "\ No newline" markers: dropped by default
  }

  if (contextLines > 0) {
    for (let i = 0; i < lines.length; i++) {
      if (!keep[i] || !(lines[i].startsWith("+") || lines[i].startsWith("-"))) continue;
      for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) {
        if (lines[j].startsWith(" ")) keep[j] = true;
      }
    }
  }

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (fileMeta.has(i)) {
      const meta = fileMeta.get(i);
      const note = meta.notes.length ? ` (${meta.notes.join(", ")})` : "";
      if (out.length) out.push("");
      out.push(`=== ${meta.path}${note}`);
      continue;
    }
    if (keep[i]) out.push(lines[i]);
  }

  return { summary: out.join("\n"), files, additions, deletions };
}

// ─── binary detection ────────────────────────────────────────────────────────

// Null byte in the first 512 bytes → almost certainly not a text file.
export function isProbablyBinary(buf) {
  const len = Math.min(buf.length, 512);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ─── generate_claudeignore ───────────────────────────────────────────────────

export function generateClaudeignore(projectPath) {
  const always = [
    "node_modules/", ".git/", "dist/", "build/", ".next/", "out/",
    "coverage/", ".nyc_output/", "*.min.js", "*.min.css", "*.map",
    "*.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    ".env*", "*.log", "logs/", "tmp/", ".cache/", "__pycache__/",
    "*.pyc", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/",
    "venv/", ".venv/", "*.egg-info/", "*.tsbuildinfo",
    ".DS_Store", "Thumbs.db",
  ];

  const has = (p) => fs.existsSync(path.join(projectPath, p));
  let rootEntries = [];
  try {
    rootEntries = fs.readdirSync(projectPath);
  } catch {
    // unreadable/missing path — fall back to defaults + existsSync checks
  }
  const hasExt = (ext) => rootEntries.some((e) => e.endsWith(ext));
  const hasPrefix = (pre) => rootEntries.some((e) => e.startsWith(pre));

  const extras = [];
  if (has("public")) extras.push("public/fonts/", "public/images/");
  if (has("migrations")) extras.push("migrations/*.sql");
  if (has("fixtures")) extras.push("fixtures/");
  if (has("Cargo.toml")) extras.push("target/");
  if (has("go.mod")) extras.push("vendor/", "bin/");
  if (has("build.gradle") || has("build.gradle.kts") || has("pom.xml")) extras.push("build/", ".gradle/", "*.class");
  if (has("Gemfile")) extras.push(".bundle/", "vendor/bundle/");
  if (has("composer.json")) extras.push("vendor/");
  if (hasExt(".tf")) extras.push(".terraform/", "*.tfstate", "*.tfstate.backup");
  if (has("turbo.json")) extras.push(".turbo/");
  if (has("vercel.json") || has(".vercel")) extras.push(".vercel/");
  if (hasPrefix("nuxt.config")) extras.push(".nuxt/", ".output/");
  if (hasPrefix("svelte.config")) extras.push(".svelte-kit/");
  if (has(".storybook")) extras.push("storybook-static/");
  if (hasPrefix("jest.config") || hasPrefix("vitest.config")) extras.push("__snapshots__/");

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
