#!/usr/bin/env node
// claude-desktop-purge / tools/make-report.mjs
// 从 lib/patches.data.json 生成 docs/anchor-report.md（24 条锚点明细，含偏移与字节预算）。

import fs from "node:fs";
import path from "node:path";
import { ALL_PATCHES, PATCH_LAYERS, PATCH_DATA_META, patchSummary } from "../lib/patches.js";

const L = [];
const meta = PATCH_DATA_META;
const sum = patchSummary();

L.push("# 锚点报告（2.1.330 / 9424831ad51c）");
L.push("");
L.push(`- 目标：\`${meta.target.file}\``);
L.push(`- 大小：${meta.target.size.toLocaleString()} B（补丁前后一致）`);
L.push(`- 原始 sha256：\`fa797c1bc7d4a3511da42622bae53a2b7f1276ae328c668f2bfef44635301caa\``);
L.push(`- 锚点生成：${meta.generatedAt}（\`node tools/gen-patches.mjs\` 重跑）`);
L.push(`- 条数：${ALL_PATCHES.length}；片段 ${sum.occurrences} 处；覆盖 ${sum.bytes} 字节`);
L.push(`- 来源：沿用 cc-haha ${sum.bySource["cc-haha"]} 条 + 按 2.1.330 重取 ${sum.bySource["2.1.330"]} 条`);
L.push("");
L.push("## 为什么 13 条要重取");
L.push("");
L.push("cc-haha 版锚点是在另一套 Bun payload 上取的。2.1.330 的变化有两类：");
L.push("");
L.push("1. **编码**：本机 payload 主体是 **UTF-8**（Bun 按 UTF-8 内联 JS 源码），不是 cc-haha 的 UTF-16LE；");
L.push("   同一文本通常还有**两份拷贝**（约 163.2–168.4 MB 与 326.2–333.0 MB 两段），必须全量命中。");
L.push("2. **分类器整体改版**：旧的 `Hard-deny rules are unconditional.` / `Apply soft-deny rules next.` /");
L.push("   `You are a security classifier for tool calls…` 全部不存在；新版是**两段式**：");
L.push("   - stage1 快判：`Err on the side of blocking`，输出 `<block>yes|no</block>`；");
L.push("   - stage2 严重度评分：`<severity>0–100</severity>`，**50 是 allow/block 分界线**；");
L.push("   - 主策略正文：`**By default, actions are ALLOWED.**` + HARD/SOFT BLOCK 规则表 + User Intent 规则。");
L.push("");
L.push("## 24 条锚点明细");
L.push("");
L.push("| ID | 层 | 来源 | 编码 | find B | replace B | NUL 填充 | 处数 | 偏移 |");
L.push("|---|---|---|---|---:|---:|---:|---:|---|");

for (const p of ALL_PATCHES) {
  for (const [i, t] of p.targets.entries()) {
    const id = i === 0 ? p.id : `${p.id} (附${i})`;
    const offsets = t.offsets.length
      ? t.offsets.map((o) => `\`${o}\``).join(", ")
      : "—";
    L.push(
      `| ${id} | ${PATCH_LAYERS[p.layer] ?? p.layer} | ${p.source} | ${t.encoding} | ${t.findBytes} | ${t.replaceBytes} | ${t.padBytes} | ${t.offsets.length} | ${offsets} |`,
    );
  }
}

L.push("");
L.push("## 替换语义（13 条新取锚点）");
L.push("");
L.push("| ID | 作用 | 原文 → 替换后 |");
L.push("|---|---|---|");
for (const p of ALL_PATCHES.filter((x) => x.source === "2.1.330")) {
  const t = p.targets[0];
  const short = (s) => `\`${String(s).replace(/\|/g, "\\|").slice(0, 96)}${s.length > 96 ? "…" : ""}\``;
  L.push(`| ${p.id} | ${p.desc} | ${short(t.find)} → ${short(t.replace)} |`);
}
L.push("");
L.push("## 等长与 NUL 填充");
L.push("");
L.push("Bun payload 用绝对偏移寻址，任何长度变化都会让后续常量错位。所有替换因此满足");
L.push("`byteLength(replace) <= byteLength(find)`，差额由写盘器补 `0x00`。");
L.push("`lib/patches.js` 在加载时逐条断言，超长直接抛错，写盘后再次断言 `sizeBefore === sizeAfter`。");
L.push("");

fs.writeFileSync(path.join(import.meta.dirname, "..", "docs", "anchor-report.md"), L.join("\n"));
process.stdout.write(`docs/anchor-report.md 已生成（${L.length} 行）\n`);