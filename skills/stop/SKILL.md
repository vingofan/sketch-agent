---
name: stop
description: 停止 Sketch Agent 画板服务。用户要关闭画板服务时使用。
disable-model-invocation: true
allowed-tools: Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/launch.js" stop
```

上面是停止结果。用一句话告诉用户服务是否已停止，不要再做别的操作。
