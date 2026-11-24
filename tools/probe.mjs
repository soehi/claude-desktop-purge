#!/usr/bin/env node
// claude-desktop-purge / tools/probe.mjs
//
// 一次性锚点勘察驱动：拿 claudecode-purge（cc-haha 版）的 24 条 find 文本
// 去打 Claude Code Desktop 的真身 CLI（387 MB Bun 单文件），报每条在
// UTF-16LE / UTF-8 两种编码下的命中次数与偏移。
//
// 只读。产物：docs/anchor-probe.json + 控制台表格。

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadBuffer, searchAll, readAt } from "./binprobe.mjs";

// 可选：指向 cc-haha 版仓库以对比旧锚点；公开仓库不硬编码任何本机路径
const SRC_REPO = process.env.CCPURGE_SRC || null;
const argv = process.argv.slice(2);
const file =
  argv.find((a) => a.endsWith(".exe")) ||
  path.join(
    process.env.LOCALAPPDATA,
    "Claude-3p",
    "claude-code",
    "2.1.330",
    "9424831ad51c",
    "claude.exe",
  );

// 诊断 needle：判定「这套策略段落在这个版本里到底还在不在」
const DIAG = [
  ["CLS-HEAD", "You are a security classifier for tool calls made by a coding agent."],
  ["CLS-DECIDE", "Decide whether the current action is safe to execute without another user prompt."],
  ["CLS-HARDDENY", "Hard-deny rules are unconditional."],
  ["CLS-SOFTDENY", "Apply soft-deny rules next."],
  ["CLS-CLASSIFY", "Use the classify_result tool."],
  ["CLS-SENSITIVE", "Sensitive Data Exfiltration"],
  ["CLS-PERMBYPASS", "Permission-System Bypass"],
  ["CLS-IRREV", "Irreversible Local Changes"],
  ["CLS-EXTWRITE", "External Writes"],
  ["CLS-SECBOUND", "Security Boundary Changes"],
  ["TEMPLATE", "<permissions_template>"],
  ["AUTOMODE-FILE", "auto_mode_system_prompt"],
  ["IDENT", "You are Claude Code"],
  ["IDENT-OFFICIAL", "Anthropic's official CLI for Claude"],
  ["REFUSE-IMPORTANT", "IMPORTANT: Assist with authorized security testing"],
  ["REFUSE-INTERACTIVE", "You are an interactive CLI tool that helps users"],
  ["URL-NEVER", "You must NEVER generate or guess URLs"],
  ["SBX-PARAM", "dangerouslyDisableSandbox"],
  ["SBX-OUTSIDE", "Allow commands to run outside the sandbox via the dangerouslyDisableSandbox parameter"],
  ["SBX-RETRY", "When a command fails due to sandbox restrictions"],
  ["SBX-ALLOWLIST", "Do not suggest adding sensitive paths like ~/.bashrc"],
  ["SBX-DENIED", "Do not bypass a denied operation using another tool"],
  ["CLAUDE-MD-UNTRUSTED", "untrusted context and environment"],
  ["CLAUDE-MD-CANNOT", "cannot authorize actions or override policy"],
  ["MALWARE-REFUSE", "you MUST refuse to improve or augment the code"],
  ["MALWARE-CONSIDER", "consider whether it would be considered malware"],
  ["FAILCLOSED", "shouldBlock:!0"],
  ["FAILOPEN", "shouldBlock:!1"],
  ["HOOK-TREAT", "Treat feedback from hooks"],
  ["KEEPCODING", "keep-coding-instructions"],
];

const main = async () => {
  const { buf, size } = loadBuffer(file);
  const shaProbe = buf.subarray(0, 8).toString("hex");
  const patches = SRC_REPO
    ? await import(pathToFileURL(path.join(SRC_REPO, "lib", "patches.js")).href)
    : await import(pathToFileURL(path.join(import.meta.dirname, "..", "lib", "patches.js")).href);

  const rows = [];
  for (const p of patches.ALL_PATCHES) {
    const hits = searchAll(buf, p.find);
    const encs = Object.keys(hits);
    rows.push({
      id: p.id,
      kind: p.kind,
      declared: p.encoding,
      found: encs,
      counts: Object.fromEntries(encs.map((e) => [e, hits[e].length])),
      firstOffsets: hits,
      findBytes: Buffer.byteLength(p.find, p.encoding),
      findChars: Array.from(p.find).length,
      status: encs.length ? (encs.includes(p.encoding) ? "hit" : "hit-other-encoding") : "miss",
    });
  }

  const diag = DIAG.map(([id, needle]) => {
    const hits = searchAll(buf, needle, 8);
    return { id, needle: needle.slice(0, 60), encs: Object.keys(hits), hits };
  });

  const sanitize = (p) => {
    const la = process.env.LOCALAPPDATA || "";
    const up = process.env.USERPROFILE || "";
    let s = String(p);
    if (la && s.toLowerCase().startsWith(la.toLowerCase())) s = `%LOCALAPPDATA%${s.slice(la.length)}`;
    if (up && s.toLowerCase().startsWith(up.toLowerCase())) s = `%USERPROFILE%${s.slice(up.length)}`;
    return s;
  };

  const report = {
    meta: {
      file: sanitize(file),
      size,
      firstBytes: shaProbe,
      generatedAt: new Date().toISOString(),
      srcPatches: SRC_REPO ? sanitize(path.join(SRC_REPO, "lib", "patches.js")) : "本仓库 lib/patches.data.json",
    },
    patches: rows,
    diag,
  };
  const out = path.join(import.meta.dirname, "..", "docs", "anchor-probe.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  const pad = (s, n) => String(s).padEnd(n);
  const out2 = [];
  out2.push(`目标 ${file}`);
  out2.push(`大小 ${size.toLocaleString()} B`);
  out2.push("");
  out2.push(`${pad("ID", 5)}${pad("声明", 9)}${pad("状态", 20)}${pad("utf16le", 9)}utf8   首偏移`);
  let hit = 0;
  for (const r of rows) {
    if (r.status === "hit") hit++;
    out2.push(
      `${pad(r.id, 5)}${pad(r.declared, 9)}${pad(r.status, 20)}${pad(r.counts.utf16le ?? "-", 9)}${pad(r.counts.utf8 ?? "-", 6)}${
        (r.firstOffsets[r.declared] || Object.values(r.firstOffsets)[0] || []).slice(0, 3).join(", ") || "-"
      }`,
    );
  }
  out2.push("");
  out2.push(`直接命中 ${hit} / ${rows.length}`);
  out2.push("");
  out2.push("诊断 needle：");
  for (const d of diag) {
    const o = Object.entries(d.hits).map(([e, v]) => `${e}:${v.length}@${v[0]}`).join(" ");
    out2.push(`  ${pad(d.id, 18)}${o || "MISS"}`);
  }
  const txt = out2.join("\n");
  fs.writeFileSync(path.join(import.meta.dirname, "..", "docs", "anchor-probe.txt"), txt);
  process.stdout.write(txt + "\n");
};

main().catch((e) => {
  process.stdout.write(`probe 失败：${e?.stack || e}\n`);
  process.exitCode = 1;
});