// claude-desktop-purge / lib/paths.js
//
// 解析 Claude Code Desktop 的三类路径：
//   1) 宿主 Electron 外壳  %LOCALAPPDATA%\AnthropicClaude\app-<ver>\claude.exe
//   2) 真身 CLI（补丁对象） %LOCALAPPDATA%\Claude-3p\claude-code\<ver>\<hash>\claude.exe
//   3) 用户配置目录        %USERPROFILE%\.claude（CLAUDE_CONFIG_DIR 可覆盖）
//
// 解析原则：
//   - **进程优先**：<Base>\app-* 目录会随更新堆积（实测同时存在 app-6.28899.6 与
//     app-6.6395.0，运行中的是前者而不是版本号更高的后者），所以先看运行中进程的
//     ExecutablePath，找不到才回退到「最高版本 glob」。
//   - 版本目录与哈希目录都可能被宿主更新替换，一律动态 glob，不写死。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** 插件目录名（安装运行时、hook 命令行、标记位都用它） */
export const PLUGIN_NAME = "claude-desktop-purge";

export const isWindows = process.platform === "win32";

// ---------------------------------------------------------------------------
// 基础环境
// ---------------------------------------------------------------------------

/** %LOCALAPPDATA% */
export function localAppDataDir(env = process.env) {
  const v = env.LOCALAPPDATA?.trim();
  return v || path.join(os.homedir(), "AppData", "Local");
}

/** %USERPROFILE% */
export function userProfileDir(env = process.env) {
  const v = env.USERPROFILE?.trim() || env.HOME?.trim();
  return v || os.homedir();
}

/** 宿主 Electron 安装根：%LOCALAPPDATA%\AnthropicClaude */
export function anthropicClaudeRoot(env = process.env) {
  return path.join(localAppDataDir(env), "AnthropicClaude");
}

/** 真身 CLI 安装根：%LOCALAPPDATA%\Claude-3p\claude-code */
export function cliRoot(env = process.env) {
  return path.join(localAppDataDir(env), "Claude-3p", "claude-code");
}

// ---------------------------------------------------------------------------
// 进程探测（短缓存：一次 CLI 调用里 status/scan/apply 会重复问同一件事）
// ---------------------------------------------------------------------------

const PROC_CACHE_MS = 1500;
let procCache = { at: 0, rows: null };

/** 清缓存（测试用） */
export function resetPathsCache() {
  procCache = { at: 0, rows: null };
}

function powershell(command) {
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { encoding: "utf8", windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
    );
    return out;
  } catch {
    return "";
  }
}

/**
 * 列出所有宿主机相关进程（claude.exe 进程的 ExecutablePath / CommandLine）。
 * → [{ pid, name, exe, cmd }]
 */
export function hostProcesses(env = process.env, { fresh = false } = {}) {
  if (!isWindows) return [];
  const now = Date.now();
  if (!fresh && procCache.rows && now - procCache.at < PROC_CACHE_MS) return procCache.rows;

  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" |",
    "Select-Object ProcessId,Name,ExecutablePath,CommandLine |",
    "ConvertTo-Json -Compress -Depth 3",
  ].join(" ");

  const raw = powershell(script).trim();
  let rows = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      rows = list
        .filter((r) => r && typeof r === "object")
        .map((r) => ({
          pid: Number(r.ProcessId) || 0,
          name: String(r.Name ?? ""),
          exe: String(r.ExecutablePath ?? ""),
          cmd: String(r.CommandLine ?? ""),
        }))
        .filter((r) => r.exe || r.cmd);
    } catch {
      rows = [];
    }
  }
  procCache = { at: now, rows };
  return rows;
}

// ---------------------------------------------------------------------------
// 版本比较
// ---------------------------------------------------------------------------

/** "6.28899.6" → [6, 28899, 6] */
export function parseVersion(v) {
  return String(v ?? "")
    .split(/[.\-_+]/)
    .map((x) => Number.parseInt(x, 10))
    .map((x) => (Number.isFinite(x) ? x : -1));
}

/** 数字段逐段比较；a > b 返回 >0 */
export function compareVersion(a, b) {
  const x = typeof a === "string" ? parseVersion(a) : a;
  const y = typeof b === "string" ? parseVersion(b) : b;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 宿主（Electron 外壳）
// ---------------------------------------------------------------------------

// 不锚定 $：ExecutablePath 是纯路径，但 CommandLine 后面还挂着 --type=renderer 之类的参数，
// 所以按「匹配到的片段」切片，而不是整串当路径用。
const HOST_EXE_RE = /AnthropicClaude[\\/]+(app-[^\\/"\s]+)[\\/]+claude\.exe/i;

/** 从任意路径/命令行解出 { dir, version, exe } （命中 AnthropicClaude\app-*\claude.exe 时） */
export function parseHostPath(p) {
  const s = String(p ?? "").replace(/"/g, "").trim();
  const m = s.match(HOST_EXE_RE);
  if (!m) return null;
  // 匹配起点可能不在 0（前面还有 C:\Users\...\Local\），必须把前缀拼回来
  const exe = `${s.slice(0, m.index)}${m[0]}`;
  return { dir: path.dirname(exe), version: m[1].replace(/^app-/i, ""), exe };
}

/** glob 所有 <Base>\app-* 目录，按版本降序 */
export function listHostAppDirs(env = process.env) {
  const root = anthropicClaudeRoot(env);
  let names = [];
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^app-/i.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const dir = path.join(root, name);
      const exe = path.join(dir, "claude.exe");
      return {
        dir,
        version: name.replace(/^app-/i, ""),
        exe,
        exists: exists(exe),
      };
    })
    .sort((a, b) => compareVersion(b.version, a.version));
}

/** 宿主主 exe 所在目录：先运行中进程，再最高版本 glob */
export function hostAppDir(env = process.env) {
  // 1) 运行中进程
  const running = hostProcesses(env)
    .map((r) => parseHostPath(r.exe))
    .filter(Boolean)
    .filter((x) => exists(x.exe))
    .sort((a, b) => compareVersion(b.version, a.version));
  if (running.length) return running[0].dir;

  // 2) glob 最高版本
  const dirs = listHostAppDirs(env);
  const hit = dirs.find((d) => d.exists) || dirs[0];
  return hit ? hit.dir : null;
}

export function hostExePath(env = process.env) {
  const dir = hostAppDir(env);
  if (!dir) return null;
  const exe = path.join(dir, "claude.exe");
  return exists(exe) ? exe : null;
}

/** 宿主版本号（"6.28899.6"）；拿不到返回 null */
export function hostVersion(env = process.env) {
  const exe = hostExePath(env);
  if (!exe) return null;
  const m = exe.replace(/"/g, "").match(HOST_EXE_RE);
  return m ? m[1].replace(/^app-/, "") : null;
}

/** 运行中的进程是否就是宿主 */
export function hostRunning(env = process.env) {
  return hostProcesses(env).some((r) => HOST_EXE_RE.test(r.exe));
}

/**
 * 用于「按命令行/路径过滤」判定的子串数组。
 * 命中任一即视为宿主相关进程（Electron 主进程、renderer、GPU 子进程都算）。
 *
 * 调用方比对时**统一小写**再 includes（本函数不返回大小写变体）。
 */
export function hostProcessMatchers(env = process.env) {
  const out = [];
  // 统一给「反斜杠」与「正斜杠」两种写法，免得调用方再自己转换分隔符
  const add = (v) => {
    const s = String(v ?? "").trim();
    if (!s) return;
    for (const variant of [s, s.replace(/\\/g, "/")]) {
      if (!out.includes(variant)) out.push(variant);
    }
  };
  const addExe = (dir) => {
    if (!dir) return;
    add(path.join(dir, "claude.exe"));
    add(`${dir}\\`);
  };

  // 1) Electron 外壳：任何版本都以 <...>\AnthropicClaude\app- 开头
  add(`${anthropicClaudeRoot(env)}\\app-`);

  // 1b) Squirrel 外壳（桌面 claude.lnk → E:\apps\Claude\claude.exe）会把 app-<ver> 摊到
  //     E:\apps\Claude 下运行。只认 AnthropicClaude 会导致「宿主起来了」永远判 false。
  add("\\apps\\Claude\\app-");
  add("\\apps\\Claude\\claude.exe");

  // 2) 运行中/最高版本的宿主目录
  addExe(hostAppDir(env));

  // 3) 真身 CLI：它是被补丁的那个 exe，重启时必须一起停
  add(`${cliRoot(env)}\\`);
  addExe(cliIdentity(env)?.dir);

  return out;
}

// ---------------------------------------------------------------------------
// 真身 CLI
// ---------------------------------------------------------------------------

// ...\Claude-3p\claude-code\<version>\<hash>\claude.exe
const CLI_EXE_RE = /Claude-3p[\\/]+claude-code[\\/]+([^\\/"\s]+)[\\/]+([^\\/"\s]+)[\\/]+claude\.exe/i;

/** 从任意路径/命令行解出 { dir, version, hash, exe } */
export function parseCliPath(p) {
  const s = String(p ?? "").replace(/"/g, "").trim();
  const m = s.match(CLI_EXE_RE);
  if (!m) return null;
  // 同上：把匹配点之前的前缀拼回来，否则相对路径 exists() 全为 false
  const exe = `${s.slice(0, m.index)}${m[0]}`;
  return { dir: path.dirname(exe), version: m[1], hash: m[2], exe };
}

/**
 * 所有 CLI 版本/哈希组合：
 * → [{ version, hash, dir, exe, payload, verified, exists, mtimeMs,
 *      hasPayload, hasVerified }]
 * 排序：版本降序 → mtimeMs 降序。
 */
export function listCliIdentities(env = process.env) {
  const root = cliRoot(env);
  const out = [];
  let versions = [];
  try {
    versions = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const version of versions) {
    const vdir = path.join(root, version);
    let hashes = [];
    try {
      hashes = fs
        .readdirSync(vdir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const hash of hashes) {
      const dir = path.join(vdir, hash);
      const exe = path.join(dir, "claude.exe");
      const payload = path.join(dir, ".payload");
      const verified = path.join(dir, ".verified");
      const ok = exists(exe);
      let mtimeMs = 0;
      try {
        mtimeMs = ok ? fs.statSync(exe).mtimeMs : 0;
      } catch {
        mtimeMs = 0;
      }
      out.push({
        version,
        hash,
        dir,
        exe,
        payload,
        verified,
        exists: ok,
        mtimeMs,
        hasPayload: exists(payload),
        hasVerified: exists(verified),
      });
    }
  }
  return out.sort(
    (a, b) => compareVersion(b.version, a.version) || b.mtimeMs - a.mtimeMs,
  );
}

/**
 * 当前 CLI 身份：优先运行中的 CLI 进程，否则最新的（版本 → mtime）。
 * → { version, hash, dir, exe, payload, verified, exists, running, hasPayload, hasVerified }
 * 一个都找不到 → null
 */
export function cliIdentity(env = process.env) {
  // 1) 运行中的 CLI
  const running = hostProcesses(env)
    .map((r) => parseCliPath(r.exe) || parseCliPath(r.cmd))
    .filter(Boolean)
    .filter((x) => exists(x.exe));
  if (running.length) {
    const hit = running[0];
    const payload = path.join(hit.dir, ".payload");
    const verified = path.join(hit.dir, ".verified");
    return {
      version: hit.version,
      hash: hit.hash,
      dir: hit.dir,
      exe: hit.exe,
      payload,
      verified,
      exists: true,
      running: true,
      hasPayload: exists(payload),
      hasVerified: exists(verified),
    };
  }

  // 2) 最新落盘的那份
  const list = listCliIdentities(env);
  const best = list.find((x) => x.exists) || list[0];
  if (!best) return null;
  return { ...best, running: false };
}

export function cliExePath(env = process.env) {
  return cliIdentity(env)?.exe ?? null;
}

// ---------------------------------------------------------------------------
// 配置层
// ---------------------------------------------------------------------------

/** 用户配置目录：CLAUDE_CONFIG_DIR 优先，否则 %USERPROFILE%\.claude */
export function configDir(env = process.env) {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(userProfileDir(env), ".claude");
}

/** <configDir>\settings.json */
export function settingsFile(env = process.env) {
  return path.join(configDir(env), "settings.json");
}

/** <configDir>\CLAUDE.md */
export function claudeMdFile(env = process.env) {
  return path.join(configDir(env), "CLAUDE.md");
}

/** <configDir>\output-styles */
export function outputStylesDir(env = process.env) {
  return path.join(configDir(env), "output-styles");
}

/** 插件运行时目录：<configDir>\claude-desktop-purge */
export function pluginHome(env = process.env) {
  return path.join(configDir(env), PLUGIN_NAME);
}

/** <pluginHome>\backups */
export function backupsDir(env = process.env) {
  return path.join(pluginHome(env), "backups");
}

/** <pluginHome>\journal（引擎层逐字节日志） */
export function journalDir(env = process.env) {
  return path.join(pluginHome(env), "journal");
}

/** <pluginHome>\hooks */
export function hooksDir(env = process.env) {
  return path.join(pluginHome(env), "hooks");
}

/** <pluginHome>\prompt-inject.md（hook 注入正文） */
export function promptInjectFile(env = process.env) {
  return path.join(pluginHome(env), "prompt-inject.md");
}

/** <pluginHome>\config.json（插件自身开关） */
export function pluginConfigFile(env = process.env) {
  return path.join(pluginHome(env), "config.json");
}

/** <pluginHome>\applied.json（状态/快照落盘） */
export function stateFile(env = process.env) {
  return path.join(pluginHome(env), "applied.json");
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function exists(p) {
  if (!p) return false;
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    if (typeof t.unref === "function") t.unref();
  });
}