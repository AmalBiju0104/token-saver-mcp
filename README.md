# token-saver-mcp

An MCP server plugin for Claude Code that **automatically reduces token usage** across your sessions. All optimizations are purely algorithmic — no extra API calls, no added cost.

## Tools

| Tool | What it does |
|------|-------------|
| `compress_text` | Strips comments, blank lines & whitespace from code/prose. String-aware: never corrupts URLs or `#` inside string literals |
| `smart_read_file` | Reads only relevant sections of a file. Structure-aware: returns the complete enclosing function/class around keyword matches, with a configurable fallback window |
| `summarize_output` | Truncates long command output / logs to a token budget. Preserves error/failure lines anywhere in the output, keeps head + tail, collapses duplicate lines |
| `count_tokens` | Counts token usage for any text (cl100k_base encoding) |
| `generate_claudeignore` | Generates a `.claudeignore` covering Node, Python, Rust, Go, Java, Ruby & PHP artifacts, seeded from your existing `.gitignore` |
| `optimize_prompt` | Rewrites verbose prompts to be concise. Fenced code blocks and inline code are passed through untouched |

All tools return plain text with a compact stats footer — results are deliberately **not** JSON-wrapped, since JSON escaping of newlines and quotes would inflate the very token count this server exists to reduce.

> **Note on token counts:** the server uses the `cl100k_base` encoding (via tiktoken), which is OpenAI's tokenizer. Claude's tokenizer differs, so all counts are approximations — typically within ~10–20% of Claude's actual usage. Relative savings percentages are unaffected.

## Benchmark results

Measured against real code fixtures and realistic prompt inputs. See [benchmark/BENCHMARK.md](benchmark/BENCHMARK.md) for full methodology.

| Tool | Avg token reduction | Best case |
|------|--------------------:|----------:|
| `compress_text` | 35% | 53% on JS with JSDoc |
| `smart_read_file` | 59% | 80% extracting one function from a module |
| `summarize_output` | 76% | 84% on long build output |
| `optimize_prompt` | 23% | 29% on heavily padded prompts |
| `count_tokens` | accuracy tool — no reduction metric | — |
| `generate_claudeignore` | structural correctness tool — no reduction metric | — |

Run the benchmark yourself:

```bash
npm run benchmark
```

---

## Installation

### 1. Clone and install

```bash
git clone <your-repo-url> token-saver-mcp
cd token-saver-mcp
npm install
```

### 2. Add to Claude Code

```bash
claude mcp add token-saver -- node /absolute/path/to/token-saver-mcp/src/index.js
```

Or manually edit `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "token-saver": {
      "command": "node",
      "args": ["/absolute/path/to/token-saver-mcp/src/index.js"]
    }
  }
}
```

### 3. Verify

```bash
claude mcp list
```

You should see `token-saver` listed as connected.

---

## Usage examples

```
Use smart_read_file on src/api/routes.js, focus on "authentication" and "middleware"
```

```
Generate a .claudeignore for my project at /home/user/myapp and write it to disk
```

```
Count tokens in this output: [paste output]
```

```
Compress this before sending: [paste code]
```

