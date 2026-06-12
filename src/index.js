#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import {
  countTokens,
  compressText,
  extractRelevantLines,
  summarizeLongOutput,
  summarizeDiff,
  optimizePrompt,
  generateClaudeignore,
  isProbablyBinary,
} from "./lib.js";

// Tool results are returned as plain text with a one-line stats footer.
// JSON-wrapping the content would escape every newline and quote, inflating
// the very token count this server exists to reduce.

function pct(before, after) {
  return before > 0 ? Math.round(((before - after) / before) * 100) : 0;
}

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

const server = new Server(
  { name: "token-saver", version: "1.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "compress_text",
      description:
        "Strips comments (//, /* */, #, <!-- -->), blank lines, and excess whitespace from code or prose before sending to Claude. String-aware: comment markers inside string literals (URLs, hashtags), CSS hex colors, and bare URLs are preserved; comments inside template-literal ${} expressions are stripped. Returns compressed text with a token-savings footer.",
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
        "Reads a file but only returns sections relevant to given keywords. Structure-aware across JS/TS, Python, Go, Rust, Java, and C#: returns the complete enclosing function/class/interface when a keyword matches inside one, otherwise a configurable line window. Rejects binary files. Drastically reduces tokens for large files.",
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
          window_size: {
            type: "number",
            description: "Fallback context window in lines around matches outside any function (default: 30)",
            default: 30,
          },
          include_line_numbers: {
            type: "boolean",
            description: "Prefix each line with its line number (default: false; costs extra tokens)",
            default: false,
          },
        },
        required: ["file_path"],
      },
    },
    {
      name: "summarize_output",
      description:
        "Truncates a long string (e.g. command output, logs) to fit within a token budget. Preserves error/failure lines wherever they appear, keeps both the head and the tail, and collapses duplicate lines with a repeat count.",
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
      name: "summarize_diff",
      description:
        "Compacts a unified git diff: keeps file headers (rewritten tersely), hunk headers, and added/removed lines; strips context lines, index/mode noise, and redundant +++/--- headers. Renames and binary files are annotated. Typically cuts diff tokens by 40-70%.",
      inputSchema: {
        type: "object",
        properties: {
          diff: { type: "string", description: "Unified diff text (git diff output)" },
          context_lines: {
            type: "number",
            description: "Context lines to keep around each change (default: 0)",
            default: 0,
          },
        },
        required: ["diff"],
      },
    },
    {
      name: "count_tokens",
      description:
        "Counts tokens using the cl100k_base encoding. Note: this is OpenAI's encoding — Claude's tokenizer differs, so treat counts as approximations (typically within ~10-20%).",
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
        "Generates a .claudeignore file for a project. Covers Node, Python, Rust, Go, Java, Ruby, and PHP artifacts, and seeds additional entries from the project's existing .gitignore.",
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
        "Takes a verbose prompt and rewrites it to be more concise while preserving intent. Fenced code blocks and inline code spans are passed through untouched. Rule-based — no extra API call.",
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
      return text(
        `${compressed}\n\n[token-saver] ${before} → ${after} tokens (saved ${pct(before, after)}%)`
      );
    }

    if (name === "smart_read_file") {
      const filePath = args.file_path;
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

      const buf = fs.readFileSync(filePath);
      if (isProbablyBinary(buf)) {
        throw new Error(`Binary file, not text: ${filePath} (${buf.length} bytes)`);
      }
      let content = buf.toString("utf8");
      const originalTokens = countTokens(content);

      if (args.compress !== false) content = compressText(content);
      if (args.keywords && args.keywords.length > 0) {
        content = extractRelevantLines(content, args.keywords, {
          windowSize: args.window_size ?? 30,
          lineNumbers: args.include_line_numbers ?? false,
        });
      }

      const finalTokens = countTokens(content);
      return text(
        `${content}\n\n[token-saver] ${filePath}: ${originalTokens} → ${finalTokens} tokens (saved ${pct(originalTokens, finalTokens)}%)`
      );
    }

    if (name === "summarize_output") {
      const result = summarizeLongOutput(args.text, args.max_tokens || 400);
      // The summary already carries its own truncation marker when summarized
      return text(result.summary);
    }

    if (name === "summarize_diff") {
      const result = summarizeDiff(args.diff, { contextLines: args.context_lines ?? 0 });
      const before = countTokens(args.diff);
      const after = countTokens(result.summary);
      return text(
        `${result.summary}\n\n[token-saver] ${result.files} file(s), +${result.additions}/-${result.deletions} | ${before} → ${after} tokens (saved ${pct(before, after)}%)`
      );
    }

    if (name === "count_tokens") {
      const tokens = countTokens(args.text);
      return text(
        `${tokens} tokens (cl100k_base — approximate for Claude models), ${args.text.length} chars`
      );
    }

    if (name === "generate_claudeignore") {
      const content = generateClaudeignore(args.project_path);
      if (args.write_file) {
        const dest = path.join(args.project_path, ".claudeignore");
        fs.writeFileSync(dest, content);
        return text(`✅ Written to ${dest}\n\n${content}`);
      }
      return text(content);
    }

    if (name === "optimize_prompt") {
      const prompt = args.prompt;
      const optimized = optimizePrompt(prompt);
      const before = countTokens(prompt);
      const after = countTokens(optimized);
      return text(
        `${optimized}\n\n[token-saver] ${before} → ${after} tokens (saved ${pct(before, after)}%)`
      );
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
