#!/usr/bin/env node
// claude-desktop-purge / bin/install-plugin.js
//
// 把本工程以「本地 marketplace + 插件」的形式登记进 Claude Code / Claude Desktop，
// 让它在宿主的插件列表里显示出来（[LocalPluginsReader] Found 1 local plugins）。
//
// 走 Claude Code 自带的插件管理命令，不改任何内部数据库：
//   claude.exe plugin marketplace add <工程根>
//   claude.exe plugin install claude-desktop-purge@claude-desktop-purge
//
// 用法：
//   node bin/install-plugin.js            登记 + 启用（幂等）
//   node bin/install-plugin.js --remove   卸载登记
//
// 登记后重启 Claude Desktop 即可在插件页看到；slash 命令 /cdpurge 与
// skill claude-desktop-purge 随之可用。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cliIdentity } from "../lib/paths.js";

const ROOT = path.join(import.meta.dirname, "..");
const NAME = "claude-desktop-purge";
const argv = process.argv.slice(2);
const remove = argv.includes("--remove");

const out = (s) => process.stdout.write(`${s}\n`);

function runCli(exe, args) {
  const r = spawnSync(exe, args, { encoding: "utf8", windowsHide: true, timeout: 120000 });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  };
}

function main() {
  const ident = cliIdentity();
  if (!ident?.exists) {
    out("找不到真身 CLI：%LOCALAPPDATA%\\Claude-3p\\claude-code\\<版本>\\<哈希>\\claude.exe");
    process.exitCode = 1;
    return;
  }

  for (const f of [
    path.join(ROOT, ".claude-plugin", "marketplace.json"),
    path.join(ROOT, "plugin", ".claude-plugin", "plugin.json"),
  ]) {
    if (!fs.existsSync(f)) {
      out(`缺少插件清单：${f}`);
      process.exitCode = 1;
      return;
    }
  }

  out(`CLI：${ident.exe}`);
  out(`工程：${ROOT}`);
  out("");

  if (remove) {
    const a = runCli(ident.exe, ["plugin", "uninstall", `${NAME}@${NAME}`]);
    out(a.stdout || a.stderr);
    const b = runCli(ident.exe, ["plugin", "marketplace", "remove", NAME]);
    out(b.stdout || b.stderr);
    out("");
    out("已移除登记（settings.json 里的 enabledPlugins / extraKnownMarketplaces 由 CLI 清理）。");
    return;
  }

  // 1) 本地 marketplace（幂等：已存在会提示，不视为失败）
  const add = runCli(ident.exe, ["plugin", "marketplace", "add", ROOT]);
  out(add.stdout || add.stderr);
  if (!add.ok && !/already|存在|exist/i.test(`${add.stdout}${add.stderr}`)) {
    out(`marketplace add 失败：${add.stderr || add.stdout}`);
  }

  // 2) 安装并启用插件
  const inst = runCli(ident.exe, ["plugin", "install", `${NAME}@${NAME}`]);
  out(inst.stdout || inst.stderr);
  if (!inst.ok) {
    out(`安装失败：${inst.stderr || inst.stdout}`);
    process.exitCode = 1;
    return;
  }

  // 3) 复核
  const list = runCli(ident.exe, ["plugin", "list"]);
  out("");
  out(list.stdout || list.stderr);

  out("");
  out("下一步：重启 Claude Desktop（node bin/cdpurge.js --restart）。");
  out("宿主日志应出现：[LocalPluginsReader] Found 1 local plugins");
  out("会话里可用：/cdpurge（status|scan|apply|revert|rules|ui）与 skill claude-desktop-purge。");
}

main();