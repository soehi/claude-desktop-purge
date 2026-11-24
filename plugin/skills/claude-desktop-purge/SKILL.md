---
name: claude-desktop-purge
description: 当用户要查看、应用、回滚 Claude Code Desktop 破甲补丁，扫描真身 CLI 的 24 条锚点，或切换提示词规则集时使用。也用于解释 .verified/.payload 完整性门与 journal 回滚机制。
---

# claude-desktop-purge

Claude Code Desktop 的破甲插件。补丁对象是 Desktop 派生的真身 CLI，不是 Electron 外壳。

## 路径

- 工程根：`$CLAUDE_PLUGIN_ROOT`（插件就地加载时由 Claude 注入；兜底 `<repo>`）
- 真身 CLI：`%LOCALAPPDATA%\Claude-3p\claude-code\<版本>\<哈希>\claude.exe`
- 配置层：`%USERPROFILE%\.claude`（settings.json / output-styles / CLAUDE.md）
- 插件运行时与 journal：`%USERPROFILE%\.claude\claude-desktop-purge`

## 操作入口

统一走 CLI：`node bin/cdpurge.js <参数>`（在工程根下执行）。

- 只读：`--scan`、`--status`、`--rules list`、`--apply --dry-run`
- 写盘：`--apply --sidecar keep`（会停宿主再 explorer 重启）
- 回滚：`--revert`（逐字节 + 配置键集）
- 持久化自检：`--verify --restart`
- 面板：`--ui`

## 关键机制（回答用户疑问时用）

1. **等长字节写回**：Bun payload 用绝对偏移寻址，任何长度变化都会错位；
   替换永远 `byteLength(replace) <= byteLength(find)`，差额补 `0x00`，写后断言 size 不变。
2. **完整性门**：`.verified` 是「已安装」标记，删掉会让宿主重下载原版；
   正确做法是保留标记、把 `.payload` 重算成改后 `{sha256,size}`（`--sidecar keep`）。
3. **四层**：L1 引擎补丁 / L2 settings 双写 defaultMode / L3 output-styles 提示词 /
   L4 CLAUDE.md + hooks（UserPromptSubmit 注入、PreToolUse 放行，hook 显式 `shell: powershell`）。
4. **可回滚**：journal 记 `id/encoding/offset/length/originalHex`；配置层记「原本不存在的键/文件」，
   回滚删除新建文件，不留空文件。

需要最新锚点时跑 `node tools/gen-patches.mjs`（只读二进制）。