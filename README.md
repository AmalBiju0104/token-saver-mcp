# token-saver-mcp

An MCP server plugin for Claude Code that **automatically reduces token usage** across your sessions. All optimizations are purely algorithmic — no extra API calls, no added cost.

## Tools

| Tool | What it does |
|------|-------------|
| `compress_text` | Strips comments (`//`, `/* */`, `#`, `<!-- -->`), blank lines & whitespace from code/prose. String-aware: never corrupts URLs, `#hashtag`/`#fff` hex colors, or markers inside string literals; comments inside template-literal `${}` expressions are stripped |
| `smart_read_file` | Reads only relevant sections of a file. Structure-aware across JS/TS, Python, Go, Rust, Java & C#: returns the complete enclosing function/class/interface around keyword matches, with a configurable fallback window. Rejects binary files |
| `summarize_output` | Truncates long command output / logs to a token budget. Preserves error/failure lines anywhere in the output, keeps head + tail, collapses duplicate lines |
| `summarize_diff` | Compacts a unified git diff: keeps file headers, hunk headers & changed lines; strips context lines and index/mode noise. Renames and binary files are annotated |
| `count_tokens` | Counts token usage for any text (cl100k_base encoding) |
| `generate_claudeignore` | Generates a `.claudeignore` covering Node, Python, Rust, Go, Java, Ruby, PHP & Terraform artifacts plus modern tooling caches (Turbo, Vercel, Nuxt, SvelteKit, Storybook), seeded from your existing `.gitignore` |
| `optimize_prompt` | Rewrites verbose prompts to be concise (~40 filler-phrase rules). Fenced code blocks and inline code are passed through untouched |

All tools return plain text with a compact stats footer — results are deliberately **not** JSON-wrapped, since JSON escaping of newlines and quotes would inflate the very token count this server exists to reduce.

> **Note on token counts:** the server uses the `cl100k_base` encoding (via tiktoken), which is OpenAI's tokenizer. Claude's tokenizer differs, so all counts are approximations — typically within ~10–20% of Claude's actual usage. Relative savings percentages are unaffected.

## Benchmark results

Measured against real code fixtures and realistic prompt inputs. See [benchmark/BENCHMARK.md](benchmark/BENCHMARK.md) for full methodology.

| Tool | Avg token reduction | Best case |
|------|--------------------:|----------:|
| `compress_text` | 31% | 53% on JS with JSDoc |
| `smart_read_file` | 44%* | 81% extracting one function from a module |
| `summarize_output` | 76% | 84% on long build output |
| `summarize_diff` | 50% | 53% on a multi-file diff with renames |
| `optimize_prompt` | 28% | 52% on heavily padded prompts |
| `count_tokens` | accuracy tool — no reduction metric | — |
| `generate_claudeignore` | structural correctness tool — no reduction metric | — |

\* the `smart_read_file` average includes tiny synthetic fixtures used as multi-language correctness tests; on realistic files it ranges 38–81%.

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

