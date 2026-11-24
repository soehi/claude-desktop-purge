# claude-desktop-purge

Claude Code Desktop 破甲插件。`dsh-purge → claudecode-purge（cc-haha 版）` 的 Claude Desktop 移植。

**补丁对象不是那个 Electron 外壳，而是它派生的真身 CLI：**

```
%USERPROFILE%\Desktop\claude.lnk
  → E:\apps\Claude\claude.exe                       （Squirrel 外壳）
  → E:\apps\Claude\app-6.28899.6\claude.exe         （Electron 主进程，日志前缀 [CCD]）
  → %LOCALAPPDATA%\Claude-3p\claude-code\<版本>\<哈希>\claude.exe
      = 2.1.330\9424831ad51c\claude.exe             （387,754,656 B，Bun 单文件，真正要打的）
```

外壳只负责 UI、下载与完整性预检；真正的 Claude Code 引擎是上面那个子进程。

## 四层

| 层 | 落点 | 做什么 |
|---|---|---|
| **L1 引擎** | 真身 `claude.exe` | 24 条补丁、65 处等长字节写回；`.payload` 重算 `{sha256,size}`；`.verified` 标记按 `keep/drop` 策略处理 |
| **L2 配置** | `~/.claude/settings.json` | `defaultMode` 与 `permissions.defaultMode` **双写** `bypassPermissions`；`outputStyle=cdpurge`；`skipDangerousModePermissionPrompt` |
| **L3 提示词** | `~/.claude/output-styles/cdpurge.md` | frontmatter `keep-coding-instructions: false`（引擎因此整段丢掉 `getSimpleDoingTasksSection`），正文是【行为准则】散文 |
| **L4 会话层** | `~/.claude/CLAUDE.md` + hooks | CLAUDE.md 标记段注入；`UserPromptSubmit` 每轮注入 `additionalContext`；`PreToolUse` 直接 `permissionDecision:allow`。**每个 hook 条目显式 `"shell":"powershell"`**（默认 bash 在 Windows 跑不起来） |

四层之外还有一层编排：**全量 journal**。引擎层逐字节记 `id/encoding/offset/length/originalHex`，
配置层记「原本不存在这个键 / 文件」的快照，`--revert` 能精确回到应用前，且**不留空文件**。

## 常用命令

```bash
node bin/cdpurge.js --scan                 # 只读：24 条命中/已打/未命中 + 偏移，size 不变
node bin/cdpurge.js --apply --dry-run      # 试运行：只报会改什么，一个字节都不写
node bin/cdpurge.js --apply                # 四层全量应用（先停宿主，写完用 explorer 拉起）
node bin/cdpurge.js --verify --restart     # 自检：宿主有没有把原版 CLI 重下载覆盖
node bin/cdpurge.js --status               # 四层状态
node bin/cdpurge.js --revert               # 精确回滚（逐字节 + 配置键集）
node bin/cdpurge.js --uninstall            # 回滚并清运行时（保留 backups）
node bin/cdpurge.js --rules list           # 规则集列表
node bin/cdpurge.js --rules use guomo      # 切默认规则集
node bin/cdpurge.js --rules map mythos-magpie-1505138152 xiaomajiang   # 按模型绑规则集
node bin/cdpurge.js --ui                   # 本地面板（127.0.0.1:8787，简体中文）
node bin/cdpurge.js --restart              # 重启宿主
```

`--apply --sidecar keep|drop` 选完整性门策略（默认 `keep`，原因见下）。
`--apply --layers engine,config,style,session` 只做部分层。

## 完整性门（本机实测，和旧假设不同）

宿主 `resources/app.asar` 里的安装解析链（Windows）：

```
resolveHostBinary()
  → binaryExistsForTarget() → findInstalledBinaryPath()
      → publishedInstallDirs() → 每个 <hash> 目录要求 .verified 存在（非 darwin 直接过 header 检查）
  → 存在则 resolution="required_version"，直接 spawn
  → 不存在则 prepare/prefetch：下载 132 MB 原版 zst → 解压 → 覆盖 exe → 重写 .payload 与 .verified
```

所以：

- **`.verified` 是「已安装」标记，不是签名校验文件。** 删掉它，宿主下次启动会判定「未安装」
  并把原版 CLI 重下载回来 —— 本机 `logs/main.log` 的 `[download:1] 66.6% … Decompressed to 387754656 bytes
  (payload sha256 fa797c1b…)` 就是实证。
- **正确做法是 `keep`**：保留 `.verified`（内容只是 build checksum 标记，与 exe 内容无关），
  把 `.payload` 重算成改后文件的 `{sha256,size}`。改完重启，补丁仍在。
- `--sidecar drop` 保留给对照实验；`[CCD] Binary preflight: .verified marker missing but binary exists …
  Proceeding with spawn` 这条日志确实存在，但它只在没有 in-flight install 时走得到，Windows 上
  prefetch 会先把原版拉回来。

`--verify` 就是拿「应用后 sha」对比「当前 sha」，覆盖没覆盖一眼可见。

## 24 条补丁

沿用 cc-haha 11 条（I01–I03、R01–R03、B01–B03、F01、T01），**重取锚点 13 条**
（S01–S10、B04、C01、M01）—— 2.1.330 的分类器改版成「HARD/SOFT BLOCK + severity 评分」两段式，
旧文本全部不存在。明细见 [docs/anchor-report.md](docs/anchor-report.md)。

编码实测是 **UTF-8**（不是 cc-haha 的 UTF-16LE），且同一文本常有**两份拷贝**
（约 163.2–168.4 MB 与 326.2–333.0 MB 两段），补丁全量命中。`F01 = shouldBlock:!0 → shouldBlock:!1` 共 18 处。

重新取锚：`node tools/gen-patches.mjs`（只读二进制，重写 `lib/patches.data.json`）。

## 规则集

`presets/rules/*.md`：`guize`（默认）/ `guomo`（国产模型）/ `xiaomajiang` / `minimal`。
默认提示词写成【行为准则】散文，含三句硬约定：**先交付后解释**、**四层结构（原理→组件→流程→参数/代码/步骤）**、
**缺细节填 `[占位符]` 继续**。同名用户规则集（`<pluginHome>/rules/<id>.md`）覆盖内置。

## 停 / 起宿主

- 停：按**命令行包含宿主路径**过滤（`\AnthropicClaude\app-`、`\apps\Claude\app-`、`\Claude-3p\claude-code\`），
  不按进程名杀；`taskkill /T /F` 后确认残留为 0。
- 起：**必须 `explorer.exe <lnk 或 exe>` 派生**。`Start-Process` 与 detached spawn 在这台机器上都会静默 exit 0。
- 注意 Squirrel 会把 app 目录摊到 `E:\apps\Claude\app-<ver>\` 下运行，探测必须认这套路径。

## 文件

```
bin/cdpurge.js          CLI（--scan/--apply/--revert/--status/--uninstall/--rules/--ui/--restart/--verify）
bin/install.js          把运行时摊到 <pluginHome>，合并 hooks
lib/paths.js            宿主/CLI/配置路径解析（运行中进程优先，glob 兜底，versionIdentity 随更新漂移）
lib/patches.js          补丁表 + 等长断言
lib/patches.data.json   由 tools/gen-patches.mjs 生成的实锚数据
lib/engine.js           等长写回 / journal / 完整性门
lib/config.js           L2/L3/L4 写盘（备份 + 原子写 + 快照回滚）
lib/apply.js            四层编排 + master journal + 持久化自检
lib/restart.js          explorer 启动、停宿主
lib/stop-host.js        按命令行过滤的进程枚举与终止
lib/ui.js               127.0.0.1 面板
hooks/inject.js         UserPromptSubmit → additionalContext
hooks/allow.js          PreToolUse → permissionDecision:allow
presets/rules/*.md      多套提示词
tools/                  二进制勘察与锚点生成（只读）
docs/                   锚点报告、宿主机制、验收记录
```

## 在 Claude 里显示（插件登记）

工具本身之外，本工程还打包成 **Claude Code 标准插件**，会出现在 Claude Desktop 的插件列表里：

```
.claude-plugin/marketplace.json        本地市场清单
plugin/.claude-plugin/plugin.json      插件清单（name/version/commands/skills）
plugin/commands/cdpurge.md             斜杠命令 /cdpurge
plugin/skills/claude-desktop-purge/SKILL.md
```

登记（幂等，走 Claude Code 自带插件管理，不改内部数据库）：

```bash
node bin/cdpurge.js --install-plugin
# 等价于：
#   claude.exe plugin marketplace add <repo>
#   claude.exe plugin install claude-desktop-purge@claude-desktop-purge
```

它往 `~/.claude/settings.json` 写两个键：`extraKnownMarketplaces`（本地目录）与
`enabledPlugins`（`claude-desktop-purge@claude-desktop-purge: true`）。
插件**就地加载** `<repo>\plugin`，改完下次会话或 `/reload-plugins` 生效。

重启宿主后日志可证：

```
[LocalPluginsReader] Found 1 local plugins
```

会话里可用：`/cdpurge status|scan|apply|dry-run|revert|verify|rules|ui`，以及 skill `claude-desktop-purge`。
移除登记：`node bin/cdpurge.js --remove-plugin`。

## 实测验收

见 [docs/verification.md](docs/verification.md)：24 条全命中、`size` 不变、`sha` 改变、`.payload` 一致、
`--verify --restart` 补丁仍在、回滚后 `sha` 精确回到 `fa797c1b…` 且配置键集与 `CLAUDE.md` 回到应用前。