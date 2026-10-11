# Sketch Agent

画板当键盘用：在画板上画（或打字），按 ⌘↵ 发送，Claude Code 读图后在右侧回复，多轮对话自动续接。

## 作为 Claude Code 插件使用

要求：Node 18+，已安装并登录 Claude Code。macOS 已完整验证；Linux 理论可用但未测；Windows 未测，可能有问题。

安装（一次性，在终端里运行）：

```bash
claude plugin marketplace add vingofan/sketch-agent
claude plugin install sketch-agent@sketch-agent
```

更新：

```bash
claude plugin marketplace update sketch-agent && claude plugin update sketch-agent@sketch-agent
```

更新后重启 Claude Code，在新会话里再运行 `/sketch-agent:start`。

之后在任意项目里打开 Claude Code：

| 命令 | 作用 |
|------|------|
| `/sketch-agent:start` | 启动服务并打开画板页，同时让当前 Code 会话开始接画板的消息（bridge）。agent 的工作目录就是当前项目，会话也记在这个项目下 |
| `/sketch-agent:stop` | 停止服务 |

- **接续当前会话**：在 Code 里运行 `/sketch-agent:start` 时，画板会直接接上这个 Code 会话（用的是 `${CLAUDE_SESSION_ID}`），页面显示已有对话，之后在画板里发的内容都写进同一个会话。
  - 执行 start 的这一轮还没结束，Code 的会话文件往往还没写盘。画板会先接上这个会话 ID，等这一轮结束后再发送即可；如果发得太早，会提示稍后再发。
  - **Code 窗口 → 画板是实时的**：画板每 0.5 秒跟读会话文件，Code 窗口里新增的提问、回复和工具调用会直接出现在画板上（画板自己通过独立 agent 发的消息不会重复显示）。
  - **画板 → Code 窗口（bridge 模式，默认）**：`/sketch-agent:start` 之后，这个 Code 会话里的 Claude 会在后台运行 `launch.js next` 等画板消息。画板发送时，消息直接交给它，它在 Code 窗口里回答，回答再同步回画板。全程只有这一个进程、一份上下文，画板里聊的 Code 窗口全都记得。
    - 首次运行时如果弹出权限确认（`node` 命令、读 `~/.sketch-agent/sketches` 里的草图），选「始终允许」，之后不会每条消息都打断。
    - 没有 Code 窗口在接单（没运行 start、会话被关掉、超过 3 分钟没有再次接单）时，画板自动退回独立 agent（`claude -p --resume`）。这种情况下上下文是分叉的：Code 窗口看不到画板里聊的，回到 Code 前先 `/resume`，且不要两边同时发送。
    - 画板发出的消息排队超过 90 秒没人接，或者 Code 接单后 15 分钟没有再次接单，都会自动放弃等待并在画板上提示。
    - 回复整段出现，不是逐字流式。
    - 每隔约 2 小时接单命令会超时返回一次，Claude 会静默重新接单，属正常现象。
  - 服务已在运行时再次 `/sketch-agent:start`，画板页会在 2 秒内切到当前会话。
  - 插件升级后，后台还在跑旧版本服务时，start 会自动重启服务并保留当前会话。
- 服务是后台进程，关掉 Claude Code 不会停，用 `/sketch-agent:stop` 停止。
- 在另一个项目里再 start，会按新项目重启服务，对话重新开始。
- 已经用 `node server.js` 手动启动了的话，先 Ctrl+C 停掉，再用 `/sketch-agent:start`。
- 草图、`server.log`、`server.json` 存在 `~/.sketch-agent/`（可用 `SKETCH_AGENT_DATA` 改），不会因为插件更新丢失。终端和桌面版共用这一份，所以在任一边都能 stop。
- 端口默认 3210，要改就设环境变量 `PORT` 后再启动 Claude Code，或手动运行 `node scripts/launch.js start --port 3211`。
- 不安装、只试用：克隆仓库后 `claude --plugin-dir <仓库目录>`。改了文件后在会话里运行 `/reload-plugins`。
- 校验：`claude plugin validate .`
- 命令行也能用：`node scripts/launch.js start|stop|status`。

## 直接运行（不用插件）

要求：Node 18+，已安装并登录 `claude` 命令（Claude Code）。零依赖，不用 npm install。

```bash
git clone https://github.com/vingofan/sketch-agent && cd sketch-agent
node server.js
# 浏览器打开 http://127.0.0.1:3210
```

## 使用

- 左栏是输入区：画板 + 文字框，可以只画、只打字或两者一起发。
- ⌘↵ 发送。发出后画板自动清空，下一轮从空白开始。
- 右栏是对话流。「新对话」会重置 session。
- 每轮的草图存在 `sketches/<时间戳>/`：
  - `sketch.png` 白底图，agent 用它识别
  - `strokes.json` 笔画顺序、压感、相对时间（毫秒）
  - `message.txt` 本轮文字

## 全屏与布局

- 左栏工具栏的「全屏」按钮，或按 F，整个页面全屏；再按一次、点按钮或按 Esc 退出。
- 拖动画板和 Agent 之间的分隔条，调整两边大小。双击分隔条还原；点一下分隔条后用方向键微调（Shift 加大步长）。
- 窗口窄于 860px 时变成上下布局，分隔条改为调整上下高度。
- 两边各自至少保留约 260px。比例记在浏览器里，刷新后保持。

## 历史会话

- 当前会话 ID 会写进页面 URL（`?session=<id>`），切换、新建、首次回复后都会更新。刷新或打开带 ID 的链接，会直接接上那个会话；ID 找不到时回退到服务当前的会话。服务端同一时间只有一个当前会话，多个标签页开不同会话时，最后接上的那个会生效，另一个标签页会跟过去。

- 右栏「历史」按钮：列出你机器上**所有项目**的 Claude Code 会话（包括你在终端里开的），按最近修改排序，别的项目的会话会标出项目名。点一下就接上并显示历史对话，草图也能看到。
- 独立 agent 续接某个会话时，会在这个会话自己的项目目录下运行（`claude --resume` 只认当前目录对应项目里的会话），所以从历史里切回别的项目的会话也能正常聊。
- 正在进行的 Code 会话（在 Code 里运行 `/sketch-agent:start` 的那个）固定排在第一，带绿色标签；它还没有内容或还没写盘时也会列出，点开别的会话后随时能回来。
- 很长的会话也会正常列出：标题会往文件里面找，最多扫 48MB。
- 会话文件位置：`~/.claude/projects/<工作目录，非字母数字换成 ->/<session-id>.jsonl`。
- 右栏的短 ID 点一下，复制 `claude --resume <完整 ID>`，可在终端接着聊。
- 重启服务后对话会开新会话，用「历史」选回即可。

## 画图工具与自动规整

| 工具 | 快捷键 | 用法 |
|------|--------|------|
| 画笔 | P | 自由手绘 |
| 直线 | L | 按住拖动，Shift 锁定 45° 的倍数角 |
| 圆 | O | 从圆心按住拖出半径 |
| 矩形 | R | 按住拖动，Shift 画正方形 |
| 箭头 | A | 按住拖动，Shift 锁定 45° 的倍数角 |
| 橡皮 | E | 笔尾橡皮端也会自动识别 |
| 自动规整 开/关 | S | 默认开 |

**自动规整**：用画笔手绘时，画完一笔如果像圆、像直线，会自动换成正圆、笔直的线，并在右栏顶部提示。
- 圆：基本闭合、绕了一整圈、各点到圆心距离接近、没有明显拐角才会规整。方形、三角形、很扁的椭圆、螺旋、字母数字都不会被改。
- 直线：笔画长度 ≥ 40px，且偏离两端连线不超过 6%。轻微弯的弧线、之字线不会被改。
- 刚规整完按一次撤销（⌘Z），先还原成你手绘的样子；再按一次才删除这一笔。
- 画的时候按住 Alt，可以跳过这一笔的规整；按 S 或点「规整」可整体关闭。
- 发给 Claude 的笔画数据里，规整过的和形状工具画的笔画带 `shape`（`line` / `circle` / `rect` / `arrow`），圆还带 `circle: {cx, cy, r}`，Claude 不用从点序列里猜是圆。

## Wacom Express Keys 建议映射

在 Wacom 驱动里把按键设为键盘快捷键：

| 功能 | 快捷键 |
|------|--------|
| 发送 | ⌘↵ |
| 撤销 | ⌘Z |
| 清空画板 | ⌘⌫ |
| 画笔 / 直线 / 圆 / 矩形 / 箭头 / 橡皮 | P / L / O / R / A / E |
| 自动规整开关 | S |
| 全屏 / 退出全屏 | F |

笔尾的橡皮端会被自动识别为橡皮。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | 3210 | 端口 |
| `HOST` | 127.0.0.1 | 监听地址，只在本机访问 |
| `SKETCH_DIR` | ./sketches | 草图保存目录 |
| `CLAUDE_BIN` | claude | claude 命令路径 |
| `CLAUDE_EXTRA_ARGS` | 空 | 追加参数，用空格分隔 |
| `AGENT_CWD` | 启动目录 | agent 的工作目录，也决定读哪个项目的会话 |
| `CLAUDE_CONFIG_DIR` | ~/.claude | Claude Code 配置目录 |
| `CLAUDE_PROJECT_DIR` | 自动推算 | 直接指定会话文件目录，推算不对时用 |
| `ATTACH_SESSION` | 空 | 启动时直接接续的会话 ID（插件自动传入） |

默认只给 agent 开了 `Read` 权限（读草图）。想让它顺手改文件，在 `CLAUDE_EXTRA_ARGS` 里加，比如：

```bash
AGENT_CWD=~/my-project CLAUDE_EXTRA_ARGS="--permission-mode acceptEdits" node server.js
```

## 测试

`test/fake-claude.js` 是模拟 claude 的测试脚本：

```bash
CLAUDE_BIN=$PWD/test/fake-claude.js node server.js
```

## 已知限制

- 同一时间只处理一条消息，agent 回复期间发送按钮是禁用的。
- 当前会话 ID 存在服务进程里，重启后要从「历史」里重新选。
- 历史列表按文件修改时间排序，最多 60 条；单个会话最多显示最近 500 条消息。
- 回复按纯文本显示，不渲染 Markdown。

## 许可

[MIT](LICENSE)
