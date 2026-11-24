# 接口契约（claude-desktop-purge 内部模块）

所有模块都是 ESM，`node >= 22`，**零依赖**。编码：UTF-8 源码、简体中文注释与输出，标识符/命令保持原文。

宿主事实（已实测，不要重新证明）：

| 项 | 值 |
|---|---|
| 宿主主 exe | `%LOCALAPPDATA%\AnthropicClaude\app-<ver>\claude.exe`（Electron，日志前缀 `[CCD]`） |
| 桌面快捷方式 | `%USERPROFILE%\Desktop\claude.lnk` → `E:\apps\Claude\claude.exe`（Squirrel 外壳） |
| 真身 CLI | `%LOCALAPPDATA%\Claude-3p\claude-code\2.1.330\9424831ad51c\claude.exe`（387,754,656 B，Bun 单文件） |
| 完整性门 | 同目录 `.verified`（marker）+ `.payload`（`{sha256,size}` JSON） |
| 用户配置 | `%USERPROFILE%\.claude`（`CLAUDE_CONFIG_DIR` 可覆盖） |
| 插件运行时 | `<configDir>\claude-desktop-purge` |

---

## lib/paths.js

```js
export const PLUGIN_NAME = "claude-desktop-purge";
export const isWindows;

// 宿主（Electron 外壳）
export function hostAppDir(env = process.env);      // 优先运行中进程的 exe 目录，否则最高版本 glob
export function hostExePath(env = process.env);
export function hostProcessMatchers(env = process.env); // 命令行包含即判定为宿主的子串数组

// 真身 CLI
export function listCliIdentities(env = process.env);
// → [{ version, hash, dir, exe, payload, verified, exists, mtimeMs }]
export function cliIdentity(env = process.env);
// → { version, hash, dir, exe, payload, verified }  优先运行中的 CLI 进程，否则最新
export function cliExePath(env = process.env);

// 配置层
export function configDir(env = process.env);
export function settingsFile(env = process.env);
export function claudeMdFile(env = process.env);
export function outputStylesDir(env = process.env);
export function pluginHome(env = process.env);
export function backupsDir(env = process.env);
export function journalDir(env = process.env);
export function hooksDir(env = process.env);

// 工具
export function ensureDir(dir);
export function exists(p);
export function sleep(ms);
```

---

## lib/config.js

```js
export const OUTPUT_STYLE_NAME = "cdpurge";      // → ~/.claude/output-styles/cdpurge.md
export const MARK = "claude-desktop-purge";
export const CLAUDE_MD_BEGIN;  // <!-- claude-desktop-purge:begin -->
export const CLAUDE_MD_END;    // <!-- claude-desktop-purge:end -->

export function readSettings(env);
export function backupSettings(env);              // → 备份绝对路径
export function atomicWrite(file, text);

// L2 + L3：settings.json 双写 defaultMode / permissions.defaultMode / outputStyle
export function applySettings({ env, mode = "bypassPermissions", outputStyle = OUTPUT_STYLE_NAME });
// → { path, before, after, createdKeys: [...], changedKeys: [...] }
export function revertSettings({ env, snapshot });

// L3：output-styles/<name>.md（frontmatter 必须含 keep-coding-instructions: false）
export function applyOutputStyle({ env, name, body });
// → { path, created, before }
export function revertOutputStyle({ env, path, created });

// L4：CLAUDE.md 标记段注入
export function applyClaudeMd({ env, body });
// → { path, created, before }
export function revertClaudeMd({ env, path, created, before });

// L4：hooks 条目（必须显式 "shell": "powershell"）
export function hookEntries(env);
// → { UserPromptSubmit: [...], PreToolUse: [...] } 已含 shell 字段
export function applyHooks({ env, entries });
export function revertHooks({ env, added });
```

## hooks/inject.js（UserPromptSubmit）

读 stdin 事件 JSON，stdout 输出：
```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}
```

## hooks/allow.js（PreToolUse）

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"..."}}
```

---

## lib/engine.js

```js
export function fileHash(filePath);                    // sha256 hex

export function scanEngine({ file, patches = ALL_PATCHES });
// → { file, size, sha256, results: [{ id, declared, found: {utf16le?: offs[], utf8?: offs[]},
//      hit, hits: number[], encoding, bytes }], summary: { hit, miss, total } }

export function applyEnginePatches({ file, patches, dirs, dryRun = false });
// 等长写回：replace 短于 find 时尾部补 0x00 到 find 的字节长度；超长按字节截断（不整条放弃）。
// 断言 size 不变。写盘前：备份 exe 目录日志 + journal 逐字节记录。
// 宿主完整性：存在 .verified 则删除；.payload 重算 {sha256,size} 回写。
// → { ok, sizeBefore, sizeAfter, count, shaBefore, shaAfter, journalPath, ops:[...], sidecar:{verified,payload} }

export function latestJournalFor(dir, file);
export function revertFromJournal({ journalPath });
// 逐字节回写 originalHex，断言 size；恢复 .verified；恢复 .payload；→ { ok, file, restored, size }

export function readPayload(file);     // → { sha256, size } | null
export function writePayload(file, obj);
export function removeVerified(dir);   // → boolean
```

journal 结构（每个文件一份，JSON）：

```json
{
  "schema": 1,
  "tool": "claude-desktop-purge",
  "createdAt": "2026-11-23T…",
  "target": { "version": "2.1.330", "hash": "9424831ad51c", "exe": "…\\claude.exe",
              "sizeBefore": 387754656, "sha256Before": "fa79…" },
  "file": "…\\claude.exe",
  "ops": [{ "id": "I01", "encoding": "utf8", "offset": 163520832,
            "length": 52, "originalHex": "…", "patchedHex": "…" }],
  "sidecar": { "verified": { "path": "…\\.verified", "existed": true, "sha256": "…" },
               "payload":  { "path": "…\\.payload", "existed": true, "before": {"sha256":"…","size":…} } }
}
```

---

## lib/restart.js

```js
export function stopHost({ force = true });      // 按命令行含宿主路径过滤杀，含子进程
export function startHost({ env });              // 必须 explorer.exe 派生启动
export function restartHost({ env });
export function hostRunning();
```

启动铁律：`Start-Process` / 分离 spawn 都会静默 exit 0 → **只能** `explorer.exe "<lnk 或 exe>"`。

---

## lib/apply.js

```js
export function status();          // 四层 + 引擎命中状态
export function scan({});          // 只读
export function apply({ dryRun, layers, rules, env });   // 事务：journal + 全层
export function revert({ env });   // 按 journal 精确回滚
export function uninstall({ env });
```