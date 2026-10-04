#!/usr/bin/env node
// Sketch Agent 启动器：start | stop | status
// 用法: node launch.js start [--data DIR] [--cwd DIR] [--session ID] [--port N] [--no-open]
//       node launch.js next [--session ID] [--port N] [--wait 秒]   （bridge：阻塞等画板的下一条消息）
//
// 服务以后台进程运行（脱离当前终端），状态写在数据目录：
//   server.json  记录 pid / 端口 / 项目目录
//   server.log   服务日志
//   sketches/    每轮的草图
// 数据目录固定为 ~/.sketch-agent（可用 SKETCH_AGENT_DATA 或 --data 覆盖）。
// 不能用 ${CLAUDE_PLUGIN_DATA}：终端和桌面版给出的目录不同，会各记一份 server.json，
// 互相看不到对方启动的服务，导致 stop 失败、草图散在两处。
// 只依赖 Node 内置模块。

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (n) => argv.includes('--' + n);
const usable = (v) => !!v && !v.includes('${'); // 变量没被替换成真实值时忽略

const SERVER_JS = path.join(__dirname, '..', 'server.js');
const DATA_DIR = path.resolve(
  usable(opt('data')) ? opt('data') : (process.env.SKETCH_AGENT_DATA || path.join(os.homedir(), '.sketch-agent'))
);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const PLUGIN_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || ''; } catch { return ''; }
})();
const PID_FILE = path.join(DATA_DIR, 'server.json');
const LOG_FILE = path.join(DATA_DIR, 'server.log');
const SKETCH_DIR = process.env.SKETCH_DIR ? path.resolve(process.env.SKETCH_DIR) : path.join(DATA_DIR, 'sketches');
const UUID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SESSION = usable(opt('session')) && UUID_RE.test(opt('session')) ? opt('session') : '';
const PORT = Number(opt('port') || process.env.PORT || 3210);

function wantCwd() {
  const c = opt('cwd');
  if (usable(c)) {
    try { if (fs.statSync(c).isDirectory()) return fs.realpathSync(c); } catch {}
  }
  try { return fs.realpathSync(process.cwd()); } catch { return process.cwd(); }
}

const say = (...a) => console.log(a.join('\n'));

// bridge 的接单命令：Claude 用 Bash run_in_background 运行，等画板消息；输出里总会重复这条命令
function nextCommand(session, port) {
  return `node "${__filename}" next --session ${session} --port ${port} --wait 7000`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 探测端口上是不是我们的服务（/api/state 带 sketchDir 字段）
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/state', timeout: 800 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        try { const s = JSON.parse(b); resolve(s && typeof s.sketchDir === 'string' ? s : null); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function postJson(port, p, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 2000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '超时' }); });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.end(data);
  });
}

function tcpOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 500 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

const readInfo = () => { try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tailLog = (n = 8) => { try { return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return ''; } };

function openBrowser(url) {
  if (flag('no-open') || process.env.SKETCH_AGENT_NO_OPEN) return;
  const p = process.platform;
  const [c, a] = p === 'darwin' ? ['open', [url]] : p === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { const ch = spawn(c, a, { detached: true, stdio: 'ignore' }); ch.on('error', () => {}); ch.unref(); } catch {}
}

function describe(st, port) {
  return [
    `地址：http://127.0.0.1:${port}`,
    ...(st.sessionId ? [`当前会话：${st.sessionId}`] : []),
    `项目目录：${st.cwd}`,
    `会话文件目录：${st.projectDir}`,
    `草图保存：${st.sketchDir}`,
    `日志：${LOG_FILE}`,
  ];
}

// 找出监听该端口的 server.js 进程（server.json 缺失或在别的数据目录时的兜底）
function listenerPid(port) {
  if (process.platform === 'win32') return 0;
  try {
    const pid = Number(execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 2000 }).split('\n')[0]);
    if (!pid) return 0;
    const c = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 });
    return /server\.js/.test(c) ? pid : 0;
  } catch { return 0; }
}

// 停止我们的实例。返回 true 表示现在没有我们的服务在跑。
async function stopServer() {
  const info = readInfo();
  const port = (info && info.port) || PORT;
  const st = await probe(port);
  if (!st) {
    if (info) fs.rmSync(PID_FILE, { force: true }); // 记录已过期
    return true;
  }
  const pid = info && alive(info.pid) ? info.pid : listenerPid(port);
  if (!pid) return false;                           // 在跑，但找不到它的进程
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 20; i++) { if (!(await probe(port))) break; await sleep(150); }
  const gone = !(await probe(port));
  if (gone) fs.rmSync(PID_FILE, { force: true });
  return gone;
}

// 在 Code 会话里启动时，给出接单命令（bridge 模式）
function bridgeHint(st) {
  if (!SESSION || st.sessionId !== SESSION) return [];
  return [`接单命令：${nextCommand(SESSION, PORT)}`];
}

async function start() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const cwd = wantCwd();

  let carry = '';   // 重启时要带上的会话（同项目升级重启，不丢当前对话）
  const running = await probe(PORT);
  if (running) {
    const stale = running.root !== PLUGIN_ROOT || running.version !== PLUGIN_VERSION; // 后台跑的是别的版本/路径的代码（插件升级后常见）
    if (running.cwd === cwd && !stale) {
      let note = '';
      if (SESSION && running.sessionId !== SESSION) {
        const r = await postJson(PORT, '/api/resume', { id: SESSION, pending: true });
        if (r.status === 200) running.sessionId = SESSION;
        else note = `（未能接续当前会话：${r.body || r.status}）`;
      }
      say('✔ Sketch Agent 已在运行' + note, ...describe(running, PORT), ...bridgeHint(running));
      openBrowser(`http://127.0.0.1:${PORT}`);
      return;
    }
    // 项目目录不同：按当前项目重启（对话重新开始）；只是代码过期：重启并保留会话
    if (running.cwd === cwd) carry = running.sessionId || '';
    if (!(await stopServer())) {
      say(`✘ 端口 ${PORT} 上已有 Sketch Agent（项目目录：${running.cwd}），但不是由本插件启动，无法替换。`,
        `可以手动停掉它，或换个端口：start --port ${PORT + 1}`);
      return;
    }
  } else if (await tcpOpen(PORT)) {
    say(`✘ 端口 ${PORT} 被其他程序占用。换个端口：start --port ${PORT + 1}`);
    return;
  }

  const env = { ...process.env, PORT: String(PORT), AGENT_CWD: cwd, SKETCH_DIR: SKETCH_DIR };
  delete env.ATTACH_SESSION;
  if (SESSION || carry) env.ATTACH_SESSION = SESSION || carry;
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SSE_PORT']) delete env[k];

  const out = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(out, `\n--- ${new Date().toISOString()} start (cwd=${cwd}) ---\n`);
  const child = spawn(process.execPath, [SERVER_JS], { cwd, env, detached: true, stdio: ['ignore', out, out] });
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  child.on('error', (e) => { exited = e.message; });
  child.unref();
  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, port: PORT, cwd, started: Date.now() }));

  let st = null;
  for (let i = 0; i < 30 && exited === null; i++) {
    st = await probe(PORT);
    if (st) break;
    await sleep(200);
  }
  if (!st) {
    fs.rmSync(PID_FILE, { force: true });
    say('✘ Sketch Agent 启动失败' + (exited !== null ? `（进程退出：${exited}）` : '（等待超时）'),
      `日志：${LOG_FILE}`, tailLog());
    return;
  }
  const miss = SESSION && st.sessionId !== SESSION ? ['（未能接续当前会话：会话 ID 格式无效，已开新会话。详见日志）'] : [];
  say('✔ Sketch Agent 已启动', ...miss, ...describe(st, PORT), ...bridgeHint(st), '停止：/sketch-agent:stop');
  openBrowser(`http://127.0.0.1:${PORT}`);
}

// bridge：长轮询等画板的下一条消息。输出会被 Claude 读到，所以每种结果都写明下一步该做什么。
async function next() {
  const session = SESSION || '';
  const wait = Math.max(1, Math.min(7200, Number(opt('wait')) || 1500));
  const cmd = nextCommand(session, PORT);
  const again = `再次用 Bash 的 run_in_background（timeout 设 7200000）运行：\n${cmd}`;
  const result = await new Promise((resolve) => {
    const q = `/api/bridge/next?session=${encodeURIComponent(session)}&wait=${wait}`;
    const req = http.get({ host: '127.0.0.1', port: PORT, path: q }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ error: '响应无法解析' }); } });
      res.on('aborted', () => resolve({ error: '连接中断' }));
    });
    req.on('error', (e) => resolve({ error: e.code === 'ECONNREFUSED' ? '画板服务没有运行' : String(e.message) }));
  });
  if (result.error) {
    say(`画板服务已停止或重启（${result.error}）。bridge 循环到此结束，不要再运行接单命令。`,
      '如需继续，让用户重新运行 /sketch-agent:start。');
  } else if (result.replaced) {
    say('已有另一个接单命令接管了画板，这个循环到此结束，不要再运行接单命令。');
  } else if (result.timeout) {
    say('（等了很久，画板没有新消息。）', again, '不要输出别的内容。');
  } else if (result.job) {
    say(`【画板消息 #${result.job.id}】用户在画板上发来下面的内容（不是终端输入）：`, '', result.job.text, '',
      '—— 处理方式 ——',
      '像用户直接在这个窗口里问你一样回答。你的回答会自动同步到画板，不用另外转发。',
      `回答完立刻${again}`);
  } else {
    say('接单失败：返回内容无法识别。', again);
  }
}

async function stop() {
  const info = readInfo();
  const port = (info && info.port) || PORT;
  const before = await probe(port);
  if (!before) { await stopServer(); say('Sketch Agent 当前没有在运行'); return; }
  if (await stopServer()) say('✔ Sketch Agent 已停止');
  else say(`✘ 端口 ${port} 上的 Sketch Agent 不是由本插件启动的，没有停止。`);
}

async function status() {
  const info = readInfo();
  const port = (info && info.port) || PORT;
  const st = await probe(port);
  if (!st) { say('Sketch Agent 未运行'); return; }
  say('Sketch Agent 运行中', ...describe(st, port), ...(st.sessionId ? [] : ['当前会话：（还没有）']));
}

({ start, stop, status, next }[cmd] || (async () => { say('用法：launch.js <start|stop|status|next> [--data DIR] [--cwd DIR] [--session ID] [--port N] [--no-open]'); process.exitCode = 2; }))()
  .catch((e) => { say('✘ 出错：' + (e && e.message || e)); });
