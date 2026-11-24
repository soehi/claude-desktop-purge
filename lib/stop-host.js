// claude-desktop-purge / lib/stop-host.js
//
// 职责：只做「停宿主」一件事，并且必须证明「真的停干净」。
//
// 为什么需要这一步：Windows 上正在运行的 exe 被独占锁，open(r+) 直接 EBUSY，
// 原地写字节会失败。所以补丁链路固定为「停宿主 → 写字节 → 重启」，
// 而本模块就是这条链路的第一环。
//
// 铁律（已实测，别改）：
// 1) 判定「是不是宿主」只看命令行里是否包含宿主路径子串（hostProcessMatchers），
//    绝不按进程名杀。理由：宿主的 renderer/utility 子进程可能叫 claude.exe，
//    也可能叫别的名字；同名的其它软件（甚至别人的 claude.exe）也真实存在。
//    按名杀 = 一边漏杀一边误杀。
// 2) 停进程要打「根进程」+ taskkill /T，一次带走整棵 Electron 进程树；
//    父进程先死后，残留子进程在下一轮会重新被识别成根，继续补刀，直到命令行过滤为空。
// 3) lib/paths.js 是别人的模块（契约见 docs/INTERFACES.md）。本模块只在「能加载」时
//    使用它的 hostProcessMatchers(env)；加载不到就用内置兜底匹配器，
//    保证本文件单独可跑、可验证（paths.js 落地后自动切过去，无需改代码）。
//
// 本模块导出：
//   isWindows
//   effectiveMatchers(env)        → string[]           当前生效的命令行匹配器
//   matcherSource()               → "lib/paths.js" | "builtin-fallback"
//   listRunning(env)              → [{ pid, ppid, exe, cmd }]
//   rootProcesses(list)           → [{ pid, ppid, exe, cmd }] 命中集合里的根进程
//   stopHost({ env, timeoutMs, force })
//        → { ok, stopped:[pid], remaining:[{pid,ppid,exe,cmd}], before:[...],
//            roots:[pid], gentle:[{pid,result}], forced:[{pid,round,result}],
//            force, waitedMs, detail }
//   waitFileWritable(file, timeoutMs)      → boolean
//   waitFileWritableInfo(file, timeoutMs)  → { ok, file, waitedMs, attempts, code, lastError }
//   sleepSync(ms)                 → void（同步等待，不烧 CPU）

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const isWindows = process.platform === "win32";

// 内置兜底匹配器：与实测的宿主事实一一对应（见 docs/INTERFACES.md 宿主表）。
//   - 主进程/Electron 子进程：%LOCALAPPDATA%\AnthropicClaude\app-<ver>\claude.exe
//   - 真身 CLI 子进程：      %LOCALAPPDATA%\Claude-3p\claude-code\<ver>\<hash>\claude.exe
// 只用反斜杠子串，避免无辜的 "...\Claude-3p" 用户数据目录被误判成 CLI 进程。
const FALLBACK_MATCHERS = [
  "\\AnthropicClaude\\app-",
  // Squirrel 外壳（桌面 claude.lnk）会把 app-<ver> 摊到 E:\apps\Claude 下运行，
  // 探测与杀进程都必须认这套路径，否则「宿主起来了吗」永远判 false。
  "\\apps\\Claude\\app-",
  "\\apps\\Claude\\claude.exe",
  "\\Claude-3p\\claude-code\\",
];

// paths.js 尚未落地时这里是 null；落地后自动启用契约实现。
let pathsModule = null;
try {
  pathsModule = await import("./paths.js");
} catch {
  pathsModule = null;
}

/** 当前匹配器来源，便于排查「到底用的是谁的规则」 */
export function matcherSource() {
  return pathsModule && typeof pathsModule.hostProcessMatchers === "function"
    ? "lib/paths.js"
    : "builtin-fallback";
}

/**
 * 当前生效的命令行匹配器（小写原样返回，由调用方决定比较方式）。
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function effectiveMatchers(env = process.env) {
  if (pathsModule && typeof pathsModule.hostProcessMatchers === "function") {
    try {
      const list = pathsModule.hostProcessMatchers(env);
      const cleaned = (Array.isArray(list) ? list : [])
        .map((s) => String(s || "").trim())
        .filter(Boolean);
      if (cleaned.length) return cleaned;
    } catch {
      // 契约实现抛错 → 落兜底，绝不因别人的 bug 卡住停宿主
    }
  }
  return [...FALLBACK_MATCHERS];
}

/** 同步等待（Atomics.wait 不占 CPU，比死循环 Date.now() 稳） */
export function sleepSync(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (!n) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
}

/** 调 powershell（不存在则退 pwsh），统一 UTF-8 解码 */
function runPowerShell(script, timeout = 20000) {
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  const opts = {
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  };
  let r = spawnSync("powershell", args, opts);
  if (r.error && (r.error.code === "ENOENT" || r.error.code === "EPERM")) {
    r = spawnSync("pwsh", args, opts);
  }
  return r;
}

/** 取全量进程表（含命令行）并在 JS 侧按匹配器过滤 —— 过滤权集中在一处 */
const PS_LIST_SCRIPT =
  "$ProgressPreference='SilentlyContinue';" +
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
  "Get-CimInstance Win32_Process | " +
  "Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | " +
  "ConvertTo-Json -Compress -Depth 3";

/**
 * 列出命中「宿主命令行匹配器」的进程。
 * @param {NodeJS.ProcessEnv} env
 * @returns {Array<{pid:number, ppid:number, exe:string, cmd:string}>}
 */
export function listRunning(env = process.env) {
  const matchers = effectiveMatchers(env).map((s) => s.toLowerCase());

  if (!isWindows) {
    // 非 Windows 兜底（本工程目标是 Windows，但别让 API 直接炸）
    const r = spawnSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) return [];
    const out = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(t);
      if (!m) continue;
      const cmd = m[3];
      const lower = cmd.toLowerCase();
      if (!matchers.some((needle) => lower.includes(needle))) continue;
      out.push({ pid: Number(m[1]), ppid: Number(m[2]), exe: cmd.split(/\s+/)[0] || "", cmd });
    }
    return out.sort((a, b) => a.pid - b.pid);
  }

  const r = runPowerShell(PS_LIST_SCRIPT);
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return [];

  let rows;
  try {
    rows = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) rows = [rows];

  const out = [];
  for (const row of rows) {
    const cmd = String(row?.CommandLine ?? "");
    if (!cmd) continue;
    const lower = cmd.toLowerCase();
    if (!matchers.some((needle) => lower.includes(needle))) continue;
    const pid = Number(row.ProcessId);
    if (!Number.isFinite(pid)) continue;
    out.push({
      pid,
      ppid: Number(row.ParentProcessId) || 0,
      exe: String(row.ExecutablePath ?? ""),
      cmd,
    });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/**
 * 命中集合里的根进程 = 父进程不在命中集合内的那些。
 * /T 只需要打根；若出现环（父都在集合内），退化为打全集，别漏杀。
 */
export function rootProcesses(list) {
  const pids = new Set(list.map((p) => p.pid));
  const roots = list.filter((p) => !pids.has(p.ppid));
  return roots.length ? roots : list.slice();
}

/** 执行 taskkill，返回 { ok, status, stdout, stderr } */
function taskkill(args) {
  const r = spawnSync("taskkill", args, { encoding: "utf8", windowsHide: true, timeout: 20000 });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim() || (r.error ? String(r.error.code || r.error.message) : ""),
  };
}

/**
 * 停宿主。
 *
 * 流程：
 *   1. 快照 → 空则直接 ok。
 *   2. 温和阶段：对根进程 `taskkill /PID <pid>`（等价任务栏关窗口 / WM_CLOSE），
 *      等一小段（min(3000, timeoutMs/4)）。不强求成功，Electron 常无视 WM_CLOSE。
 *   3. 强制阶段（force=true）：`taskkill /PID <pid> /T /F` 逐轮打当前根进程，
 *      每轮重新 listRunning 重算根，直到命令行过滤结果为空或超时。
 *   4. 返回最终快照；ok = 过滤结果为空（这才是「真的停干净」的唯一判据）。
 *
 * @param {{env?:NodeJS.ProcessEnv, timeoutMs?:number, force?:boolean}} [options]
 * @returns {{
 *   ok: boolean, stopped: number[], remaining: Array, before: Array,
 *   roots: number[], gentle: Array, forced: Array, force: boolean,
 *   waitedMs: number, detail: string
 * }}
 */
export function stopHost({ env = process.env, timeoutMs = 20000, force = true } = {}) {
  const startedAt = Date.now();
  const before = listRunning(env);

  if (!before.length) {
    return {
      ok: true,
      stopped: [],
      remaining: [],
      before: [],
      roots: [],
      gentle: [],
      forced: [],
      force,
      waitedMs: Date.now() - startedAt,
      detail: "宿主本来就没在跑（命令行过滤结果为空）",
    };
  }

  const roots = rootProcesses(before);
  const gentle = [];
  for (const p of roots) {
    gentle.push({ pid: p.pid, result: taskkill(["/PID", String(p.pid)]) });
  }

  // 温和等待：只等一小段，别把 20s 预算全花在祈祷 WM_CLOSE 上
  const gentleBudget = Math.min(3000, Math.floor(Math.max(0, timeoutMs) / 4));
  const gentleDeadline = Date.now() + gentleBudget;
  let current = listRunning(env);
  while (current.length && Date.now() < gentleDeadline) {
    sleepSync(300);
    current = listRunning(env);
  }

  const forced = [];
  if (force) {
    const deadline = startedAt + Math.max(0, timeoutMs);
    let round = 0;
    while (current.length && Date.now() < deadline) {
      round += 1;
      const roundRoots = rootProcesses(current);
      for (const p of roundRoots) {
        forced.push({ pid: p.pid, round, result: taskkill(["/PID", String(p.pid), "/T", "/F"]) });
      }
      sleepSync(400);
      current = listRunning(env);
    }
  }

  const remaining = listRunning(env);
  const remainingPids = new Set(remaining.map((p) => p.pid));
  const stopped = before.filter((p) => !remainingPids.has(p.pid)).map((p) => p.pid);

  return {
    ok: remaining.length === 0,
    stopped,
    remaining,
    before,
    roots: roots.map((p) => p.pid),
    gentle,
    forced,
    force,
    waitedMs: Date.now() - startedAt,
    detail:
      remaining.length === 0
        ? `已停止并确认清空（${before.length} → 0，${Date.now() - startedAt}ms）`
        : `仍有 ${remaining.length} 个宿主进程存活：${remaining.map((p) => p.pid).join(", ")}`,
  };
}

/**
 * 等某文件不再被独占锁定：以 r+ 轮询打开（拿到句柄即证明可写）。
 * Windows 上运行中的 exe 会返回 EBUSY/EPERM/EACCES，消失即代表可以写字节。
 * @returns {boolean}
 */
export function waitFileWritable(file, timeoutMs = 15000) {
  return waitFileWritableInfo(file, timeoutMs).ok;
}

/**
 * waitFileWritable 的详细版（含最后一次错误码，排查 EBUSY 还是权限问题用）。
 * @returns {{ok:boolean, file:string, waitedMs:number, attempts:number, code:string|null, lastError:string|null}}
 */
export function waitFileWritableInfo(file, timeoutMs = 15000) {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, Number(timeoutMs) || 0);
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const fd = fs.openSync(file, "r+");
      fs.closeSync(fd);
      return {
        ok: true,
        file,
        waitedMs: Date.now() - startedAt,
        attempts,
        code: null,
        lastError: null,
      };
    } catch (e) {
      const code = e && e.code ? String(e.code) : "UNKNOWN";
      // 文件不存在 / 是目录：等下去没有意义，直接判定不可写
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
        return { ok: false, file, waitedMs: Date.now() - startedAt, attempts, code, lastError: e.message };
      }
      if (Date.now() >= deadline) {
        return { ok: false, file, waitedMs: Date.now() - startedAt, attempts, code, lastError: e.message };
      }
      sleepSync(200);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 直接执行（验证 / 手工操作入口）
//   node lib/stop-host.js --list              只读：列出命中宿主的进程
//   node lib/stop-host.js --dry               只读：输出「将要 kill 的命令」，不执行
//   node lib/stop-host.js --stop              真停（先温和后强制）
//   node lib/stop-host.js --stop --force=false  只温和
//   node lib/stop-host.js --writable=<file>   只读探测：等文件可写
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

  if (argv.includes("--writable")) {
    const file = pick("writable", "");
    if (!file) {
      console.error("用法：--writable=<文件绝对路径>");
      process.exit(2);
    }
    const info = waitFileWritableInfo(file, Number(pick("timeout", "5000")));
    console.log(json ? JSON.stringify(info, null, 2) : `可写探测 ${info.ok ? "通过（已可写）" : `未通过（${info.code}）`}：${info.file}，等待 ${info.waitedMs}ms / ${info.attempts} 次尝试`);
    process.exit(info.ok ? 0 : 1);
  }

  if (argv.includes("--stop")) {
    const force = pick("force", "true") !== "false";
    const res = stopHost({ timeoutMs: Number(pick("timeout", "20000")), force });
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }

  // 默认 --list / --dry：只读
  const list = listRunning();
  const roots = rootProcesses(list);
  if (json) {
    console.log(JSON.stringify({ matcherSource: matcherSource(), matchers: effectiveMatchers(), count: list.length, roots: roots.map((p) => p.pid), processes: list }, null, 2));
  } else {
    console.log(`匹配器来源：${matcherSource()}`);
    console.log(`匹配器：${effectiveMatchers().join("  |  ")}`);
    console.log(`命中宿主进程：${list.length} 个`);
    for (const p of list) {
      console.log(`  pid=${p.pid} ppid=${p.ppid} exe=${p.exe || "(空)"} cmd=${p.cmd.slice(0, 120)}`);
    }
    if (argv.includes("--dry")) {
      console.log(`\n[--dry] 根进程（会先温和再 /T /F）：${roots.map((p) => p.pid).join(", ") || "(无)"}`);
      for (const p of roots) {
        console.log(`  温和： taskkill /PID ${p.pid}`);
        console.log(`  强制： taskkill /PID ${p.pid} /T /F`);
      }
      console.log("[--dry] 未执行任何 kill。");
    }
  }
}