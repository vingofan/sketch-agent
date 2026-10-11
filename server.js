#!/usr/bin/env node
// Sketch Agent 后端：零依赖。
// 接收 文字 + 草图(PNG) + 笔画(JSON)，落盘后调用 `claude -p`，用 SSE 流式回传。
// 同一个 session 自动续接，所以是连续多轮对话。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const os = require('os');

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '.claude-plugin', 'plugin.json'), 'utf8')).version || ''; }
  catch { return ''; }
})();

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const SKETCH_DIR = path.resolve(process.env.SKETCH_DIR || path.join(__dirname, 'sketches'));
const EXTRA_ARGS = (process.env.CLAUDE_EXTRA_ARGS || '').split(' ').filter(Boolean);
const PUBLIC_DIR = path.join(__dirname, 'public');
const AGENT_CWD = (() => {
  const c = process.env.AGENT_CWD || process.cwd();
  try { return fs.realpathSync(c); } catch { return c; }
})();
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

fs.mkdirSync(SKETCH_DIR, { recursive: true });

// ---------- 会话历史：直接读 Claude Code 存的 jsonl ----------
// 位置：<配置目录>/projects/<工作目录把非字母数字都换成 ->/<session-id>.jsonl
function projectDir() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  return path.join(CONFIG_DIR, 'projects', AGENT_CWD.replace(/[^a-zA-Z0-9]/g, '-'));
}

// 会话属于哪个项目由它自己决定，不一定是画板服务的工作目录。
// 在当前项目目录里找，找不到再翻所有项目目录（历史里能打开别的项目的会话，包括正在进行的 Code 会话）。
const PROJECTS_ROOT = path.join(CONFIG_DIR, 'projects');
function allProjectDirs() {
  if (process.env.CLAUDE_PROJECT_DIR) return [projectDir()];   // 手动指定目录时只看这一个
  const own = projectDir(), out = [own];
  try { for (const d of fs.readdirSync(PROJECTS_ROOT)) { const p = path.join(PROJECTS_ROOT, d); if (p !== own) out.push(p); } } catch {}
  return out;
}
function sessionFile(id) {
  for (const d of allProjectDirs()) { const f = path.join(d, id + '.jsonl'); if (fs.existsSync(f)) return f; }
  return null;
}

const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const DEFAULT_SKETCH_ASK = '请读取并解读下面这张草图，说明你看到了什么，再给出下一步建议。';
const SKETCH_BLOCK_RE = /\n?\[用户随消息附了一张手绘草图[^\]]*\]\n图片路径: (\S+)(?:\n笔画数据[^\n]*)?/;

function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// Claude Code 自动注入的、不是用户说的话：命令回显、系统提醒、后台任务通知、本地 shell 输入输出
const NOISE_TAGS = /^<(command-|local-command|system-reminder|task-notification|ci-monitor-event|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)/;
function isNoise(text) {
  const t = text.trimStart();
  return !t || NOISE_TAGS.test(t) || t.startsWith('Caveat:') || t.startsWith('[Request interrupted')
    || t.startsWith('[SYSTEM NOTIFICATION') || t.includes('<task-notification>');
}

// 把我们注入的"草图路径"说明还原成：用户文字 + 图片地址
function parseUserText(raw) {
  let text = raw, image = null, sketch = false;
  const m = SKETCH_BLOCK_RE.exec(text);
  if (m) {
    sketch = true;
    text = text.replace(SKETCH_BLOCK_RE, '').trim();
    const rel = path.relative(SKETCH_DIR, m[1]);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      image = '/sketch-files/' + rel.split(path.sep).map(encodeURIComponent).join('/');
    }
    if (text === DEFAULT_SKETCH_ASK) text = '';
  }
  return { text, image, sketch };
}

function userEntryText(e) {
  if (e.type !== 'user' || e.isMeta || e.isSidechain || !e.message) return null;
  const c = e.message.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return null;
  const t = blocksToText(c);
  return isNoise(t) ? null : t;
}

// 取会话标题：第一条真实用户消息。
// 不能只读文件开头：长会话开头常有几百 KB 的快照/带图的首条消息，只读前 256KB 会误判成「空会话」把它藏起来。
// 所以按块流式往下找，每个文件最多扫 TITLE_SCAN_MAX，并按 (mtime,size) 缓存。
const TITLE_SCAN_MAX = 48 * 1024 * 1024;
const titleCache = new Map(); // file -> { key, result }

// 返回 { title, partial }：title 为 null 且 partial=false 表示扫完整个文件确认没有用户消息（空会话）；
// partial=true 表示还没扫完就到上限了，不能断定是空会话。
function scanTitle(file, st) {
  const key = st.mtimeMs + ':' + st.size;
  const hit = titleCache.get(file);
  if (hit && hit.key === key) return hit.result;
  let result = { title: null, partial: false, cwd: null };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunk = Buffer.alloc(1024 * 1024);
    let pos = 0, carry = Buffer.alloc(0), done = false;
    while (!done && pos < TITLE_SCAN_MAX) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) { if (carry.length) done = scanLine(carry); break; }
      pos += n;
      let buf = Buffer.concat([carry, chunk.subarray(0, n)]);
      let i;
      while (!done && (i = buf.indexOf(10)) >= 0) { done = scanLine(buf.subarray(0, i)); buf = buf.subarray(i + 1); }
      carry = buf;
    }
    if (result.title == null && pos >= TITLE_SCAN_MAX) result.partial = true;
  } catch { /* 读不了就当没有标题 */ } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
  function scanLine(lineBuf) {
    if (!lineBuf.length || lineBuf.indexOf('"type":"user"') < 0) return false; // 大多数行不是用户消息，不必解析
    let e; try { e = JSON.parse(lineBuf.toString('utf8')); } catch { return false; }
    if (e.cwd && !result.cwd) result.cwd = e.cwd;   // 会话自己记录的工作目录
    const raw = userEntryText(e);
    if (raw == null) return false;
    const p = parseUserText(raw);
    const t = (p.text || (p.sketch ? '[草图]' : '')).replace(/\s+/g, ' ').trim();
    if (!t) return false;
    result.title = t.length > 60 ? t.slice(0, 60) + '…' : t;
    return true;
  }
  titleCache.set(file, { key, result });
  return result;
}

// codeSession：启动器接续的那个 Code 会话（正在进行中的对话）。无论它有没有标题、文件写没写盘，历史里都要有，
// 否则用户点进别的会话之后就回不去了。
let codeSession = null;

function listSessions(limit = 60) {
  const items = [];
  for (const d of allProjectDirs()) {
    let names;
    try { names = fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
    for (const n of names) {
      try {
        const file = path.join(d, n), st = fs.statSync(file);
        items.push({ id: n.slice(0, -6), file, dirName: path.basename(d), mtime: st.mtimeMs, size: st.size, st });
      } catch {}
    }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  const pinned = new Set([codeSession, sessionId].filter(Boolean));
  const sessions = [];
  for (const it of items) {
    if (sessions.length >= limit && !pinned.has(it.id)) continue;
    const { title, partial, cwd } = scanTitle(it.file, it.st);
    const isCode = it.id === codeSession, isCur = it.id === sessionId;
    let t = title;
    if (t == null && (partial || pinned.has(it.id))) t = isCode ? '（当前 Code 会话，还没有内容）' : partial ? '（较长的会话，标题未读取）' : '（还没有内容的会话）';
    if (t == null) continue;               // 扫完整个文件确认没有用户消息：空会话，不列出
    sessions.push({ id: it.id, mtime: it.mtime, size: it.size, title: t, cwd: cwd || null, code: isCode, current: isCur });
  }
  for (const id of pinned) { // 文件还没写盘的会话：补一条占位，保证能点回去
    if (sessions.some((x) => x.id === id)) continue;
    sessions.unshift({ id, mtime: Date.now(), size: 0, cwd: AGENT_CWD, title: id === codeSession ? '（当前 Code 会话，还没有内容）' : '（还没有内容的会话）', code: id === codeSession, current: id === sessionId });
  }
  // Code 会话固定排第一，其余按修改时间
  sessions.sort((a, b) => (b.code - a.code) || (b.mtime - a.mtime));
  return { dir: PROJECTS_ROOT, cwd: AGENT_CWD, sessions: sessions.slice(0, limit + pinned.size), missing: !items.length && !pinned.size };
}

// 会话该在哪个目录下续接：`claude --resume` 只认「当前目录对应项目」里的会话，所以要用会话自己的 cwd
function sessionCwd(id) {
  const f = id && sessionFile(id);
  if (f) {
    try {
      const c = scanTitle(f, fs.statSync(f)).cwd;
      if (c && fs.statSync(c).isDirectory()) return c;
    } catch {}
  }
  return AGENT_CWD;
}

// 一条 jsonl 记录 → 要显示的消息（0 条或多条）
// bridge 模式下，画板发的消息在会话文件里只是 `launch.js next` 命令的输出（tool_result）：
//   【画板消息 #N】…：\n\n<用户文字 + 草图路径块>\n\n—— 处理方式 ——
// 加载历史时把它还原成一条用户消息。
const BRIDGE_MSG_RE = /【画板消息 #\d+】[^\n]*\n\n([\s\S]*?)\n\n—— 处理方式 ——/;
function bridgeUserTexts(e) {
  const c = e.message && e.message.content;
  if (!Array.isArray(c)) return [];
  const out = [];
  for (const b of c) {
    if (!b || b.type !== 'tool_result') continue;
    const raw = typeof b.content === 'string' ? b.content : blocksToText(b.content);
    // 后台命令的输出常是用 Read 读文件拿到的，每行带「行号→」或「行号<Tab>」前缀，先去掉
    const t = raw.split('\n').map((l) => l.replace(/^\s*\d+[\t→]/, '')).join('\n');
    const m = BRIDGE_MSG_RE.exec(t);
    if (m) out.push(m[1]);
  }
  return out;
}

// live=true：实时跟随。画板页面发送时已经本地显示过，不再还原 bridge 消息
function entryMessages(e, live) {
  const out = [];
  if (e.isSidechain) return out;
  if (e.type === 'user' && !live) {
    for (const raw of bridgeUserTexts(e)) {
      const p = parseUserText(raw);
      if (p.text || p.image || p.sketch) out.push({ role: 'user', text: p.text, image: p.image, sketch: p.sketch });
    }
  }
  if (e.type === 'user') {
    const raw = userEntryText(e);
    if (raw == null) return out;
    const p = parseUserText(raw);
    if (p.text || p.image || p.sketch) out.push({ role: 'user', text: p.text, image: p.image, sketch: p.sketch });
  } else if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
    for (const b of e.message.content) {
      if (b.type === 'text' && b.text && b.text.trim()) out.push({ role: 'agent', text: b.text });
      else if (b.type === 'tool_use') {
        const cmd = b.input && typeof b.input.command === 'string' ? b.input.command : '';
        if (/launch\.js["']?\s+next\b/.test(cmd)) continue; // bridge 的接单命令，画板上不显示
        out.push({ role: 'tool', name: b.name });
      }
    }
  }
  return out;
}

// 相邻的 agent 文本合并成一条
function pushMerged(messages, m) {
  const last = messages[messages.length - 1];
  if (m.role === 'agent' && last && last.role === 'agent') last.text += '\n\n' + m.text;
  else messages.push(m);
}

// 返回 { messages, size }：size 是已解析到的字节位置（只算到最后一个完整行），实时跟随从这里接着读
function loadSession(id) {
  const file = sessionFile(id);
  if (!file) throw new Error('会话文件不存在');
  const buf = fs.readFileSync(file);
  const size = buf.lastIndexOf(10) + 1;
  const messages = [];
  for (const line of buf.slice(0, size).toString('utf8').split('\n')) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue; // 其余行（附件、快照等）不必解析
    let e; try { e = JSON.parse(line); } catch { continue; }
    for (const m of entryMessages(e)) pushMerged(messages, m);
  }
  return { messages: messages.slice(-500), size };
}

// ---------- 实时跟随：Code 窗口里新写入的内容推给画板 ----------
// 画板自己发的消息由 `claude -p` 写入，entrypoint 是 sdk-cli，画板已经显示过了，跳过；
// 其余（终端 cli / 桌面版 claude-desktop）是 Code 窗口里发生的，推过去。
function handleTail(req, res, url) {
  const id = url.searchParams.get('session') || '';
  if (!SESSION_ID_RE.test(id)) { res.writeHead(400); res.end('bad id'); return; }
  const fileNow = () => sessionFile(id) || path.join(projectDir(), id + '.jsonl'); // 会话文件可能在别的项目目录，也可能还没写盘
  const fromQ = url.searchParams.get('from');
  let pos = fromQ == null || fromQ === '' ? null : Math.max(0, Number(fromQ) || 0);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  let reading = false;
  const poll = () => {
    if (reading) return;
    const file = fileNow();
    let size;
    try { size = fs.statSync(file).size; } catch { return; } // 文件还没写盘：等它出现，出现后从头读
    if (pos == null) { pos = 0; }
    if (size < pos) pos = 0;                                  // 文件被截断/重写
    if (size === pos) return;
    reading = true;
    fs.open(file, 'r', (err, fd) => {
      if (err) { reading = false; return; }
      const buf = Buffer.alloc(size - pos);
      fs.read(fd, buf, 0, buf.length, pos, (err2, n) => {
        fs.close(fd, () => {});
        reading = false;
        if (err2 || !n) return;
        const end = buf.lastIndexOf(10, n - 1) + 1;           // 只消费完整的行
        if (!end) return;
        for (const line of buf.slice(0, end).toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          let e; try { e = JSON.parse(line); } catch { continue; }
          if (e.entrypoint === 'sdk-cli') continue;
          for (const m of entryMessages(e, true)) sse(res, 'msg', m);
        }
        pos += end;
        sse(res, 'pos', { pos });
      });
    });
  };
  // 没给 from：只看连接之后新增的内容
  if (pos == null) { try { pos = fs.statSync(fileNow()).size; } catch { /* 文件还没出现，poll 里从头读 */ } }
  const timer = setInterval(poll, 500);
  const beat = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => { clearInterval(timer); clearInterval(beat); });
}

let sessionId = null; // 当前对话的 session，复用即多轮
const sessionFileExists = (id) => !!sessionFile(id);
// 启动时指定要接续的会话（插件把当前 Claude Code 会话 ID 传进来）。
// 在 Code 里刚执行 /sketch-agent:start 时，这一轮还没结束，会话文件往往还没写盘，
// 所以不能要求文件已存在：先接上，真正发送时再检查。
{
  const want = process.env.ATTACH_SESSION || '';
  if (want) {
    if (SESSION_ID_RE.test(want)) { sessionId = want; codeSession = want; }
    else console.error('ATTACH_SESSION 格式无效，忽略：' + want);
  }
}
let busy = false;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function stamp() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

// 保存本轮输入，返回 { dir, pngPath, strokesPath }
function saveTurn({ image, strokes, text }) {
  const base = path.join(SKETCH_DIR, stamp());
  let dir = base, n = 1;
  while (fs.existsSync(dir)) dir = `${base}-${++n}`; // 同一毫秒也不会重名
  fs.mkdirSync(dir, { recursive: true });
  const out = { dir, pngPath: null, strokesPath: null };
  if (image) {
    const m = /^data:image\/png;base64,(.+)$/.exec(image);
    if (m) {
      out.pngPath = path.join(dir, 'sketch.png');
      fs.writeFileSync(out.pngPath, Buffer.from(m[1], 'base64'));
    }
  }
  if (Array.isArray(strokes) && strokes.length) {
    out.strokesPath = path.join(dir, 'strokes.json');
    fs.writeFileSync(out.strokesPath, JSON.stringify(strokes));
  }
  if (text) fs.writeFileSync(path.join(dir, 'message.txt'), text);
  return out;
}

function buildPrompt(text, saved, strokes) {
  const parts = [];
  if (text) parts.push(text);
  if (saved.pngPath) {
    parts.push(
      `\n[用户随消息附了一张手绘草图，请先用 Read 工具读取这张图片再回答]\n图片路径: ${saved.pngPath}`
    );
    if (saved.strokesPath) {
      const n = strokes.length;
      parts.push(
        `笔画数据(含绘制顺序和时间，需要时再读): ${saved.strokesPath}（共 ${n} 笔，按绘制先后排列）`
      );
    }
  }
  if (!text && saved.pngPath) parts.unshift('请读取并解读下面这张草图，说明你看到了什么，再给出下一步建议。');
  return parts.join('\n');
}

// 从 Claude Code 里（比如插件的 /sketch-agent:start）启动时，去掉"我在子进程里"的标记，
// 让 agent 的会话和手动启动时一样被记录。
function childEnv() {
  const e = { ...process.env };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SSE_PORT']) delete e[k];
  // 服务可能是从 Code 窗口里启动的，会继承 CLAUDE_CODE_ENTRYPOINT=claude-desktop/cli，
  // 画板的 agent 写进会话文件的记录就会被标成「Code 窗口」，实时跟随会把它当新内容重复推送。
  // 固定成 sdk-cli，/api/tail 靠它区分「画板自己发的」。
  e.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
  return e;
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------- bridge：让 Code 窗口里的 Claude 自己接画板的消息 ----------
// 画板自己另起 `claude -p` 时，和 Code 窗口是两个进程、两份上下文。bridge 模式下：
//   1. Code 里的 Claude 在后台运行 `launch.js next`，它向这里长轮询 /api/bridge/next；
//   2. 画板发送时，消息直接交给这个等待中的 `next`，Claude 被后台任务结束唤醒，在 Code 窗口里回答；
//   3. 回答由 /api/tail 从会话文件同步回画板；Claude 回答完再次运行 `next`，就是「这一轮结束」的信号。
// 没有 Code 窗口在接单（没运行 next、或太久没出现）时，退回独立 agent。
const BRIDGE_FRESH_MS = 3 * 60 * 1000;                                  // 上次 next 之后多久内仍认为 Code 在接单
const PICKUP_MS = Number(process.env.SKETCH_PICKUP_MS || 90 * 1000);    // 消息排队后多久没人接就退回独立 agent
const INFLIGHT_MS = Number(process.env.SKETCH_INFLIGHT_MS || 15 * 60 * 1000); // Code 接单后多久没再次接单就放弃等待
const bridge = { waiter: null, queue: [], inflight: null, session: null, lastSeen: 0, seq: 0 };

function bridgeUsable() {
  if (!sessionId || bridge.session !== sessionId) return false;
  return !!bridge.waiter || !!bridge.inflight || Date.now() - bridge.lastSeen < BRIDGE_FRESH_MS;
}

const writable = (res) => !res.writableEnded && !res.destroyed;
function sendJson(res, obj) {
  if (!writable(res)) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function finishJob(job, notice) {
  if (job.done) return;
  job.done = true;
  clearTimeout(job.timer);
  if (bridge.inflight === job) bridge.inflight = null;
  busy = false;
  if (writable(job.res)) {
    if (notice) sse(job.res, 'notice', { message: notice });
    sse(job.res, 'done', { sessionId });
    job.res.end();
  }
}

function deliver(job, waiter) {
  clearTimeout(job.timer);
  bridge.inflight = job;
  job.timer = setTimeout(() => finishJob(job, `Code 窗口超过 ${Math.round(INFLIGHT_MS / 60000)} 分钟没有再次接单，不再等待。`), INFLIGHT_MS);
  sendJson(waiter.res, { job: { id: job.id, text: job.prompt } });
}

function dispatchToBridge(res, prompt) {
  const job = { id: ++bridge.seq, prompt, res, done: false, timer: null };
  sse(res, 'bridge', { id: job.id });
  res.on('close', () => { // 画板页面断开：还没人接的就撤回；已经交给 Code 的让它自然结束
    if (job.done) return;
    const i = bridge.queue.indexOf(job);
    if (i >= 0) { bridge.queue.splice(i, 1); finishJob(job); }
  });
  const w = bridge.waiter;
  if (w) { bridge.waiter = null; clearTimeout(w.timer); deliver(job, w); return; }
  bridge.queue.push(job);
  job.timer = setTimeout(() => { // 没人接单：退回独立 agent
    const i = bridge.queue.indexOf(job);
    if (i < 0) return;
    bridge.queue.splice(i, 1);
    job.done = true;
    if (writable(res)) { sse(res, 'notice', { message: 'Code 窗口没有接单，改用独立 agent 回答。' }); runAgent(res, prompt); }
    else busy = false;
  }, PICKUP_MS);
}

function handleBridgeNext(req, res, url) {
  const session = url.searchParams.get('session') || '';
  const wait = Math.min(Math.max(Number(url.searchParams.get('wait')) || 1500, 1), 7200) * 1000;
  bridge.session = SESSION_ID_RE.test(session) ? session : null;
  bridge.lastSeen = Date.now();
  if (bridge.inflight) finishJob(bridge.inflight);       // 再次接单 = 上一条已经回答完
  if (bridge.waiter) {                                    // 同时只允许一个接单者
    clearTimeout(bridge.waiter.timer);
    sendJson(bridge.waiter.res, { replaced: true });
    bridge.waiter = null;
  }
  const job = bridge.queue.shift();
  if (job) { deliver(job, { res }); return; }
  const w = { res, timer: null };
  w.timer = setTimeout(() => {
    if (bridge.waiter !== w) return;
    bridge.waiter = null; bridge.lastSeen = Date.now();
    sendJson(res, { timeout: true });
  }, wait);
  bridge.waiter = w;
  res.on('close', () => {
    if (bridge.waiter === w) { clearTimeout(w.timer); bridge.waiter = null; bridge.lastSeen = Date.now(); }
  });
}

// 独立 agent：另起一个 `claude -p --resume` 进程回答（没有 Code 窗口接单时的兜底）
function runAgent(res, prompt) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--add-dir', SKETCH_DIR,
    '--allowedTools', 'Read',
    ...EXTRA_ARGS,
  ];
  if (sessionId) args.push('--resume', sessionId);

  let child;
  try {
    child = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: sessionCwd(sessionId), env: childEnv() });
  } catch (e) {
    busy = false;
    sse(res, 'error', { message: `无法启动 ${CLAUDE_BIN}: ${e.message}` });
    res.end();
    return;
  }

  let buf = '';
  let streamedAny = false; // 是否收到过增量文本，避免最终整段重复输出
  let stderr = '';
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    busy = false;
    sse(res, 'done', { sessionId });
    res.end();
  };

  function onLine(line) {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }

    if (ev.session_id) sessionId = ev.session_id;

    if (ev.type === 'stream_event' && ev.event) {
      const e = ev.event;
      if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
        streamedAny = true;
        sse(res, 'delta', { text: e.delta.text });
      }
      if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use') {
        sse(res, 'tool', { name: e.content_block.name });
      }
    } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      // 没开增量时，用完整消息兜底
      if (!streamedAny) {
        for (const b of ev.message.content) {
          if (b.type === 'text' && b.text) sse(res, 'delta', { text: b.text });
        }
      }
      for (const b of ev.message.content) {
        if (b.type === 'tool_use') sse(res, 'tool', { name: b.name });
      }
    } else if (ev.type === 'result') {
      if (ev.is_error) sse(res, 'error', { message: ev.result || 'agent 返回错误' });
    }
  }

  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  child.on('error', (e) => {
    sse(res, 'error', { message: `无法运行 ${CLAUDE_BIN}: ${e.message}` });
    finish();
  });
  child.on('close', (code) => {
    if (buf.trim()) onLine(buf);
    if (code !== 0 && stderr.trim()) sse(res, 'error', { message: stderr.trim().slice(-500) });
    finish();
  });
  res.on('close', () => { if (!finished) { try { child.kill(); } catch {} finish(); } });
}

function handleSend(req, res) {
  readBody(req).then((raw) => {
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end('bad json'); return; }
    const text = String(body.text || '').trim();
    const strokes = Array.isArray(body.strokes) ? body.strokes : [];
    if (!text && !body.image) { res.writeHead(400); res.end('empty'); return; }
    if (busy) { res.writeHead(409); res.end('agent 还在回复上一条'); return; }
    const useBridge = bridgeUsable();
    if (!useBridge && sessionId && !sessionFileExists(sessionId)) {
      res.writeHead(409);
      res.end(`会话 ${sessionId.slice(0, 8)} 还没有写盘（Code 里那一轮可能还没结束）。等它结束后再发，或点「新对话」。`);
      return;
    }

    busy = true;
    const saved = saveTurn({ image: body.image, strokes, text });
    const prompt = buildPrompt(text, saved, strokes);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    sse(res, 'saved', { dir: saved.dir, png: !!saved.pngPath, strokes: strokes.length, via: useBridge ? 'code' : 'agent' });

    if (useBridge) dispatchToBridge(res, prompt); else runAgent(res, prompt);
  }).catch((e) => { res.writeHead(500); res.end(String(e.message || e)); });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/api/send') return handleSend(req, res);
  if (req.method === 'POST' && url.pathname === '/api/reset') {
    sessionId = null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sessionId, codeSession, busy, sketchDir: SKETCH_DIR, cwd: AGENT_CWD, projectDir: projectDir(),
      root: __dirname, version: VERSION, sessionFile: !!sessionId && sessionFileExists(sessionId),
      bridge: { armed: !!bridge.waiter, inflight: !!bridge.inflight, queued: bridge.queue.length, session: bridge.session },
    }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/tail') return handleTail(req, res, url);
  if (req.method === 'GET' && url.pathname === '/api/bridge/next') return handleBridgeNext(req, res, url);
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listSessions()));
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
    if (!SESSION_ID_RE.test(id)) { res.writeHead(400); res.end('bad id'); return; }
    try {
      const { messages, size } = loadSession(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, messages, size }));
    } catch {
      if (id === sessionId || id === codeSession) { // 已接上/Code 正在进行但还没写盘的会话：当作空会话
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, messages: [], size: 0, pending: true }));
      } else { res.writeHead(404); res.end('会话文件不存在'); }
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/resume') {
    readBody(req, 64 * 1024).then((raw) => {
      let id, pending; try { ({ id, pending } = JSON.parse(raw)); } catch {}
      if (!SESSION_ID_RE.test(String(id || ''))) { res.writeHead(400); res.end('bad id'); return; }
      if (busy) { res.writeHead(409); res.end('agent 还在回复'); return; }
      // pending：启动器接续「正在执行 start 的这一轮」，文件稍后才会写盘
      if (!pending && !sessionFileExists(id)) { res.writeHead(404); res.end('会话文件不存在'); return; }
      sessionId = id;
      if (pending) codeSession = id; // 启动器传来的是「正在执行 start 的这个 Code 会话」
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId }));
    }).catch((e) => { res.writeHead(500); res.end(String(e.message || e)); });
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/sketch-files/')) {
    let rel;
    try { rel = decodeURIComponent(url.pathname.slice('/sketch-files/'.length)); } catch { res.writeHead(400); res.end(); return; }
    const file = path.resolve(SKETCH_DIR, rel);
    if (!file.startsWith(SKETCH_DIR + path.sep) || path.extname(file) !== '.png') { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET') {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`Sketch Agent 已启动: http://${HOST}:${PORT}`);
  console.log(`草图保存目录: ${SKETCH_DIR}`);
  console.log(`agent 命令: ${CLAUDE_BIN}`);
  console.log(`agent 工作目录: ${AGENT_CWD}`);
  console.log(`会话文件目录: ${projectDir()}`);
});
