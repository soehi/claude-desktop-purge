#!/usr/bin/env node
// claude-desktop-purge / bin/install.js
//
// 安装器：把插件运行期文件摊到 <配置目录>\claude-desktop-purge，并把 hooks 合并进
// <配置目录>\settings.json（带备份、幂等、可还原）。
//
// 用法：
//   node bin/install.js                 安装运行时 + 合并 hooks
//   node bin/install.js --no-hooks      只摊运行时，不碰 settings.json
//   node bin/install.js --dry-run       只报告将要做什么，不写盘
//   node bin/install.js --uninstall     摘掉 hooks + 移除运行时（保留 backups / journal）
//   node bin/install.js --overwrite-prompt  覆盖已有的 prompt-inject.md
//
// 说明：
//   - 只摊 bin/ lib/ hooks/ presets/ 与默认 prompt，不碰用户的 settings.json 内容
//     （除 hooks 合并）；重复执行结果一致。
//   - 内容相同的文件不重写（避免宿主 watcher 反复触发）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_NAME,
  backupsDir,
  configDir,
  ensureDir,
  exists,
  journalDir,
  pluginHome,
  promptInjectFile,
  settingsFile,
} from "../lib/paths.js";
import {
  OUTPUT_STYLE_NAME,
  applyHooks,
  hookEntries,
  isOurHookCommand,
  readSettings,
  revertHooks,
} from "../lib/config.js";

const DEFAULT_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 需要摊出去的子目录（存在才摊） */
const COPY_DIRS = ["bin", "lib", "hooks", "presets"];

/** 摊出去的文件扩展名白名单 */
const COPY_EXTS = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".txt", ".ps1", ".sh"]);

/** 不摊的目录与临时文件 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "_t",
  "backups",
  "journal",
  "dist",
  "out",
]);

const SKIP_FILE_RE = /(\.cdpurge-bak\.|\.tmp-|\.bak$|\.log$|~$)/i;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    noHooks: false,
    uninstall: false,
    dryRun: false,
    overwritePrompt: false,
    help: false,
  };
  for (const raw of argv) {
    const a = String(raw).trim();
    if (a === "--no-hooks") opts.noHooks = true;
    else if (a === "--uninstall" || a === "-u") opts.uninstall = true;
    else if (a === "--dry-run" || a === "-n") opts.dryRun = true;
    else if (a === "--overwrite-prompt") opts.overwritePrompt = true;
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

const say = (...parts) => console.log(...parts);

// ---------------------------------------------------------------------------
// 文件摊布
// ---------------------------------------------------------------------------

function listFiles(root, rel = "") {
  const out = [];
  const dir = rel ? path.join(root, rel) : root;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const childRel = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...listFiles(root, childRel));
    } else if (e.isFile()) {
      if (SKIP_FILE_RE.test(e.name)) continue;
      if (!COPY_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      out.push(childRel);
    }
  }
  return out;
}

function sameContent(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/** 摊布 runtime → { copied, skipped, dirs } */
function installRuntime({ sourceRoot, home, env, dryRun, overwritePrompt }) {
  const result = { copied: [], skipped: [], sourceRoot, home };

  for (const sub of COPY_DIRS) {
    const srcDir = path.join(sourceRoot, sub);
    if (!exists(srcDir)) continue;
    const files = listFiles(srcDir);
    for (const rel of files) {
      const src = path.join(srcDir, rel);
      const dest = path.join(home, sub, rel);
      if (exists(dest) && sameContent(src, dest)) {
        result.skipped.push(dest);
        continue;
      }
      result.copied.push(dest);
      if (dryRun) continue;
      ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
    }
  }

  // 注入正文：prompt-inject.md 只在缺失时播种（用户改过的不覆盖）
  const injectDest = promptInjectFile(env);
  const candidates = [
    path.join(sourceRoot, "presets", "prompt-inject.zh.md"),
    path.join(sourceRoot, "lib", "default-prompt-inject.zh.md"),
    path.join(sourceRoot, "prompt-inject.md"),
  ];
  const srcInject = candidates.find((p) => exists(p));
  if (srcInject && (!exists(injectDest) || overwritePrompt)) {
    result.copied.push(injectDest);
    if (!dryRun) {
      ensureDir(path.dirname(injectDest));
      fs.copyFileSync(srcInject, injectDest);
    }
  } else if (exists(injectDest)) {
    result.skipped.push(injectDest);
  } else {
    result.injectMissing = true;
  }

  return result;
}

function removeRuntime(home, { dryRun }) {
  const removed = [];
  for (const sub of COPY_DIRS) {
    const target = path.join(home, sub);
    if (!exists(target)) continue;
    removed.push(target);
    if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
  }
  const cfg = path.join(home, "config.json");
  if (exists(cfg)) {
    removed.push(cfg);
    if (!dryRun) fs.rmSync(cfg, { force: true });
  }
  return removed;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function printHelp() {
  say("用法：node bin/install.js [--no-hooks] [--dry-run] [--uninstall] [--overwrite-prompt]");
  say("");
  say("  默认        摊布运行时并合并 hooks 到 settings.json");
  say("  --no-hooks  只摊布运行时，不碰 settings.json");
  say("  --dry-run   只报告动作，不写盘");
  say("  --uninstall 摘掉本插件写入的 hooks 并移除运行时（保留 backups / journal）");
  say("  --overwrite-prompt  用默认正文覆盖已有的 prompt-inject.md");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const env = process.env;
  const cfg = configDir(env);
  const home = pluginHome(env);
  const settings = settingsFile(env);
  const sourceRoot = DEFAULT_SOURCE_ROOT;

  say(`配置目录：${cfg}`);
  say(`插件目录：${home}`);
  if (opts.dryRun) say("（dry-run：不写任何文件）");
  say("");

  if (opts.uninstall) {
    // 1) 摘 hooks
    let hookResult = { ok: true, removed: 0 };
    try {
      hookResult = revertHooks({ env });
    } catch (err) {
      hookResult = { ok: false, removed: 0, error: err.message };
      say(`摘除 hooks 失败：${err.message}`);
    }
    say(`hooks：本次摘除 ${hookResult.removed ?? 0} 个条目 → ${settings}`);

    // 2) 移除运行时（保留 backups / journal）
    const removed = removeRuntime(home, { dryRun: opts.dryRun });
    for (const p of removed) say(`删除 ${p}`);
    if (!removed.length) say("运行时目录本来就不存在，无需删除。");
    say(`已保留备份目录：${backupsDir(env)}`);
    say(`已保留日志目录：${journalDir(env)}`);
    say("");
    say("卸载完成。输出风格（output-styles）与 CLAUDE.md 标记段由 cdpurge --revert 单独回滚。");
    return;
  }

  // 1) 摊布运行时
  if (!opts.dryRun) ensureDir(home);
  const result = installRuntime({
    sourceRoot,
    home,
    env,
    dryRun: opts.dryRun,
    overwritePrompt: opts.overwritePrompt,
  });
  say(`运行时：写入 ${result.copied.length} 个文件，跳过（内容一致）${result.skipped.length} 个`);
  for (const p of result.copied) say(`  + ${p}`);
  if (result.injectMissing) {
    say(`  ! 未找到默认注入正文，prompt-inject.md 未播种；hook 会退回内置默认正文。`);
  }

  // 2) 合并 hooks
  if (opts.noHooks) {
    say("");
    say("已按 --no-hooks 跳过 settings.json 的 hooks 合并。");
    say("如需查看将要并入的事件条目，重跑：node bin/install.js --dry-run");
  } else {
    if (opts.dryRun) {
      const wanted = hookEntries(env);
      say("");
      say(`hooks（dry-run，将并入 ${settings}）：`);
      for (const [event, list] of Object.entries(wanted)) {
        for (const entry of list) {
          for (const h of entry.hooks ?? []) say(`  ${event} → ${h.command}  [shell=${h.shell}]`);
        }
      }
    } else {
      const snap = applyHooks({ env });
      say("");
      say(`hooks：已并入 ${settings}`);
      say(`  原有本插件条目摘除 ${snap.removed} 个，新增 ${Object.keys(snap.added).length} 个事件`);
      say(`  备份：${snap.backup ?? "（settings.json 原本不存在，无备份）"}`);
    }
  }

  say("");
  say(`输出风格目标：${path.join(cfg, "output-styles", `${OUTPUT_STYLE_NAME}.md`)}`);
  say(`注入正文：${promptInjectFile(env)}`);
  say("");
  say("下一步：");
  say(`  node "${path.join(home, "bin", "cdpurge.js")}" --status`);
  say(`  node "${path.join(home, "bin", "cdpurge.js")}" --apply`);

  // 自检：hooks 里的 command 是否真的指向本插件目录
  if (!opts.noHooks && !opts.dryRun) {
    try {
      const s = readSettings(env);
      const ours = [];
      for (const [event, list] of Object.entries(s.hooks ?? {})) {
        for (const entry of Array.isArray(list) ? list : []) {
          for (const h of entry?.hooks ?? []) {
            if (isOurHookCommand(h?.command)) ours.push(`${event}:${h.shell ?? "默认"}`);
          }
        }
      }
      say("");
      say(`自检：settings.json 里本插件 hook 条目 ${ours.length} 条（${ours.join("、") || "无"}）`);
    } catch (err) {
      say(`自检跳过：${err.message}`);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`安装失败：${err?.message ?? err}`);
  process.exitCode = 1;
}