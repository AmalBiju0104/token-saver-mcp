# token-saver-mcp

An MCP server plugin for Claude Code that **automatically reduces token usage** across your sessions. All optimizations are purely algorithmic — no extra API calls, no added cost.

## Tools

| Tool | What it does |
|------|-------------|
| `compress_text` | Strips comments, blank lines & whitespace from code/prose |
| `smart_read_file` | Reads only relevant sections of a file (keyword-focused ±30 line window) |
| `summarize_output` | Truncates long command output / logs to a token budget |
| `count_tokens` | Counts exact token usage for any text (cl100k_base encoding) |
| `generate_claudeignore` | Generates a `.claudeignore` to stop Claude indexing junk files |
| `optimize_prompt` | Rewrites verbose prompts to be concise (rule-based, no extra API call) |

## Benchmark results

Measured against real code fixtures and realistic prompt inputs. See [benchmark/BENCHMARK.md](benchmark/BENCHMARK.md) for full methodology.

| Tool | Avg token reduction | Best case |
|------|--------------------:|----------:|
| `compress_text` | 31% | 52% on JS with JSDoc |
| `smart_read_file` | 38% | 71% when keyword is near EOF |
| `summarize_output` | 75% | 84% on long build output |
| `optimize_prompt` | 22% | 29% on heavily padded prompts |
| `count_tokens` | accuracy tool — no reduction metric | — |
| `generate_claudeignore` | structural correctness tool — no reduction metric | — |

Run the benchmark yourself:

```bash
node benchmark/run.js
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

