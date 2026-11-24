// claude-desktop-purge / lib/restart.js
//
// 职责：把「停宿主 → 等 exe 可写 → explorer.exe 派生启动 → 确认起来」串成一次事务。
//
// 启动铁律（实测，绝对不要换写法）：
//   Start-Process 和 detached spawn（spawn(..., {detached:true})）在这台机器上
//   都会静默 exit 0、什么都不发生 —— 看起来成功，实际宿主没起来。
//   唯一可靠的方式：explorer.exe "<目标>"，由 shell 层派生。
//
// 启动目标优先级（按实测事实）：
//   1) 桌面快捷方式 %USERPROFILE%\Desktop\claude.lnk（→ E:\apps\Claude\claude.exe，Squirrel 外壳）
//   2) Squirrel 外壳本体 E:\apps\Claude\claude.exe
//   3) %LOCALAPPDATA%\AnthropicClaude\app-<ver>\claude.exe（由 lib/paths.js 的 hostExePath 解析，
//      未落地时用内置 glob 兜底）
//
// 本模块导出（见 docs/INTERFACES.md）：
//   stopHost({ env, timeoutMs, force })            ← 直接复用 lib/stop-host.js
//   startHost({ env, timeoutMs, lnk, exe })
//        → { started, method, target, pids:[pid], processes:[...], attempts:[...],
//            waitedMs, detail }
//        method ∈ "already-running" | "lnk" | "shell-exe" | "app-exe" | null
//   restartHost({ env, timeoutMs, force, waitWritable, writableTimeoutMs })
//        → { ok, stage, before, stop, writable, start, detail }
//        stage ∈ "done" | "stop" | "writable" | "start"
//   hostRunning(env)
//        → { running, count, pids:[pid], roots:[pid], processes:[{pid,ppid,exe,cmd}] }
//   resolveHostExe(env)      → string|null   宿主 exe 绝对路径（只读）
//   startHostCandidates(env) → [{ method, target, kind, exists }] 启动候选表（只读）
//   listRunning(env) / effectiveMatchers(env) / waitFileWritable(file, ms)  ← 透传

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  isWindows,
  effectiveMatchers,
  listRunning,
  rootProcesses,
  sleepSync,
  stopHost,
  waitFileWritable,
  waitFileWritableInfo,
} from "./stop-host.js";

export {
  isWindows,
  effectiveMatchers,
  listRunning,
  rootProcesses,
  stopHost,
  waitFileWritable,
  waitFileWritableInfo,
};

// paths.js 未落地时兜底用自己的 glob 解析；落地后自动用契约实现。
let pathsModule = null;
try {
  pathsModule = await import("./paths.js");
} catch {
  pathsModule = null;
}

const SPLASH_SHELL_EXE = "E:\\apps\\Claude\\claude.exe";

/** 宿主 app 目录根：%LOCALAPPDATA%\AnthropicClaude */
function hostAppRoot(env = process.env) {
  const local = env.LOCALAPPDATA || path.join(env.USERPROFILE || os.homedir(), "AppData", "Local");
  return path.join(local, "AnthropicClaude");
}

/** 版本号比较（app-6.28899.6 这类，按数字段比，不看字典序） */
function compareVersion(a, b) {
  const pa = String(a).split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 内置兜底：glob %LOCALAPPDATA%\AnthropicClaude\app-*\claude.exe，取最高版本 */
function hostExeFallback(env = process.env) {
  const root = hostAppRoot(env);
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  const versions = names
    .filter((n) => n.startsWith("app-"))
    .map((n) => ({ dir: path.join(root, n), ver: n.slice(4) }))
    .sort((a, b) => compareVersion(b.ver, a.ver));
  for (const v of versions) {
    const exe = path.join(v.dir, "claude.exe");
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/**
 * 宿主 exe 绝对路径。
 * 顺序：运行中进程的 Exe → lib/paths.js:hostExePath(env) → 内置 glob 兜底。
 * @returns {string|null}
 */
export function resolveHostExe(env = process.env) {
  // 1) 已经在跑的宿主进程，直接抄它的 exe（最不可能错）
  const running = listRunning(env).find((p) => p.exe);
  if (running && running.exe) return running.exe;

  // 2) 契约实现
  if (pathsModule && typeof pathsModule.hostExePath === "function") {
    try {
      const p = pathsModule.hostExePath(env);
      if (p && fs.existsSync(p)) return p;
    } catch {
      // 落兜底
    }
  }

  // 3) 内置 glob
  return hostExeFallback(env);
}

/** 桌面快捷方式候选（用户桌面 / 规范化桌面 / OneDrive 桌面 / 公共桌面） */
function lnkCandidates(env = process.env) {
  const homes = [os.homedir(), env.USERPROFILE].filter(Boolean);
  const list = [];
  if (env.CDP_LNK) list.push(env.CDP_LNK);
  for (const h of homes) {
    list.push(path.join(h, "Desktop", "claude.lnk"));
    list.push(path.join(h, "OneDrive", "Desktop", "claude.lnk"));
  }
  const pub = env.PUBLIC || "C:\\Users\\Public";
  list.push(path.join(pub, "Desktop", "claude.lnk"));
  return [...new Set(list)];
}

/**
 * 启动候选表（只读，不执行）。按优先级排列，startHost 逐条尝试。
 * @returns {Array<{method:string, target:string, kind:string, exists:boolean}>}
 */
export function startHostCandidates(env = process.env, { lnk, exe } = {}) {
  const out = [];
  const push = (method, target, kind) => {
    if (!target) return;
    if (out.some((c) => c.target.toLowerCase() === String(target).toLowerCase())) return;
    out.push({ method, target, kind, exists: fs.existsSync(target) });
  };

  // 1) lnk（首选）
  if (lnk) push("lnk", lnk, "shortcut");
  for (const p of lnkCandidates(env)) push("lnk", p, "shortcut");

  // 2) Squirrel 外壳
  push("shell-exe", env.CDP_SHELL_EXE || SPLASH_SHELL_EXE, "exe");

  // 3) app-<ver>\claude.exe（显式指定优先）
  if (exe) push("app-exe", exe, "exe");
  const appExe = resolveHostExe(env);
  if (appExe) push("app-exe", appExe, "exe");

  // 只要存在的（exe 兜底已经过存在性检查；lnk 必须真实存在才有意义）
  return out.filter((c) => c.exists);
}

/** explorer.exe 派生启动。注意：explorer 的退出码不可当成败判据（常见 1）。 */
function launchViaExplorer(target) {
  if (!isWindows) {
    // 非 Windows 不适用铁律，走 detached spawn 兜底
    const r = spawnSync("open", [target], { encoding: "utf8", timeout: 15000 });
    return { ok: !r.error, status: r.status, error: r.error ? String(r.error.code || r.error.message) : null, note: "非 Windows：open 兜底" };
  }
  const r = spawnSync("explorer.exe", [target], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  return {
    ok: !r.error,
    status: r.status,
    error: r.error ? String(r.error.code || r.error.message) : null,
    note: "explorer.exe 退出码无意义，成败只看宿主进程是否出现",
  };
}

/**
 * 宿主是否在跑（只读）。
 * @returns {{running:boolean, count:number, pids:number[], roots:number[], processes:Array}}
 */
export function hostRunning(env = process.env) {
  const list = listRunning(env);
  return {
    running: list.length > 0,
    count: list.length,
    pids: list.map((p) => p.pid),
    roots: rootProcesses(list).map((p) => p.pid),
    processes: list,
  };
}

/**
 * 启动宿主（只用 explorer.exe 派生）。
 *
 * @param {{env?:NodeJS.ProcessEnv, timeoutMs?:number, lnk?:string, exe?:string}} [options]
 * @returns {{
 *   started:boolean, method:string|null, target:string|null, pids:number[],
 *   processes:Array, attempts:Array, waitedMs:number, detail:string
 * }}
 */
export function startHost({ env = process.env, timeoutMs = 30000, lnk, exe } = {}) {
  const startedAt = Date.now();

  // 已经起来了就别再派生，否则双实例抢用户数据目录 → 新实例静默退出
  const already = hostRunning(env);
  if (already.running) {
    return {
      started: true,
      method: "already-running",
      target: null,
      pids: already.pids,
      processes: already.processes,
      attempts: [],
      waitedMs: 0,
      detail: `宿主已在运行（${already.count} 个进程），未重复派生`,
    };
  }

  const candidates = startHostCandidates(env, { lnk, exe });
  if (!candidates.length) {
    return {
      started: false,
      method: null,
      target: null,
      pids: [],
      processes: [],
      attempts: [],
      waitedMs: Date.now() - startedAt,
      detail: "找不到任何可启动目标：桌面 claude.lnk、E:\\apps\\Claude\\claude.exe、app-<ver>\\claude.exe 都不存在",
    };
  }

  const attempts = [];
  const deadline = startedAt + Math.max(1000, Number(timeoutMs) || 30000);

  for (const c of candidates) {
    if (Date.now() >= deadline) break;

    const launch = launchViaExplorer(c.target);
    const perDeadline = Date.now() + Math.min(deadline - Date.now(), 10000);
    const waitStartedAt = Date.now();

    let list = listRunning(env);
    while (!list.length && Date.now() < perDeadline) {
      sleepSync(500);
      list = listRunning(env);
    }

    attempts.push({
      method: c.method,
      target: c.target,
      launch,
      waitedMs: Date.now() - waitStartedAt,
      found: list.length > 0,
      pids: list.map((p) => p.pid),
    });

    if (list.length) {
      return {
        started: true,
        method: c.method,
        target: c.target,
        pids: list.map((p) => p.pid),
        processes: list,
        attempts,
        waitedMs: Date.now() - startedAt,
        detail: `explorer.exe 派生成功，已确认宿主进程 ${list.length} 个（root pid=${rootProcesses(list).map((p) => p.pid).join(",")}）`,
      };
    }
  }

  return {
    started: false,
    method: null,
    target: null,
    pids: [],
    processes: listRunning(env),
    attempts,
    waitedMs: Date.now() - startedAt,
    detail: "所有候选都没能拉起宿主（可能被 UAC / 安装残缺 / 用户数据目录占用阻止）",
  };
}

/**
 * 重启宿主：停 → 等 exe 可写 → explorer 启动 → 确认。
 * 停不干净就不启动（否则新旧两个实例互相抢锁，出现「旧引擎还在跑」的假象）。
 *
 * @param {{env?:NodeJS.ProcessEnv, timeoutMs?:number, force?:boolean,
 *          waitWritable?:boolean, writableTimeoutMs?:number}} [options]
 * @returns {{ok:boolean, stage:string, before:object, stop:object,
 *            writable:object|null, start:object|null, detail:string}}
 */
export function restartHost({
  env = process.env,
  timeoutMs = 30000,
  force = true,
  waitWritable = true,
  writableTimeoutMs = 20000,
} = {}) {
  const startedAt = Date.now();
  const before = hostRunning(env);

  const stop = stopHost({ env, timeoutMs: Math.min(Number(timeoutMs) || 30000, 20000), force });

  let writable = null;
  if (waitWritable) {
    const exe = resolveHostExe(env) || before.processes.find((p) => p.exe)?.exe || null;
    writable = exe
      ? waitFileWritableInfo(exe, writableTimeoutMs)
      : { ok: true, file: null, waitedMs: 0, attempts: 0, code: null, lastError: null, skipped: true, reason: "未解析到宿主 exe，跳过可写检查" };
  }

  if (!stop.ok) {
    return {
      ok: false,
      stage: "stop",
      before,
      stop,
      writable,
      start: null,
      detail: `停宿主未清空（剩 ${stop.remaining.length} 个），为避免双实例已放弃启动`,
    };
  }

  if (writable && writable.ok === false) {
    return {
      ok: false,
      stage: "writable",
      before,
      stop,
      writable,
      start: null,
      detail: `exe 仍不可写（${writable.code}），此时写字节会破坏文件，已放弃启动`,
    };
  }

  const start = startHost({ env, timeoutMs });
  return {
    ok: start.started,
    stage: start.started ? "done" : "start",
    before,
    stop,
    writable,
    start,
    detail: start.started
      ? `重启完成：停 ${stop.stopped.length} 个 → 可写 → 起来 ${start.pids.length} 个（${Date.now() - startedAt}ms）`
      : "停宿主成功但启动失败，宿主当前是关着的",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 直接执行（验证入口，前两个只读）
//   node lib/restart.js --status     只读：hostRunning()
//   node lib/restart.js --plan       只读：宿主 exe / 启动候选 / 将要停的根进程
//   node lib/restart.js --start      只用 explorer.exe 拉起宿主
//   node lib/restart.js --restart    真重启（停 → 可写 → 启动 → 确认）
//   追加 --json 输出原始 JSON
// ─────────────────────────────────────────────────────────────────────────────
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const pick = (name, dflt) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
  };
  const env = process.env;

  if (argv.includes("--restart")) {
    const res = restartHost({
      env,
      timeoutMs: Number(pick("timeout", "30000")),
      force: pick("force", "true") !== "false",
    });
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }

  if (argv.includes("--start")) {
    const res = startHost({ env, timeoutMs: Number(pick("timeout", "30000")) });
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.started ? 0 : 1);
  }

  // 默认 --status / --plan：只读
  const status = hostRunning(env);
  const exe = resolveHostExe(env);
  const candidates = startHostCandidates(env);
  const stopPlan = rootProcesses(status.processes).map((p) => p.pid);

  if (json) {
    console.log(JSON.stringify({ status, hostExe: exe, candidates, stopPlan, matchers: effectiveMatchers(env) }, null, 2));
  } else {
    console.log(`宿主运行中：${status.running ? "是" : "否"}（${status.count} 个进程）`);
    for (const p of status.processes) {
      console.log(`  pid=${p.pid} ppid=${p.ppid} exe=${p.exe || "(空)"} cmd=${p.cmd.slice(0, 110)}`);
    }
    console.log(`宿主 exe（解析结果）：${exe || "(未解析到)"}`);
    console.log("启动候选（按优先级）：");
    for (const c of candidates) console.log(`  [${c.method}] ${c.target}（存在=${c.exists}）`);
    if (argv.includes("--plan")) {
      console.log(`[--plan] 重启将先停根进程：${stopPlan.join(", ") || "(无)"}`);
      console.log("[--plan] 启动方式：explorer.exe \"<候选>\"。未执行任何操作。");
    }
  }
}