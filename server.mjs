#!/usr/bin/env node
// claude-web-ui — a local browser chat front-end for the locally-installed Claude Code.
// Drives one persistent `claude` process in stream-json mode (cwd = vault) and relays
// every event to the browser over SSE. The browser renders markdown + KaTeX (inline AND
// display math), which the terminal and the desktop app cannot do.
//
// Zero npm dependencies: Node built-ins only (http, child_process, fs, path, url, os).
//
// Architecture:
//   browser  --POST /send {text}-->  server  --stdin JSON line-->  claude (stream-json)
//   browser  <--SSE /events---------  server  <--stdout JSON lines-- claude
//
// Run:  node ~/claude-web-ui/server.mjs   (or the `claude-web` launcher)

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync, watch } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- config
const CFG = {
  port:    Number(process.env.CLAUDE_WEB_PORT || 8765),
  host:    '127.0.0.1',
  vault:   process.env.CLAUDE_WEB_CWD || process.cwd(),
  bin:     process.env.CLAUDE_BIN ||
           (existsSync('/opt/homebrew/bin/claude') ? '/opt/homebrew/bin/claude' : 'claude'),
  model:   process.env.CLAUDE_WEB_MODEL || 'opus',
  // Frictionless: tools run without asking (user chose this). One-line change to tighten.
  permissionMode: process.env.CLAUDE_WEB_PERM || 'bypassPermissions',
};

// Claude Code stores every session as <id>.jsonl under a dir named after the encoded cwd.
// e.g. cwd /Users/you/vault  ->  ~/.claude/projects/-Users-you-vault/
const PROJDIR = join(process.env.HOME, '.claude/projects', CFG.vault.replace(/\//g, '-'));

// ---------------------------------------------------------------- claude process
let claude     = null;     // the live child process, or null
let sessionId  = null;     // captured from stream events; used to resume after a crash
let curModel   = CFG.model;
let starting   = false;
let stdoutBuf  = '';
const sse       = new Set(); // connected SSE response objects

function log(...a) { console.log('[claude-web]', ...a); }

function broadcast(obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sse) { try { res.write(payload); } catch { /* client gone */ } }
}

// Start (or resume) the claude process. resume=true reuses the captured sessionId so a
// crash mid-conversation reconnects seamlessly; a fresh start (resume=false) is a new chat.
function startClaude({ resume = false, model = curModel } = {}) {
  if (claude || starting) return;
  starting = true;
  curModel = model;
  const args = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',                       // required so all events stream (not just result)
    '--include-partial-messages',      // token-ish deltas for live typing
    '--permission-mode', CFG.permissionMode,
    '--model', model,
  ];
  if (resume && sessionId) args.push('--resume', sessionId);

  log('spawn', CFG.bin, args.join(' '), '(cwd', CFG.vault + ')');
  const child = spawn(CFG.bin, args, {
    cwd: CFG.vault,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  claude = child;
  starting = false;
  stdoutBuf = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.trim()) onClaudeLine(line);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    const s = d.toString();
    log('stderr:', s.trim());
    broadcast({ type: '_stderr', text: s });
  });

  child.on('exit', (code, signal) => {
    log('claude exited', code, signal);
    claude = null;
    broadcast({ type: '_proc', status: 'exited', code, signal });
    // keep sessionId so the next /send transparently resumes the same conversation
  });
  child.on('error', (err) => {
    log('spawn error', err.message);
    claude = null;
    starting = false;
    broadcast({ type: '_proc', status: 'error', error: err.message });
  });

  broadcast({ type: '_proc', status: 'started', model: curModel, resumed: !!(resume && sessionId) });
}

function onClaudeLine(line) {
  let obj;
  try { obj = JSON.parse(line); }
  catch { broadcast({ type: '_raw', text: line }); return; }
  // capture session id wherever it appears
  if (obj.session_id && !sessionId) { sessionId = obj.session_id; }
  if (obj.session_id) sessionId = obj.session_id;
  broadcast(obj);
}

function ensureClaude() {
  if (!claude && !starting) startClaude({ resume: !!sessionId });
}

function sendUser(text) {
  ensureClaude();
  if (!claude) return false;
  const msg = { type: 'user', message: { role: 'user', content: text } };
  try { claude.stdin.write(JSON.stringify(msg) + '\n'); return true; }
  catch (e) { log('stdin write failed', e.message); return false; }
}

function newConversation(model = curModel) {
  if (claude) { try { claude.kill('SIGTERM'); } catch {} claude = null; }
  sessionId = null;
  setTimeout(() => startClaude({ resume: false, model }), 150);
}

function changeModel(model) {
  // resume the same conversation under a new model if one exists, else fresh
  const resume = !!sessionId;
  if (claude) { try { claude.kill('SIGTERM'); } catch {} claude = null; }
  setTimeout(() => startClaude({ resume, model }), 150);
}

// ---------------------------------------------------------------- http
const HTML_PATH   = join(__dirname, 'index.html');
const MIRROR_PATH = join(__dirname, 'mirror.html');
const BTW_PATH    = join(__dirname, 'btw.html');

function readBody(req) {
  return new Promise((resolve) => {                                  // collect Buffers, decode ONCE as utf8
    const chunks = []; req.on('data', (c) => chunks.push(c));        // (b += chunk corrupts multi-byte
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); //  Korean split across chunks)
  });
}
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------- mirror (live view of THIS terminal session)
// Resolve which session .jsonl to tail: an explicit id, else the newest one in PROJDIR
// EXCLUDING our own headless chat session (so the mirror shows the terminal conversation).
function resolveSessionFile(sid) {
  try {
    if (sid) {                                                // explicit session id → search ALL project dirs (any cwd)
      if (!/^[a-f0-9-]+$/i.test(sid)) return null;            // guard against path traversal
      const root = join(process.env.HOME, '.claude/projects');
      for (const d of readdirSync(root)) {
        const p = join(root, d, sid + '.jsonl');
        if (existsSync(p)) return p;
      }
      return null;
    }
    const skip = sessionId ? sessionId + '.jsonl' : null;     // no sid → newest in vault dir, minus our headless chat
    let best = null, bestM = 0;
    for (const f of readdirSync(PROJDIR)) {
      if (!f.endsWith('.jsonl') || f === skip) continue;
      const st = statSync(join(PROJDIR, f));
      if (st.mtimeMs > bestM) { bestM = st.mtimeMs; best = f; }
    }
    return best ? join(PROJDIR, best) : null;
  } catch { return null; }
}

// Keep only what a human wants to see in a chat transcript.
function isRealUser(s) {
  if (!s) return false; s = s.trim(); if (!s) return false;
  if (s[0] === '<') return false;                              // system-reminder / injected wrappers
  if (s.startsWith('[Request interrupted')) return false;
  if (s.includes('<system-reminder') || s.includes('<command-name') ||
      s.includes('<local-command') || s.includes('tool_use_id')) return false;
  return true;
}
function extractRenderable(o) {
  const out = [], t = o.type, m = o.message || {};
  if (t === 'user') {
    const c = m.content;
    if (typeof c === 'string') { if (isRealUser(c)) out.push({ type: 'msg', role: 'user', text: c }); }
    else if (Array.isArray(c)) for (const b of c) {
      if (b.type === 'text' && isRealUser(b.text)) out.push({ type: 'msg', role: 'user', text: b.text });
    }
  } else if (t === 'assistant') {
    const c = m.content;
    if (typeof c === 'string') { if (c.trim()) out.push({ type: 'msg', role: 'assistant', kind: 'text', text: c }); }
    else if (Array.isArray(c)) for (const b of c) {
      if (b.type === 'text' && b.text && b.text.trim()) out.push({ type: 'msg', role: 'assistant', kind: 'text', text: b.text });
      else if (b.type === 'tool_use') out.push({ type: 'msg', role: 'assistant', kind: 'tool', name: b.name, input: b.input });
      // AskUserQuestion shows as a tool box in HISTORY; the LIVE interactive picker comes from the
      // read-screen poller (a pending question is NOT in the jsonl until answered — verified).
      // thinking blocks intentionally skipped — the mirror shows the conversation, not internal reasoning
    }
  }
  return out;
}
// Parse a Claude Code AskUserQuestion widget out of a `read-screen` dump → {id,header,question,
// options:[{n,label}]} (PROVIDED options only; drops the auto-appended "Type something."/"Chat
// about this" rows) or null if no picker is up. The pending question isn't in the jsonl, so this
// screen scrape is the only real-time source.
function djb2(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function parsePicker(screen) {
  if (!screen) return null;
  const lines = screen.split('\n');
  // The LIVE widget is the BOTTOM-most one. The mirrored conversation scrollback may itself quote
  // the footer text or contain numbered lists, so anchor on the last footer + require the ❯ cursor.
  let footIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/Enter to (?:select|confirm)/.test(lines[i]) && /(?:navigate|cancel)/.test(lines[i])) { footIdx = i; break; }
  }
  if (footIdx < 0) return null;
  const rowRe = /^\s*(❯)?\s*(\d+)\.\s+(.*\S)\s*$/;                 // "❯ 1. label" / "  2. label"
  const found = [];
  for (let i = Math.max(0, footIdx - 80); i < footIdx; i++) {
    const m = lines[i].match(rowRe);
    if (m) found.push({ idx: i, cursor: !!m[1], n: Number(m[2]), label: m[3].trim() });
  }
  if (!found.length) return null;
  // take the consecutive run 1,2,3,… whose "1" is nearest the footer (the widget's option list)
  let start = -1;
  for (let k = found.length - 1; k >= 0; k--) if (found[k].n === 1) { start = k; break; }
  if (start < 0) return null;
  const opts = []; let expect = 1;
  for (let k = start; k < found.length; k++) if (found[k].n === expect) { opts.push(found[k]); expect++; }
  if (!opts.some((o) => o.cursor)) return null;                   // ❯ cursor REQUIRED → rules out prose lists
  const provided = opts.filter((o) => !/^(Type something\.?|Chat about this)$/i.test(o.label));
  if (!provided.length) return null;
  const firstIdx = opts[0].idx;
  let header = '', hIdx = -1;
  for (let i = 0; i < firstIdx; i++) { const hl = lines[i].match(/^\s*[☐☑]\s*(.+\S)\s*$/); if (hl) { header = hl[1].trim(); hIdx = i; } }
  const qparts = [];                                              // question may wrap across lines
  for (let i = hIdx + 1; i < firstIdx; i++) { const t = lines[i].trim(); if (t && !/^[─-]+$/.test(t) && !/^[☐☑]/.test(t)) qparts.push(t); }
  const question = qparts.join(' ');
  const id = 'scr:' + djb2(header + '|' + question + '|' + provided.map((o) => o.n + o.label).join('|'));
  return { id, header, question, options: provided };
}
// Detect Claude Code's live "working" spinner in a read-screen dump.
// Spinner line looks like:  ✻ <verb>… (2m 12s · ↓ 8.9k tokens)   ; idle screen has only the ❯ input box.
function detectWorking(screen){
  if(!screen) return { active:false };
  const tail = screen.split('\n').filter(l=>l.trim()).slice(-15).join('\n');  // live spinner sits at the bottom, not in scrollback
  const m = tail.match(/\(((?:\d+m\s*)?\d+s)\s*·[^)]*?([\d.]+k?)\s*tokens?\)/);
  if(m) return { active:true, elapsed:m[1], tokens:m[2] };
  if(/esc to interrupt/.test(tail)) return { active:true };
  return { active:false };
}
function startMirror(req, res, sid, surface) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('retry: 2000\n\n');
  const file = resolveSessionFile(sid);
  if (!file) { res.write(`data: ${JSON.stringify({ type: '_err', error: 'no session jsonl found' })}\n\n`); return; }
  const resolvedSid = file.split('/').pop().replace('.jsonl', '');   // the session this mirror tails
  res.write(`data: ${JSON.stringify({ type: '_info', session: resolvedSid })}\n\n`);
  // Incremental tail: read only NEW bytes since last offset; StringDecoder keeps multi-byte
  // (Korean) chars intact across read boundaries; only whole '\n'-terminated lines are emitted.
  let offset = 0, carry = '', closed = false, lastEffort = '';
  const dec = new StringDecoder('utf8');
  function pump() {
    if (closed) return;
    let st; try { st = statSync(file); } catch { return; }
    if (st.size < offset) { offset = 0; carry = ''; }          // file truncated/rotated
    if (st.size <= offset) return;
    let fd;
    try {
      fd = openSync(file, 'r');
      const len = st.size - offset, buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, offset);
      offset = st.size; carry += dec.write(buf);
    } catch { return; } finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
    let nl;
    while ((nl = carry.indexOf('\n')) >= 0) {
      const ln = carry.slice(0, nl); carry = carry.slice(nl + 1);
      if (!ln.trim()) continue;
      const em = ln.match(/Set effort level to ([a-z]+)/i); if (em) lastEffort = em[1];   // /effort sets ultracode etc.
      let o; try { o = JSON.parse(ln); } catch { continue; }
      for (const it of extractRenderable(o)) { try { res.write(`data: ${JSON.stringify(it)}\n\n`); } catch {} }
    }
  }
  // status line: read the JSON Claude Code feeds to its statusline command (teed to /tmp by
  // ~/.claude/statusline-command.sh) → model / effort / context% / 5h & 7d rate-limit remaining.
  function emitStatus() {
    // prefer THIS session's own status file (per-session, written by the statusline hook) so two
    // workspaces' mirrors don't clobber each other via the shared last-writer-wins file
    const perSession = resolvedSid ? `/tmp/claude-statusline-${resolvedSid}.json` : null;
    const statusFile = (perSession && existsSync(perSession)) ? perSession : '/tmp/claude-statusline.json';
    let s; try { s = JSON.parse(readFileSync(statusFile, 'utf8')); } catch { return; }
    const rl = s.rate_limits || {};
    const u5 = rl.five_hour && rl.five_hour.used_percentage, u7 = rl.seven_day && rl.seven_day.used_percentage;
    const st = {
      type: '_status',
      model: (s.model && s.model.display_name) || '',
      effort: lastEffort || ((s.effort && s.effort.level) || ''),   // prefer the last /effort setting (shows "ultracode")
      ctxPct: (s.context_window && s.context_window.used_percentage) != null ? Math.round(s.context_window.used_percentage) : null,
      r5: (u5 != null) ? Math.round(u5) : null,   // used %
      r7: (u7 != null) ? Math.round(u7) : null,
    };
    try { res.write(`data: ${JSON.stringify(st)}\n\n`); } catch {}
  }
  pump();                                                       // initial backfill
  emitStatus();
  let wt = null; try { wt = watch(file, () => pump()); } catch {}  // fs.watch → near-instant updates
  const iv = setInterval(pump, 500);                            // fallback poll (fs.watch can miss events)
  const sv = setInterval(emitStatus, 1500);                     // refresh status line
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 25000);
  // LIVE AskUserQuestion picker: scrape the terminal screen (the pending question isn't in the jsonl).
  let lastPickerId = null;
  async function pollPicker() {
    if (closed || !surface) return;
    const r = await cmuxOut(['read-screen', '--surface', surface]);
    if (!r.ok) return;
    const w = detectWorking(r.out);   // piggyback on the SAME dump → live "working" ground truth
    try { res.write(`data: ${JSON.stringify({ type:'_working', active:w.active, elapsed:w.elapsed||null, tokens:w.tokens||null })}\n\n`); } catch {}
    const p = parsePicker(r.out);
    if (p) {
      if (p.id !== lastPickerId) {                                // a (new) picker appeared
        lastPickerId = p.id;
        const ev = { type: 'askq', id: p.id, live: true, questions: [{ header: p.header, question: p.question, multiSelect: false, options: p.options.map((o) => ({ label: o.label })) }] };
        try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {}
      }
    } else if (lastPickerId) {                                    // the picker went away → resolved
      try { res.write(`data: ${JSON.stringify({ type: 'askq_done', id: lastPickerId, content: '' })}\n\n`); } catch {}
      lastPickerId = null;
    }
  }
  const pp = surface ? setInterval(pollPicker, 700) : null;
  req.on('close', () => { closed = true; if (wt) { try { wt.close(); } catch {} } clearInterval(iv); clearInterval(sv); clearInterval(ka); if (pp) clearInterval(pp); });
}

// ---------------------------------------------------------------- remote input (browser → terminal session)
// Inject browser-typed text into the live terminal Claude session via `cmux send` (types + Enter).
// Target surface id is read from ~/claude-web-ui/.target-surface (written by /browser or by hand).
const CMUX_BIN = process.env.CMUX_BIN ||
  (existsSync('/Applications/cmux.app/Contents/Resources/bin/cmux')
    ? '/Applications/cmux.app/Contents/Resources/bin/cmux' : 'cmux');
function getTargetSurface() {
  try { return readFileSync(join(__dirname, '.target-surface'), 'utf8').trim(); }
  catch { return process.env.CLAUDE_WEB_SURFACE || ''; }
}
// a surface is addressed by a short ref (surface:39) OR a stable uuid (8013A16C-…); accept both
const SURFACE_RE = /^(surface:\d+|[0-9a-fA-F][0-9a-fA-F-]{7,})$/;
function resolveTarget(surface) {
  // per-mirror surface (from its URL) wins; .target-surface is only a fallback
  return (surface && SURFACE_RE.test(surface)) ? surface : getTargetSurface();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Run one cmux subcommand, awaiting the real exit code so a dead socket / stale-or-gone surface
// (non-zero exit) is surfaced to the browser instead of a silent false "ok".
function cmux(args) {
  return new Promise((resolve) => {
    // CRITICAL: strip this server's own cmux caller-context. `cmux send` resolves the target
    // surface relative to CMUX_WORKSPACE_ID/CMUX_SURFACE_ID of the caller, and REJECTS a target
    // in a different workspace with "Surface is not a terminal". This server is long-lived and was
    // spawned inside whatever workspace happened to be active, so without stripping these the mirror
    // could only reach terminals sharing that workspace. Removing them forces global resolution.
    const env = { ...process.env };
    for (const k of ['CMUX_WORKSPACE_ID','CMUX_SURFACE_ID','CMUX_TAB_ID','CMUX_PANEL_ID','CMUX_PANE_ID','CMUX_WINDOW_ID']) delete env[k];
    let c;
    try { c = spawn(CMUX_BIN, args, { env }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    let err = '';
    if (c.stderr) c.stderr.on('data', (d) => { err += d; });
    c.on('error', (e) => resolve({ ok: false, error: e.message }));
    c.on('exit', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: (err.trim() || `cmux ${args[0]} exited ${code}`) }));
  });
}
const cmuxSend    = (target, text) => cmux(['send', '--surface', target, '--', text]);
const cmuxSendKey = (target, key)  => cmux(['send-key', '--surface', target, key]);
// like cmux() but captures stdout (for read-screen)
function cmuxOut(args) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of ['CMUX_WORKSPACE_ID','CMUX_SURFACE_ID','CMUX_TAB_ID','CMUX_PANEL_ID','CMUX_PANE_ID','CMUX_WINDOW_ID']) delete env[k];
    let c, out = '';
    try { c = spawn(CMUX_BIN, args, { env }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    if (c.stdout) c.stdout.on('data', (d) => { out += d; });
    c.on('error', (e) => resolve({ ok: false, error: e.message }));
    c.on('exit', (code) => resolve(code === 0 ? { ok: true, out } : { ok: false, error: 'exit ' + code }));
  });
}

function injectToTerminal(text, surface) {
  const target = resolveTarget(surface);
  if (!target) return Promise.resolve({ ok: false, error: 'no target surface — open the mirror via /browser (sets ?surface=)' });
  const line = String(text || '').replace(/\r?\n/g, ' ').trim();   // v1: single-line; newlines → spaces
  if (!line) return Promise.resolve({ ok: false, error: 'empty' });
  log('inject →', target, `(${Buffer.byteLength(line, 'utf8')}B)`);  // byte count only, not content
  // Two steps: paste the text, then a DISCRETE Enter keypress. A trailing "\n" inside one `send`
  // burst is treated by Claude Code's input as a literal newline (bracketed paste) for long/wrapped
  // lines and only submits short ones — a separate `send-key enter` submits reliably at any length.
  return (async () => {
    const s = await cmuxSend(target, line);
    if (!s.ok) { log('inject FAILED →', target, s.error); return { ok: false, target, error: s.error }; }
    await sleep(70);
    const e = await cmuxSendKey(target, 'enter');
    if (!e.ok) { log('inject enter FAILED →', target, e.error); return { ok: false, target, error: e.error }; }
    return { ok: true, target };
  })();
}

// Drive an interactive TUI prompt (AskUserQuestion selector) by replaying a small step list the
// browser builds from the rendered option layout: {key,n} sends a key n times, {text} pastes text.
// Selecting option index i = {key:'down', n:i} then {key:'enter'} (highlight starts at row 0).
const KEY_OK = new Set(['up','down','left','right','enter','return','tab','esc','escape','space','home','end','pageup','pagedown','backspace']);
async function runSteps(steps, surface) {
  const target = resolveTarget(surface);
  if (!target) return { ok: false, error: 'no target surface — open the mirror via /browser' };
  if (!Array.isArray(steps) || !steps.length) return { ok: false, error: 'no steps' };
  if (steps.length > 60) return { ok: false, error: 'too many steps' };
  log('answer →', target, `(${steps.length} steps)`);
  for (const s of steps) {
    if (s && s.key) {
      if (!KEY_OK.has(s.key)) return { ok: false, target, error: 'bad key: ' + s.key };
      const n = Math.min(Math.max(1, s.n || 1), 50);
      for (let i = 0; i < n; i++) {
        const r = await cmuxSendKey(target, s.key);
        if (!r.ok) { log('answer FAILED →', target, r.error); return { ok: false, target, error: r.error }; }
        await sleep(80);
      }
    } else if (s && typeof s.text === 'string') {
      const line = s.text.replace(/\r?\n/g, ' ');
      if (line.length) {
        const r = await cmuxSend(target, line);
        if (!r.ok) { log('answer FAILED →', target, r.error); return { ok: false, target, error: r.error }; }
        await sleep(140);
      }
    }
  }
  return { ok: true, target };
}

// ---------------------------------------------------------------- "btw" side conversations
// A side session is a SEPARATE, short-lived `claude` process that is AWARE of the main
// terminal session's context but ISOLATED from it (never writes the main jsonl). It is
// fully independent of the global "/" headless chat above — it does NOT touch `claude`,
// `sessionId`, `stdoutBuf`, `sse`, `broadcast`, or `onClaudeLine`. Each side session is its
// own object in SIDE; events go only to that session's own SSE set.
const SIDE = new Map();              // btwId -> { proc, sid:null, sse:Set, buf:'', ring:[], lastActivity, mode }
const SIDE_TTL_MS = 15 * 60 * 1000;  // reap idle sessions with no listeners after 15 min
const SIDE_MAX    = 8;               // hard cap on concurrent side sessions
const RING_MAX    = 400;             // per-session replay-ring cap (so reconnect rebuilds transcript)

// Push one renderable item to a side session: append to its ring (capped) + fan out to its SSE.
function sePush(entry, item) {
  entry.ring.push(item);
  if (entry.ring.length > RING_MAX) entry.ring.shift();
  const payload = `data: ${JSON.stringify(item)}\n\n`;
  for (const r of entry.sse) { try { r.write(payload); } catch { /* client gone */ } }
}

// Build a cheap context digest from the main session's jsonl: the most-recent messages,
// newest-kept, up to ~maxChars. Reuses extractRenderable so the shape matches the renderer.
function buildSeed(mainSessionId, maxChars = 6000) {
  const file = resolveSessionFile(mainSessionId);
  if (!file) return '';
  let raw; try { raw = readFileSync(file, 'utf8'); } catch { return ''; }
  const lines = raw.split('\n');
  const msgs = [];
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    for (const it of extractRenderable(o)) {
      if (it.type !== 'msg') continue;
      if (it.kind === 'tool') msgs.push(`Claude [tool ${it.name}]`);
      else msgs.push(`${it.role === 'user' ? 'User' : 'Claude'}: ${it.text}`);
    }
  }
  // keep the most recent messages until ~maxChars (walk backwards)
  const kept = []; let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const s = msgs[i]; if (total + s.length > maxChars && kept.length) break;
    kept.push(s); total += s.length + 2;
  }
  kept.reverse();
  return kept.join('\n\n');
}

// Resolve the cwd a side session should run in: the main session's own project dir if it is
// under the user's home, else fall back to CFG.vault. Decode the project-dir name (Claude
// Code encodes the cwd by replacing '/' with '-', so reverse that).
function sideCwdFor(mainSessionId) {
  const file = resolveSessionFile(mainSessionId);
  if (file) {
    const dirName = file.split('/').slice(-2, -1)[0] || '';   // e.g. -Users-you-vault
    const decoded = dirName.replace(/-/g, '/');                // -> /Users/you/vault
    if (decoded.startsWith(process.env.HOME || '/Users') && existsSync(decoded)) return decoded;
  }
  return CFG.vault;
}

// True if the main jsonl is in a quiescent state safe to --resume --fork (ends with a clean,
// fully-written JSON line). A turn in progress leaves a partial trailing line.
function mainQuiescent(mainSessionId) {
  const file = resolveSessionFile(mainSessionId);
  if (!file) return false;
  try {
    const st = statSync(file);
    const len = Math.min(st.size, 64 * 1024);
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    closeSync(fd);
    const tail = buf.toString('utf8');
    if (!tail.endsWith('\n')) return false;                    // mid-write trailing line
    const lines = tail.split('\n').filter((l) => l.trim());
    const last = lines[lines.length - 1];
    if (!last) return false;
    JSON.parse(last);                                          // last full line must parse
    return true;
  } catch { return false; }
}

// Spawn the side `claude` process for an existing SIDE entry. Returns the effective mode
// (may differ from requested if a fork fell back to summary).
function spawnSide(btwId, mainSessionId, mode) {
  const entry = SIDE.get(btwId);
  if (!entry) return mode;
  const cwd = sideCwdFor(mainSessionId);
  const args = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',                       // stream all complete events
    // NO --include-partial-messages: we want only complete messages so extractRenderable applies.
    '--permission-mode', 'plan',       // read-only; NO bypassPermissions for a side question
    '--model', 'opus',
  ];
  let effectiveMode = mode;
  if (mode === 'fork') {
    if (mainQuiescent(mainSessionId)) {
      args.push('--resume', mainSessionId, '--fork-session');
    } else {
      effectiveMode = 'summary';       // quiescence guard tripped → fall back to summary seed
      sePush(entry, { type: '_warn', text: 'main session busy — used summary seed instead of fork' });
    }
  }
  if (effectiveMode === 'summary') {
    const seed = buildSeed(mainSessionId);
    args.push('--append-system-prompt',
      `You are answering a quick SIDE QUESTION from the user while they work in their main Claude Code session. You are READ-ONLY (plan mode). Recent context from the main session follows.\n\n---\n${seed}\n---\n\nAnswer side questions directly and concisely.`);
  }
  entry.mode = effectiveMode;
  log('btw spawn', btwId.slice(0, 8), 'mode', effectiveMode, '(cwd', cwd + ')');
  const child = spawn(CFG.bin, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  entry.proc = child;
  entry.buf = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    entry.buf += chunk;
    let nl;
    while ((nl = entry.buf.indexOf('\n')) >= 0) {
      const line = entry.buf.slice(0, nl);
      entry.buf = entry.buf.slice(nl + 1);
      if (line.trim()) onSideLine(entry, line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { sePush(entry, { type: '_stderr', text: d.toString() }); });
  child.on('exit', (code, signal) => {
    log('btw exited', btwId.slice(0, 8), code, signal);
    entry.proc = null;                 // keep entry so reconnect can replay the ring
    sePush(entry, { type: '_proc', status: 'exited' });
  });
  child.on('error', (err) => {
    log('btw spawn error', btwId.slice(0, 8), err.message);
    entry.proc = null;
    sePush(entry, { type: '_proc', status: 'error', error: err.message });
  });
  return effectiveMode;
}

// One complete stdout line from a side process → renderable items into its ring/SSE.
function onSideLine(entry, line) {
  let obj;
  try { obj = JSON.parse(line); }
  catch { sePush(entry, { type: '_raw', text: line }); return; }
  if (obj.session_id) entry.sid = obj.session_id;
  for (const it of extractRenderable(obj)) sePush(entry, it);
}

// Reaper: drop idle side sessions with no live listeners.
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of SIDE) {
    if (entry.sse.size === 0 && now - entry.lastActivity > SIDE_TTL_MS) {
      if (entry.proc) { try { entry.proc.kill('SIGTERM'); } catch {} }
      SIDE.delete(id);
      log('btw reaped', id.slice(0, 8));
    }
  }
}, 60 * 1000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${CFG.host}:${CFG.port}`);

  if (req.method === 'GET' && url.pathname === '/') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(HTML_PATH));
    } catch { res.writeHead(500); res.end('index.html missing'); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/mirror') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(MIRROR_PATH));
    } catch { res.writeHead(500); res.end('mirror.html missing'); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/btw-window') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(BTW_PATH));
    } catch { res.writeHead(500); res.end('btw.html missing'); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/mirror/stream') {
    startMirror(req, res, url.searchParams.get('session'), url.searchParams.get('surface'));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/mirror/send') {
    const body = await readBody(req);
    let text = '', surface = ''; try { const j = JSON.parse(body); text = j.text || ''; surface = j.surface || ''; } catch {}
    const r = await injectToTerminal(text, surface);
    return sendJSON(res, r.ok ? 200 : 400, r);
  }

  // answer an interactive prompt (AskUserQuestion) by replaying a key/text step sequence
  if (req.method === 'POST' && url.pathname === '/mirror/answer') {
    const body = await readBody(req);
    let steps = [], surface = ''; try { const j = JSON.parse(body); steps = j.steps; surface = j.surface || ''; } catch {}
    const r = await runSteps(steps, surface);
    return sendJSON(res, r.ok ? 200 : 400, r);
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`retry: 2000\n\n`);
    res.write(`data: ${JSON.stringify({ type: '_state', model: curModel, sessionId, running: !!claude })}\n\n`);
    sse.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ka); sse.delete(res); });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/send') {
    const body = await readBody(req);
    let text = '';
    try { text = JSON.parse(body).text || ''; } catch {}
    if (!text.trim()) return sendJSON(res, 400, { ok: false, error: 'empty' });
    const ok = sendUser(text);
    return sendJSON(res, ok ? 200 : 500, { ok, sessionId });
  }

  if (req.method === 'POST' && url.pathname === '/new') {
    const body = await readBody(req);
    let model = curModel; try { model = JSON.parse(body).model || curModel; } catch {}
    newConversation(model);
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/model') {
    const body = await readBody(req);
    let model = curModel; try { model = JSON.parse(body).model || curModel; } catch {}
    changeModel(model);
    return sendJSON(res, 200, { ok: true, model });
  }

  if (req.method === 'POST' && url.pathname === '/interrupt') {
    // best-effort: restart resuming the same conversation, dropping the in-flight turn
    if (sessionId) changeModel(curModel); else newConversation(curModel);
    return sendJSON(res, 200, { ok: true });
  }

  // ------------------------------------------------------------ btw side-conversation routes
  // TODO(review#8): add a per-server random token on /btw/* mutating routes when the
  // write-enabled toggle lands. (read-only + localhost-only for now)
  if (req.method === 'POST' && url.pathname === '/btw/new') {
    const body = await readBody(req);
    let mainSession = '', mode = 'summary';
    try { const j = JSON.parse(body); mainSession = j.mainSession || ''; mode = j.mode === 'fork' ? 'fork' : 'summary'; } catch {}
    if (SIDE.size >= SIDE_MAX) {
      // evict the oldest entry with no live listeners; else reject
      let victim = null, oldest = Infinity;
      for (const [id, e] of SIDE) { if (e.sse.size === 0 && e.lastActivity < oldest) { oldest = e.lastActivity; victim = id; } }
      if (victim) { const e = SIDE.get(victim); if (e.proc) { try { e.proc.kill('SIGTERM'); } catch {} } SIDE.delete(victim); }
      else return sendJSON(res, 429, { ok: false, error: 'too many side sessions' });
    }
    const btwId = randomUUID();
    SIDE.set(btwId, { proc: null, sid: null, sse: new Set(), buf: '', ring: [], lastActivity: Date.now(), mode });
    const effectiveMode = spawnSide(btwId, mainSession, mode);
    return sendJSON(res, 200, { ok: true, id: btwId, mode: effectiveMode });
  }

  if (req.method === 'GET' && url.pathname === '/btw/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('retry: 2000\n\n');
    const id = url.searchParams.get('id');
    const entry = id && SIDE.get(id);
    if (!entry) { res.write(`data: ${JSON.stringify({ type: '_err', error: 'unknown side session' })}\n\n`); return; }
    entry.lastActivity = Date.now();
    // REPLAY the ring first so a drawer reload/reconnect rebuilds the full transcript
    for (const it of entry.ring) { try { res.write(`data: ${JSON.stringify(it)}\n\n`); } catch {} }
    entry.sse.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 25000);
    req.on('close', () => { entry.sse.delete(res); clearInterval(ka); });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/btw/send') {
    const body = await readBody(req);
    let id = '', text = '';
    try { const j = JSON.parse(body); id = j.id || ''; text = j.text || ''; } catch {}
    const entry = id && SIDE.get(id);
    if (!entry) return sendJSON(res, 404, { ok: false, error: 'unknown side session' });
    if (!text.trim()) return sendJSON(res, 400, { ok: false, error: 'empty' });
    entry.lastActivity = Date.now();
    // echo the user's question over SSE immediately so the drawer shows it instantly
    sePush(entry, { type: 'msg', role: 'user', text });
    const msg = { type: 'user', message: { role: 'user', content: text } };
    if (!entry.proc) return sendJSON(res, 500, { ok: false, error: 'side process not running' });
    try { entry.proc.stdin.write(JSON.stringify(msg) + '\n'); }
    catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/btw/close') {
    const body = await readBody(req);
    let id = ''; try { id = JSON.parse(body).id || ''; } catch {}
    const entry = id && SIDE.get(id);
    if (entry) {
      const proc = entry.proc;
      if (proc) {
        try { proc.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { if (!proc.killed) proc.kill('SIGKILL'); } catch {} }, 2000);
      }
      SIDE.delete(id);
    }
    return sendJSON(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('not found');
});

server.listen(CFG.port, CFG.host, () => {
  log(`listening http://${CFG.host}:${CFG.port}  vault=${CFG.vault}  model=${curModel}  perm=${CFG.permissionMode}`);
  log(`  chat   → http://${CFG.host}:${CFG.port}/        (drives a headless claude; spawned lazily on first message)`);
  log(`  mirror → http://${CFG.host}:${CFG.port}/mirror  (tails the live terminal session jsonl; no claude spawned)`);
  // headless claude is spawned lazily on first /send (ensureClaude) — mirror-only use spawns nothing
});

function killAllSide() { for (const e of SIDE.values()) { if (e.proc) try { e.proc.kill(); } catch {} } }
process.on('SIGINT',  () => { if (claude) try { claude.kill(); } catch {}; killAllSide(); process.exit(0); });
process.on('SIGTERM', () => { if (claude) try { claude.kill(); } catch {}; killAllSide(); process.exit(0); });
