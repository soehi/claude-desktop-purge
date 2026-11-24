# 宿主机制笔记（app.asar 实证）

来源：`%LOCALAPPDATA%\AnthropicClaude\app-6.28899.6\resources\app.asar`（100 MB，asar 未压缩，可直接按字节搜）。
以下函数名与日志串均来自实际字节内容，不是推测。

## 1) 谁是真的引擎

Electron 外壳（日志前缀 `[CCD]`）只做 UI 与下载/预检，真正干活的是它派生的
`%LOCALAPPDATA%\Claude-3p\claude-code\<版本>\<哈希>\claude.exe`（Bun 单文件）。
日志：`[CCD] Initialized with version 2.1.330`。

## 2) 安装目录怎么定

`installDirFor(e,t,s.checksum)` —— 目录名 = manifest checksum 的前 12 位 hex
（`9424831ad51c` 是 `9424831ad51c1ea74b485e172bfb21524a0784a3bead13140d0ee4ed0d2ed123` 的前缀）。
`.verified` 里写的正是这个 checksum，`.payload` 写的是 `{sha256,size}`。

版本更新时 `<版本>\<哈希>` 目录会被换掉，所以插件必须 glob 动态解析并记录 `versionIdentity`。

## 3) 解析链（Windows）

```
resolveHostBinary()
  → 本地 override（getLocalBinaryPath）
  → preseed_in_place（getHostPreseedInPlacePath）
  → required_version：binaryExistsForTarget()
        findInstalledBinaryPath()
          publishedInstallDirs() → 每个 <hash> 目录
          非 vm 且 flag 开时：.verified 必须存在，否则 continue
          → checkCachedBinaryHeader()：if(!platform.startsWith("darwin-")) return true
  → fallback_version：其它已安装版本
  → none
```

Windows 上**二进制内容校验是空的**（header 检查只对 darwin 做 Mach-O 判断）。
`.verified` 只是「安装标记」；`.payload` 由安装器写入，供显示/清理使用。

## 4) 为什么删 `.verified` 会自毁

`Prefetch of …` 的判断：

```
if(!size || noSessionRunsOnThisComputer() || localBinaryPath || await binaryExistsForTarget(...)) return;
// 否则下载
```

删了 `.verified` → `binaryExistsForTarget` 为 false → 启动即下载原版并覆盖。
本机 `logs/main.log` 实证（10:44:57–10:45:04）：

```
[download:1] 66.6% (88.3/132.6 MB)
[CCD] Downloaded 139039553 bytes
Decompressed to 387754656 bytes (payload sha256 fa797c1b…)
Installed at …\2.1.330\9424831ad51c\claude.exe
```

所以默认策略是 **keep**：`.verified` 原样保留，`.payload` 重算成改后的 `{sha256,size}`。

`[CCD] Binary preflight: .verified marker missing but binary exists … Proceeding with spawn`
这条日志对应 `getHostBinaryPathIfPresent()` 的兜底分支：它要求 manifest 里有 checksum、且文件存在，
**但不看 `.verified`**。只有没有 in-flight install 时才走得到；Windows 上 prefetch 会先把原版拉回来，
所以不能依赖它。

## 5) exec-kill 与失效

`invalidateHostBinaryKilledAtExec()` 在非 darwin 直接返回 false，Windows 不用担心这一支。

## 6) 启动方式

`Start-Process` 与 detached spawn 在这台机器上静默 exit 0；只有 `explorer.exe <lnk|exe>` 可靠。
注意 Squirrel 会把 app 摊到 `E:\apps\Claude\app-<ver>\` 运行（桌面 `claude.lnk` 指向它），
进程过滤要同时认 `\AnthropicClaude\app-`、`\apps\Claude\app-`、`\apps\Claude\claude.exe` 与
`\Claude-3p\claude-code\`。

## 7) 配置层落点（CLI 消费）

- `~/.claude/settings.json`：`defaultMode`、`permissions.defaultMode`、`outputStyle`、`hooks`、`env`。
- `~/.claude/output-styles/<name>.md`：`keep-coding-instructions: false` 可让引擎丢掉
  `getSimpleDoingTasksSection` 那一段（把「这是个编码任务」的默认指令整段摘掉）。
- `~/.claude/CLAUDE.md`：用户级记忆，被拼进 system prompt。
- hooks：`UserPromptSubmit` → `hookSpecificOutput.additionalContext`；
  `PreToolUse` → `hookSpecificOutput.permissionDecision`（allow/deny/ask）。
  Windows 下每个 hook 条目要显式 `"shell":"powershell"`，默认 bash 跑不起来。