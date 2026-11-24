#!/usr/bin/env node
// claude-desktop-purge / bin/cdpurge.js
//
// CLI：cdpurge <命令>
//   --scan                 只读扫描：每条补丁命中/已打/未命中 + 偏移（size 不变）
//   --apply [--dry-run]    四层全量应用（L1 引擎 / L2 配置 / L3 提示词 / L4 会话层）
//   --revert               按 journal 精确回滚（逐字节 + 配置键集）
//   --status               四层 + 完整性门状态
//   --uninstall            回滚并清运行时（保留 backups）
//   --rules list|use|create|show|delete|map
//   --ui                   本地面板（127.0.0.1，简体中文）
//   --restart              重启宿主（explorer.exe 派生）
//   --help

import fs from "node:fs";
import path from "node:path";
import {
  apply,
  deleteRuleSet,
  listRuleSets,
  readConfig,
  readRuleSet,
  revert,
  scan,
  status,
  uninstall,
  verifyPersisted,
  writeConfig,
  writeRuleSet,
  createRuleSet,
} from "../lib/apply.js";
import { ALL_PATCHES, PATCH_LAYERS, patchesByKind, patchSummary } from "../lib/patches.js";
import { cliIdentity, hostExePath, pluginHome, settingsFile, journalDir } from "../lib/paths.js";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const out = (s = "") => process.stdout.write(`${s}\n`);
const padEnd = (s, n) => String(s ?? "").padEnd(n);
const padStart = (s, n) => String(s ?? "").padStart(n);

function bar() {
  out("─".repeat(78));
}

function header(title) {
  bar();
  out(`  ${title}`);
  bar();
}

function help() {
  header("claude-desktop-purge — Claude Code Desktop 破甲插件");
  out("  目标：Claude Code Desktop 派生的真身 CLI（Bun 单文件）");
  out(`  当前 CLI：${(() => {
    try {
      const id = cliIdentity();
      return id ? `${id.exe}  (${id.version}/${id.hash})` : "未找到";
    } catch {
      return "未找到";
    }
  })()}`);
  out(`  宿主外壳：${hostExePath() ?? "未找到"}`);
  out(`  插件目录：${pluginHome()}`);
  out("");
  out("  --scan                    只读扫描引擎（命中/已打/未命中 + 偏移），不改任何字节");
  out("  --apply                   四层全量应用");
  out("  --apply --dry-run         试运行：只报会改什么，不写盘");
  out("  --apply --layers engine,config,style,session");
  out("  --apply --rule <id>       指定规则集（默认读插件配置）");
  out("  --apply --model <id>      按模型挑规则集（modelRules 映射）");
  out("  --apply --force           锚点缺失也继续（只打命中的）");
  out("  --apply --no-stop         不先停宿主（自己确保 exe 未被占用）");
  out("  --apply --no-restart      应用后不自动重启");
  out("  --apply --sidecar keep|drop  完整性门策略（默认 keep：保留 .verified 标记；drop 删掉它，会触发宿主重下载原版）");
  out("  --verify [--restart]      持久化自检：应用后的 sha 有没有被宿主重下载覆盖");
  out("  --revert                  按 journal 回滚（逐字节回写 + 配置键集还原）");
  out("  --status                  四层状态");
  out("  --uninstall [--purge]     回滚并清运行时（--purge 连 backups 一起删）");
  out("  --rules list              列出规则集");
  out("  --rules show <id>         查看规则集正文");
  out("  --rules use <id>          切默认规则集");
  out("  --rules create <id>       新建规则集");
  out("  --rules write <id> <file> 用文件覆盖用户规则集");
  out("  --rules delete <id>       删除用户规则集");
  out("  --rules map <model> <id>  绑定模型 → 规则集");
  out("  --ui [--port 8787]        本地面板");
  out("  --restart                 重启宿主");
  out("  --install-plugin          登记为 Claude 插件（在宿主插件列表里显示，含 /cdpurge 命令与 skill）");
  out("  --remove-plugin           移除插件登记");
  out("  --json                    结构化输出");
  out("");
}

function scanTable(res) {
  const groups = patchesByKind();
  header("引擎扫描（只读）");
  out(`  文件：${res.file}`);
  out(`  大小：${res.size.toLocaleString()} B`);
  out(`  sha256：${res.sha256}`);
  out("");
  out(
    `  ${padEnd("ID", 5)}${padEnd("层", 8)}${padEnd("来源", 9)}${padEnd("状态", 10)}${padEnd("片段", 6)}${padEnd("字节", 7)}偏移`,
  );
  for (const r of res.results) {
    const layer = PATCH_LAYERS[r.layer] ?? r.layer;
    const st =
      r.status === "hit"
        ? "命中"
        : r.status === "patched"
          ? "已打"
          : r.status === "miss"
            ? "未命中"
            : r.status;
    const frags = r.targets.length;
    const offs = r.offsets.slice(0, 5).join(",");
    out(
      `  ${padEnd(r.id, 5)}${padEnd(layer, 8)}${padEnd(r.source, 9)}${padEnd(st, 10)}${padEnd(frags, 6)}${padEnd(
        r.targets.reduce((s, t) => s + t.findBytes, 0),
        7,
      )}${offs}${r.offsets.length > 5 ? ` …(+${r.offsets.length - 5})` : ""}`,
    );
  }
  out("");
  out(`  合计：命中 ${res.counts.hit} / 已打 ${res.counts.patched} / 未命中 ${res.counts.miss} / 共 ${ALL_PATCHES.length} 条`);
  const sum = patchSummary();
  out(`  片段 ${sum.occurrences} 处，覆盖 ${sum.bytes.toLocaleString()} 字节（替换全为等长写回）`);
  out("");
}

async function cmdScan() {
  const res = scan();
  if (has("--json")) {
    out(JSON.stringify(res, null, 2));
    return;
  }
  scanTable(res);
}

async function cmdStatus() {
  const s = status();
  if (has("--json")) {
    out(JSON.stringify(s, null, 2));
    return;
  }
  header("四层状态");
  out(`  宿主外壳   ${s.host.exe ?? "未找到"}`);
  if (s.cli) {
    out(`  真身 CLI   ${s.cli.exe}`);
    out(`  版本/哈希  ${s.cli.version} / ${s.cli.hash}${s.cli.running ? "（运行中）" : ""}`);
  } else out("  真身 CLI   未找到");
  if (s.engine) {
    const e = s.engine;
    out(`  L1 引擎    size ${e.size.toLocaleString()} B  sha256 ${e.sha256.slice(0, 16)}…`);
    out(`             .verified ${e.verified ? "存在" : "已删"}   .payload.sha256 ${e.payload?.sha256?.slice(0, 16) ?? "-"}…`);
    out(`             journal ${e.journal ? `${path.basename(e.journal)}（${e.patchedOps} 处）` : "无"}`);
  } else out("  L1 引擎    未找到 CLI");
  out(`  L2 配置    defaultMode=${s.config.defaultMode ?? "未设"}  permissions.defaultMode=${s.config.permissionsDefaultMode ?? "未设"}`);
  out(`             outputStyle=${s.config.outputStyle ?? "未设"}  hooks=${s.config.hooksInstalled ? "已装" : "未装"}（${s.config.hookEvents.join(",") || "无"}）`);
  out(`  L3 提示词  ${s.style.exists ? s.style.file : "未写入"}`);
  out(`  L4 会话层  CLAUDE.md 注入=${s.session.injected ? "是" : "否"}  注入正文=${s.session.promptExists ? "就绪" : "缺失"}`);
  out("");
  out(`  规则集     ${readConfig().rule}   （模型映射 ${Object.keys(readConfig().modelRules || {}).length} 条）`);
  out(`  锚点数据   ${s.meta.generatedAt}  ${s.meta.target?.identity ?? ""}`);
  out("");
}

async function cmdApply() {
  const dryRun = has("--dry-run");
  const layersArg = val("--layers");
  const layers = layersArg
    ? Object.fromEntries(
        ["engine", "config", "style", "session"].map((k) => [k, layersArg.split(",").includes(k)]),
      )
    : null;

  // 1) 停宿主（Windows 会独占锁定 exe）
  if (!dryRun && !has("--no-stop")) {
    const { hostRunning, stopHost } = await import("../lib/restart.js");
    if (hostRunning()) {
      out("[cdpurge] 停宿主 …");
      const r = stopHost({});
      out(`[cdpurge] 停宿主结果：ok=${r.ok} 停 ${r.stopped.length} 个进程，残留 ${r.remaining.length} 个`);
    }
  }

  const report = await apply({
    dryRun,
    layers,
    rule: val("--rule"),
    model: val("--model"),
    force: has("--force"),
    sidecar: val("--sidecar", "keep"),
  });

  if (has("--json")) {
    out(JSON.stringify(report, null, 2));
  } else {
    header(dryRun ? "应用（试运行，不写盘）" : "应用");
    out(`  目标：${report.target.exe}`);
    out(`  版本/哈希：${report.target.version} / ${report.target.hash}`);
    out(`  规则集：${report.rule}`);
    out(`  层：${Object.entries(report.layers).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
    out("");
    if (report.steps.scan) {
      out(`  扫描：命中 ${report.steps.scan.hit} / 已打 ${report.steps.scan.patched} / 未命中 ${report.steps.scan.miss}`);
    }
    const e = report.steps.engine;
    if (e) {
      if (e.skipped) out(`  L1 引擎：${e.skipped === "already-patched" ? "已打过，跳过" : e.skipped}`);
      else if (e.dryRun) {
        out(`  L1 引擎（试运行）：将改 ${e.count} 处 / ${e.patches} 条；删 .verified=${e.wouldDeleteVerified}；重写 .payload=true`);
        if (e.misses?.length) out(`    锚点缺失：${e.misses.join(", ")}`);
      } else {
        out(`  L1 引擎：${e.count} 处 / ${e.patches} 条`);
        out(`    size ${e.sizeBefore.toLocaleString()} → ${e.sizeAfter.toLocaleString()}（不变）`);
        out(`    sha256 ${e.shaBefore.slice(0, 16)}… → ${e.shaAfter.slice(0, 16)}…`);
        out(`    .verified 删除=${e.verifiedRemoved}  .payload 重写=${e.payloadWritten}`);
        out(`    journal ${e.journalPath}`);
      }
    }
    const c = report.steps.config;
    if (c) {
      if (c.dryRun) {
        out(`  L2 配置：${c.settingsFile}`);
        out(`    将新增键：${c.wouldAddKeys?.join(", ") || "（无）"}`);
        out(`    将写文件：${(c.wouldWrite || []).join("\n              ") || "（无）"}`);
        out(`    将装 hooks：${c.wouldInstallHooks?.join(",") || "（无）"}`);
      } else {
        out(`  L2 配置：${c.settingsFile}`);
        if (c.addKeys?.length) out(`    新增键 ${c.addKeys.join(", ")}`);
        if (c.changedKeys?.length) out(`    改动键 ${c.changedKeys.join(", ")}`);
        out(`  L3 提示词：${c.outputStyle ?? "-"}`);
        out(`  L4 会话层：CLAUDE.md=${c.claudeMd ?? "-"}  hooks=${c.hooksAdded?.join(",") || "-"}`);
      }
    }
    if (report.masterJournal) out(`\n  master journal ${report.masterJournal}`);
  }

  // 2) 重启宿主
  const wantRestart = has("--restart") || (!dryRun && !has("--no-restart") && readConfig().autoRestart);
  if (wantRestart && !dryRun) {
    const { startHost } = await import("../lib/restart.js");
    out("[cdpurge] 用 explorer.exe 重新拉起宿主 …");
    const r = startHost({});
    out(`[cdpurge] 启动结果：ok=${r.started} 方式=${r.method} pid=${(r.pids || []).slice(0, 3).join(",") || "-"}`);
  }
}

async function cmdRevert() {
  const { hostRunning, stopHost } = await import("../lib/restart.js");
  if (hostRunning() && !has("--no-stop")) {
    out("[cdpurge] 停宿主 …");
    const r = stopHost({});
    out(`[cdpurge] ok=${r.ok} 残留 ${r.remaining.length}`);
  }
  const r = revert();
  if (has("--json")) {
    out(JSON.stringify(r, null, 2));
    return;
  }
  header("回滚");
  out(`  master journal：${r.master ?? "无（退化到引擎 journal）"}`);
  for (const [k, v] of Object.entries(r.steps)) {
    if (!v) continue;
    const s = v.ok === false ? `失败：${v.error ?? v.reason ?? ""}` : v.deleted ? "已删除" : v.changed === false ? "无变化" : "已还原";
    out(`  ${padEnd(k, 12)}${s}${v.path ? `  ${v.path}` : ""}`);
  }
  if (r.steps.engine?.sha256) {
    out("");
    out(`  exe sha256 ${r.steps.engine.sha256}`);
    out(`  与原始一致：${r.steps.engine.hashMatches === null ? "未知" : r.steps.engine.hashMatches ? "是" : "否"}`);
    out(`  size ${r.steps.engine.size.toLocaleString()} B`);
  }
  out("");
}

async function cmdUninstall() {
  const r = uninstall({ keepBackups: !has("--purge") });
  header("卸载");
  out(`  回滚：${r.steps.revert?.ok === false ? "失败" : "完成"}`);
  out(`  运行时：${JSON.stringify(r.steps.runtime)}`);
  out("");
}

async function cmdRules() {
  const sub = argv[argv.indexOf("--rules") + 1] ?? "list";
  const rest = argv.slice(argv.indexOf("--rules") + 2).filter((a) => !a.startsWith("--"));
  if (sub === "list") {
    header("规则集");
    for (const r of listRuleSets()) {
      out(`  ${padEnd(r.id, 20)}${padEnd(r.source === "user" ? "用户" : "内置", 6)}${padStart(r.size, 6)} B  ${r.path}`);
    }
    out("");
    out(`  当前默认：${readConfig().rule}`);
    const map = readConfig().modelRules || {};
    if (Object.keys(map).length) {
      out("  模型映射：");
      for (const [k, v] of Object.entries(map)) out(`    ${padEnd(k, 28)}→ ${v}`);
    }
    out("");
    return;
  }
  if (sub === "show") {
    const rs = readRuleSet(rest[0]);
    if (!rs) return out(`  规则集不存在：${rest[0]}`);
    header(`规则集 ${rs.id}（${rs.source === "user" ? "用户" : "内置"}）${rs.path}`);
    out(rs.body);
    return;
  }
  if (sub === "use") {
    const id = rest[0];
    if (!id) return out("  用法：--rules use <id>");
    if (!readRuleSet(id)) return out(`  规则集不存在：${id}`);
    writeConfig({ rule: id });
    return out(`  默认规则集 → ${id}`);
  }
  if (sub === "create") {
    const id = rest[0];
    if (!id) return out("  用法：--rules create <id> [--body <file>]");
    const bodyFile = val("--body");
    const body = bodyFile && fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : undefined;
    const r = createRuleSet(id, body);
    return out(`  已创建：${r.path}`);
  }
  if (sub === "write") {
    const id = rest[0];
    const file = rest[1];
    if (!id || !file) return out("  用法：--rules write <id> <file>");
    const r = writeRuleSet(id, fs.readFileSync(file, "utf8"));
    return out(`  已写入：${r.path}`);
  }
  if (sub === "delete") {
    const id = rest[0];
    if (!id) return out("  用法：--rules delete <id>");
    return out(`  ${deleteRuleSet(id) ? "已删除" : "未找到（内置规则集不可删）"}：${id}`);
  }
  if (sub === "map") {
    const [model, id] = rest;
    if (!model || !id) return out("  用法：--rules map <model> <ruleId>（id 传 - 解绑）");
    const cfg = readConfig();
    const map = { ...(cfg.modelRules || {}) };
    if (id === "-") delete map[model];
    else map[model] = id;
    writeConfig({ modelRules: map });
    return out(`  ${model} → ${id === "-" ? "（解绑）" : id}`);
  }
  return out(`  未知子命令：${sub}`);
}

async function cmdRestart() {
  const { restartHost } = await import("../lib/restart.js");
  const r = restartHost({});
  if (has("--json")) return out(JSON.stringify(r, null, 2));
  header("重启宿主");
  out(JSON.stringify(r, null, 2));
}

async function cmdVerify() {
  const r = await verifyPersisted({ restart: has("--restart") });
  if (has("--json")) return out(JSON.stringify(r, null, 2));
  header("持久化自检");
  out(`  目标：${r.target}`);
  out(`  应用后 sha256：${r.expectedSha256 ?? "（无 journal）"}`);
  out(`  当前 sha256：${r.after.sha256}`);
  out(`  size 不变：${r.sizeUnchanged}（${r.after.size.toLocaleString()} B）`);
  out(`  .verified 存在：${r.after.verifiedExists}`);
  out(`  .payload.sha256：${r.after.payload?.sha256 ?? "无"}`);
  out(`  宿主运行中：${r.cliRunning?.running ? `是（${r.cliRunning.count} 个进程）` : "否"}`);
  out("");
  if (r.persisted === true) out("  ✅ 补丁仍在：宿主没有重下载覆盖。");
  else if (r.persisted === false) out("  ❌ 补丁被覆盖：宿主重下载了原版。请改用 --sidecar keep 重新应用。");
  else out("  （没有基线 sha，未判定）");
  out("");
}

async function main() {
  if (argv.length === 0 || has("--help") || has("-h")) return help();

  if (has("--scan")) return cmdScan();
  if (has("--status")) return cmdStatus();
  if (has("--apply")) return cmdApply();
  if (has("--revert")) return cmdRevert();
  if (has("--uninstall")) return cmdUninstall();
  if (has("--verify")) return cmdVerify();
  if (has("--rules")) return cmdRules();
  if (has("--restart")) return cmdRestart();
  if (has("--install-plugin") || has("--remove-plugin")) {
    const { spawnSync } = await import("node:child_process");
    const args = [path.join(import.meta.dirname, "install-plugin.js")];
    if (has("--remove-plugin")) args.push("--remove");
    const r = spawnSync(process.execPath, args, { stdio: "inherit" });
    process.exitCode = r.status ?? 0;
    return;
  }
  if (has("--ui")) {
    const { startUI } = await import("../lib/ui.js");
    const port = parseInt(val("--port", "8787"), 10);
    const { url } = await startUI({ port, open: !has("--no-open") });
    out(`[cdpurge] 面板已启动：${url}   （Ctrl+C 退出）`);
    return;
  }
  out(`未知参数：${argv.join(" ")}`);
  help();
  process.exitCode = 2;
}

main().catch((e) => {
  out(`错误：${e?.message || e}`);
  if (e?.misses) for (const m of e.misses) out(`  - ${m.id} (${m.encoding}) find=${m.find}`);
  if (process.env.CDPURGE_DEBUG) out(e?.stack || "");
  process.exitCode = 1;
});