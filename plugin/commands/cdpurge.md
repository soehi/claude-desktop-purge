---
description: claude-desktop-purge 控制面板：扫描引擎补丁、应用四层、回滚、切换规则集
argument-hint: "[status|scan|apply|dry-run|revert|verify|rules|ui]"
allowed-tools: Bash
---

# claude-desktop-purge

Claude Code Desktop 破甲插件的控制入口。参数：`$ARGUMENTS`（留空等同于 `status`）。

## 定位工程根

插件以本地目录形式登记，命令统一走 `$CLAUDE_PLUGIN_ROOT`（Claude 会把插件目录注入这个变量）：

```bash
ROOT="${CLAUDE_PLUGIN_ROOT:-<克隆仓库的绝对路径>}"
cd "$ROOT" || exit 1
```

若 `$CLAUDE_PLUGIN_ROOT` 为空，说明插件不是就地加载的：把上面尖括号部分换成你克隆本仓库的绝对路径。
本机按 README 的 `--install-plugin` 登记后，`$CLAUDE_PLUGIN_ROOT` 会自动指向插件目录。

## 命令表

| 参数 | 命令（在上面的 ROOT 下执行） |
|---|---|
| `status`（默认） | `node bin/cdpurge.js --status` |
| `scan` | `node bin/cdpurge.js --scan` |
| `apply` | `node bin/cdpurge.js --apply --sidecar keep` |
| `dry-run` | `node bin/cdpurge.js --apply --dry-run` |
| `verify` | `node bin/cdpurge.js --verify` |
| `revert` | `node bin/cdpurge.js --revert` |
| `rules` | `node bin/cdpurge.js --rules list` |
| `ui` | `node bin/cdpurge.js --ui` |

执行前提醒一句：`apply` 与 `revert` 会先停掉 Claude Desktop（随后用 explorer 派生重启），
当前会话可能中断；`scan`、`status`、`rules`、`dry-run` 只读。

跑完用两三行中文总结：引擎 24 条命中/已打情况、size 是否不变、四层是否齐。不要展开成教程。