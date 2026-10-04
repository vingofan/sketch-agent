#!/usr/bin/env node
// 测试用：模拟 `claude -p --output-format stream-json`，并把收到的参数记到日志里。
const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\n');

if (process.env.FAKE_ENV_LOG) {
  fs.appendFileSync(process.env.FAKE_ENV_LOG, JSON.stringify({
    CLAUDECODE: process.env.CLAUDECODE ?? null,
    CLAUDE_CODE_CHILD_SESSION: process.env.CLAUDE_CODE_CHILD_SESSION ?? null,
    cwd: process.cwd(),
  }) + '\n');
}

const resumeIdx = args.indexOf('--resume');
const sid = resumeIdx >= 0 ? args[resumeIdx + 1] : 'sess-fake-001';
const prompt = args[args.indexOf('-p') + 1] || '';
const hasImg = /图片路径: (\S+)/.exec(prompt);

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: sid });
if (hasImg) {
  out({ type: 'stream_event', session_id: sid, event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } } });
}
const reply = hasImg ? `读到草图 ${hasImg[1].split('/').slice(-2).join('/')}。` : '收到文字。';
for (const ch of [reply.slice(0, 6), reply.slice(6)]) {
  out({ type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ch } } });
}
out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: reply }] } });
out({ type: 'result', session_id: sid, is_error: false, result: reply });
