# claude-web-ui

A local, **zero-dependency** browser companion for the [Claude Code](https://claude.com/claude-code) CLI.

One small Node server (standard library only — no `npm install`) gives your terminal Claude Code session a browser surface that does the things a terminal can't: render math, hold an isolated side-conversation, answer interactive prompts with a click, and show that Claude is still working.

The terminal session stays the source of truth — the browser is a **mirror** of it, not a replacement.

## Features

- **🪞 Live session mirror** (`/mirror`) — tails your terminal session's transcript (`.jsonl`) and renders it in the browser with full **Markdown + KaTeX** (inline `$…$` *and* display `$$…$$`), which the terminal can't show. Read-only, near-instant, and **costs zero extra tokens** (it just follows the file). A status bar shows model · effort · context % · rate-limit windows.
- **⌨️ Remote input** — type in the browser composer and it is injected into the live terminal session (Korean/IME-safe) via `cmux send`.
- **💬 `btw` side conversations** — a push-split side panel (button, the `btw <question>` composer prefix, or **⌘/Ctrl-B**) opens an **isolated, context-aware** side chat. It is seeded with your main conversation's recent context (or a full `--fork-session` on demand) but **never writes to the main transcript**. Read-only by default (`--permission-mode plan`).
- **❓ In-browser question picker** — renders Claude Code's `AskUserQuestion` prompts as clickable cards in the mirror and answers them by sending keystrokes to the terminal. (A pending picker isn't written to the `.jsonl` until answered, so it is scraped live from the terminal screen.)
- **✻ Working indicator** — shows *"Claude is working"* with the real elapsed time and token count, read from the terminal's live spinner — so you can tell a turn is progressing even during silent thinking, across multi-step turns.
- **💻 Headless chat** (`/`) — a standalone browser chat that drives its own headless `claude` process (separate from the mirrored terminal session).

## How it works

```
browser  ── SSE /mirror/stream ──◀  server  ◀── tails ~/.claude/projects/<cwd>/<id>.jsonl
browser  ── POST /mirror/send  ──▶  server  ──▶ cmux send / send-key  ──▶ terminal session
                                    server  ──▶ cmux read-screen      ──▶ picker + working spinner
```

- The mirror **follows the session `.jsonl`** incrementally (multi-byte-safe) and streams renderable events over Server-Sent Events.
- Remote input, the question picker, and the working indicator use [`cmux`](https://cmux.com) (`send` / `send-key` / `read-screen`) to drive and read the terminal.
- The status bar reads the JSON that Claude Code feeds its status-line command.
- No database, no framework, no dependencies — just Node built-ins.

## Requirements

- **Node.js** (any recent version — no `npm install` needed)
- **[Claude Code](https://claude.com/claude-code) CLI** (`claude` on your `PATH`)
- **[cmux](https://cmux.com)** — for remote input, the question picker, and the working indicator. The read-only math mirror works without it.
- macOS (the `cmux` integration is macOS-oriented)

## Usage

```bash
node server.mjs
# then open:
#   http://127.0.0.1:8765/mirror   ← live math-rendered mirror of your terminal session
#   http://127.0.0.1:8765/         ← standalone headless browser chat
```

To bind a mirror to a specific terminal session and `cmux` surface, pass them in the URL:

```
/mirror?session=<session-id>&surface=<cmux-surface-id-or-ref>
```

(`open-mirror.sh` is an example helper that captures the current terminal's session + surface from `cmux identify` and opens the mirror bound to them.)

### Configuration

All optional, via environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_WEB_PORT` | `8765` | HTTP port |
| `CLAUDE_WEB_CWD` | `process.cwd()` | working dir whose Claude Code sessions to mirror |
| `CLAUDE_BIN` | `claude` (or Homebrew path) | path to the `claude` binary |
| `CLAUDE_WEB_MODEL` | `opus` | model for the headless chat |
| `CLAUDE_WEB_PERM` | `bypassPermissions` | permission mode for the headless chat |

## Notes

- The server binds to `127.0.0.1` only (localhost).
- The **headless chat** defaults to `bypassPermissions` for a frictionless experience — set `CLAUDE_WEB_PERM` (e.g. `plan`) to tighten it. The **`btw` side sessions** are read-only (`plan`) by default regardless.

## License

[MIT](./LICENSE)
