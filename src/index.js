#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import { get_encoding } from "tiktoken";

const enc = get_encoding("cl100k_base");

function countTokens(text) {
  return enc.encode(text).length;
}

// ─── Compression helpers ───────────────────────────────────────────────────

function compressText(text) {
  return text
    .replace(/(?<!:)\/\/(?!.*["'`].*["'`]).*$/gm, "") // JS/TS line comments — skip :// (URLs) and lines where // is inside a string
    .replace(/\/\*[\s\S]*?\*\//g, "")                  // block comments
    .replace(/(^|\s)#(?!!).*$/gm, "$1")                // Python/shell comments — skip shebangs (#!)
    .replace(/^\s*[\r\n]/gm, "")                       // blank lines
    .replace(/[ \t]+/g, " ")                           // collapse whitespace
    .replace(/\n{3,}/g, "\n\n")                        // max 2 consecutive newlines
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

  if (relevant.size === 0) return content; // nothing matched, return as-is

  const sorted = [...relevant].sort((a, b) => a - b);
  const chunks = [];
  let prev = -2;
  let chunk = [];

  for (const idx of sorted) {
    if (idx > prev + 1) {
      if (chunk.length) chunks.push(chunk.join("\n"));
      chunk = [];
    }
    chunk.push(lines[idx]);
    prev = idx;
  }
  if (chunk.length) chunks.push(chunk.join("\n"));

  return chunks.join("\n\n... [snipped] ...\n\n");
}

// Patterns that indicate a line is high-priority (errors, failures, exceptions).
const PRIORITY_LINE_RE = /\b(FAIL|FAILED|ERROR|error:|Exception|Traceback|TypeError|SyntaxError|ReferenceError|AssertionError|✗|✕|ENOENT|EACCES|npm ERR!)\b/i;

function summarizeLongOutput(text, maxTokens = 400) {
  const tokens = countTokens(text);
  if (tokens <= maxTokens) return { summary: text, wasSummarized: false, originalTokens: tokens };

  const MARKER_BUDGET = 20; // reserve tokens for the truncation marker
  const budget = maxTokens - MARKER_BUDGET;

  const lines = text.split("\n").filter(Boolean);

  // Collect priority lines first (up to 20% of budget)
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

  // Fill remaining budget with lines from the top, skipping already-included priority lines
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

  // Merge and sort by original index to preserve order
  const allIndices = [...new Set([...topIndices, ...priorityIndices])].sort((a, b) => a - b);
  const keptTokens = topUsed + priorityUsed;

  const summary =
    allIndices.map((i) => lines[i]).join("\n") +
    `\n\n[...truncated. Original: ${tokens} tokens → kept: ${keptTokens} tokens (${Math.round((keptTokens / tokens) * 100)}%)]`;

  return { summary, wasSummarized: true, originalTokens: tokens, keptTokens };
}

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

// ─── MCP Server ───────────────────────────────────────────────────────────

const server = new Server(
  { name: "token-saver", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "compress_text",
      description:
        "Strips comments, blank lines, and excess whitespace from code or prose before sending to Claude. Returns compressed text and token savings.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text or code to compress" },
        },
        required: ["text"],
      },
    },
    {
      name: "smart_read_file",
      description:
        "Reads a file but only returns lines relevant to given keywords (±30 line window). Drastically reduces tokens for large files.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file" },
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "Keywords to focus on. Omit to get full file.",
          },
          compress: {
            type: "boolean",
            description: "Also strip comments and whitespace (default: true)",
            default: true,
          },
        },
        required: ["file_path"],
      },
    },
    {
      name: "summarize_output",
      description:
        "Truncates/summarizes a long string (e.g. command output, logs) to fit within a token budget while preserving the most important lines.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Long text to summarize" },
          max_tokens: {
            type: "number",
            description: "Token budget (default: 400)",
            default: 400,
          },
        },
        required: ["text"],
      },
    },
    {
      name: "count_tokens",
      description: "Counts how many tokens a piece of text uses (cl100k_base encoding).",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to count tokens for" },
        },
        required: ["text"],
      },
    },
    {
      name: "generate_claudeignore",
      description:
        "Generates a .claudeignore file for a project path to prevent Claude Code from indexing build artifacts, dependencies, and other token-heavy junk.",
      inputSchema: {
        type: "object",
        properties: {
          project_path: {
            type: "string",
            description: "Absolute path to the project root",
          },
          write_file: {
            type: "boolean",
            description: "If true, writes .claudeignore to the project path (default: false)",
            default: false,
          },
        },
        required: ["project_path"],
      },
    },
    {
      name: "optimize_prompt",
      description:
        "Takes a verbose prompt and rewrites it to be more concise while preserving intent. Returns the optimized prompt and token savings.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The verbose prompt to optimize" },
        },
        required: ["prompt"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "compress_text") {
      const original = args.text;
      const compressed = compressText(original);
      const before = countTokens(original);
      const after = countTokens(compressed);
      const saved = before - after;
      const pct = Math.round((saved / before) * 100);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              compressed_text: compressed,
              stats: { before_tokens: before, after_tokens: after, saved: saved, reduction_pct: `${pct}%` },
            }, null, 2),
          },
        ],
      };
    }

    if (name === "smart_read_file") {
      const filePath = args.file_path;
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

      let content = fs.readFileSync(filePath, "utf8");
      const originalTokens = countTokens(content);

      if (args.compress !== false) content = compressText(content);
      if (args.keywords && args.keywords.length > 0) {
        content = extractRelevantLines(content, args.keywords);
      }

      const finalTokens = countTokens(content);
      const saved = originalTokens - finalTokens;
      const pct = Math.round((saved / originalTokens) * 100);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              content,
              stats: {
                original_tokens: originalTokens,
                final_tokens: finalTokens,
                saved,
                reduction_pct: `${pct}%`,
                file: filePath,
              },
            }, null, 2),
          },
        ],
      };
    }

    if (name === "summarize_output") {
      const result = summarizeLongOutput(args.text, args.max_tokens || 400);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    if (name === "count_tokens") {
      const tokens = countTokens(args.text);
      return {
        content: [{ type: "text", text: JSON.stringify({ tokens, text_length: args.text.length }) }],
      };
    }

    if (name === "generate_claudeignore") {
      const content = generateClaudeignore(args.project_path);
      if (args.write_file) {
        const dest = path.join(args.project_path, ".claudeignore");
        fs.writeFileSync(dest, content);
        return {
          content: [{ type: "text", text: `✅ Written to ${dest}\n\n${content}` }],
        };
      }
      return {
        content: [{ type: "text", text: content }],
      };
    }

    if (name === "optimize_prompt") {
      const prompt = args.prompt;
      const beforeTokens = countTokens(prompt);

      // Rule-based lightweight optimization (no extra API call)
      const optimized = prompt
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

      const afterTokens = countTokens(optimized);
      const saved = beforeTokens - afterTokens;
      const pct = Math.round((saved / beforeTokens) * 100);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              optimized_prompt: optimized,
              stats: { before_tokens: beforeTokens, after_tokens: afterTokens, saved, reduction_pct: `${pct}%` },
            }, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
