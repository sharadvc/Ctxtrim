# ctxtrim

**Trim what bloats your AI coding context.** Claude Code, Cursor, and Codex send your files as context on *every* request — so a lockfile, a `dist/` bundle, or a big JSON quietly makes every message cost more. `ctxtrim` finds that junk and writes the ignore files that cut it.

```bash
npx ctxtrim            # see what's costing you tokens
npx ctxtrim --write    # write .cursorignore + .aiexclude to cut it
```

[![npm](https://img.shields.io/npm/v/ctxtrim.svg)](https://www.npmjs.com/package/ctxtrim) [![CI](https://github.com/AgentPostmortem/ctxtrim/actions/workflows/ci.yml/badge.svg)](https://github.com/AgentPostmortem/ctxtrim/actions) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
**npm:** https://www.npmjs.com/package/ctxtrim  ·  **Source:** https://github.com/AgentPostmortem/Ctxtrim

---

## Quickstart

No install required — `npx` runs the latest release:

```bash
cd your-repo
npx ctxtrim              # scan: see what's bloating context (report only)
npx ctxtrim --write      # write .cursorignore + .aiexclude to trim it
```

Example report (numbers vary by repo):

```
ctxtrim  ·  my-repo  ·  412 files

  Full context load: ~1.2M tokens  (~$3.61 @ $3/M input)
  Trimmable:         ~890k tokens (73%)  → save ~$2.67 per load

  Top offenders
    ~410k   $1.23  package-lock.json      — dependency lockfile
    ~180k   $0.54  data/cities.json       — large json (180k tokens)
     ~80k   $0.24  dist/                  — build / generated output directory

  Run with --write to create .cursorignore / .aiexclude and cut this from context.
```

After `npx ctxtrim --write`, the last line becomes something like: `✓ .cursorignore (created, 34 patterns), .aiexclude (created, 34 patterns)`.

## Why

AI coding tools re-send your context with every turn — *"a one-line question in a session that's been open all day still draws usage for the whole conversation,"* and **large context can cost 3× the tokens.** Usage dashboards (like ccusage) tell you *how much you spent* after the fact. `ctxtrim` is the other half: it tells you **what to stop sending** so the bill is smaller in the first place.

It flags the files that are high-cost and low-value for a model — lockfiles, `dist/`/`build/` output, `node_modules`, minified bundles, big data/JSON, generated code — and generates the ignore files your tools already honor.

## What you get

```
ctxtrim  ·  my-repo  ·  412 files

  Full context load: ~1.2M tokens  (~$3.61 @ $3/M input)
  Trimmable:         ~890k tokens (73%)  → save ~$2.67 per load

  by category: lockfile 410k · vendored 260k · data 140k · build 80k

  Top offenders
    ~410k   $1.23  package-lock.json      — dependency lockfile
    ~180k   $0.54  data/cities.json       — large json (180k tokens)
     ~80k   $0.24  dist/                  — build / generated output directory
     ...

  ✓ .cursorignore (created, 34 patterns), .aiexclude (created, 34 patterns)
```

Estimates use the widely-cited ~4-chars-per-token rule (great for ranking and relative savings; pass `--price` to match your model).

## Usage

```bash
npx ctxtrim [path] [options]

npx ctxtrim                       # report on the current repo
npx ctxtrim --write               # write .cursorignore + .aiexclude
npx ctxtrim ./repo --price 15     # estimate at Opus-tier input pricing
npx ctxtrim --format json         # machine-readable
npx ctxtrim --fail-on-waste 40    # CI: exit 1 if 40%+ of context is junk
```

At most one path may be supplied; omitting it uses the current directory. Extra paths
are a usage error (exit code 2), detected before scanning or writing files.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--write` | off | create/update the ignore files (otherwise report only) |
| `--targets <list>` | `cursor,gemini` | `cursor`→`.cursorignore`, `gemini`→`.aiexclude`, `generic`→`.aiignore` |
| `--price <usd>` | `3` | $ per 1M input tokens for the estimate |
| `--max-tokens <n>` | `2000` | a file over this counts as "large" data |
| `--top <n>` | `12` | offenders to list |
| `--format <text\|json>` | `text` | |
| `--fail-on-waste <pct>` | — | exit `1` if trimmable context ≥ pct (CI gate) |

**Ignore files it writes** (all real formats the tools honor): `.cursorignore` (Cursor), `.aiexclude` (Gemini Code Assist / Firebase Studio), `.aiignore` (generic). Writes are **idempotent** — a managed block between markers, so your own rules are preserved and re-runs just update the block.

Repeated names in `--targets` are ignored; each ignore file is written and reported once, in the order first requested.

## What it is (and isn't)

- A **fast, deterministic, zero-dependency** heuristic — no model calls, nothing uploaded.
- It **won't touch source you actually want seen** — run it on a lean repo and it says "already lean ✓".
- Token counts are **estimates** for ranking and savings math, not billing-exact.
- It writes *ignore* files; it never deletes anything.

## Related

Pairs with [ctxlens](https://github.com/AgentPostmortem/Ctxlens) (profiles a *running* agent's context) — ctxtrim is the *static, pre-emptive* half. Part of a small agent-tooling set alongside [skill-audit](https://github.com/AgentPostmortem/skill-audit) and [mcp-audit](https://github.com/AgentPostmortem/MCP-audit).

## License

MIT
