#!/usr/bin/env node
// claude-desktop-purge / tools/asar-probe.mjs
// 在 Electron asar（未压缩归档，可直接按字节搜）里扫 needle 并打印上下文。
//   node tools/asar-probe.mjs --file app.asar --needles tools/asar-needles.json [--pad 200] [--max 6]

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const g = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const file = g(
  "--file",
  path.join(
    process.env.LOCALAPPDATA,
    "AnthropicClaude",
    "app-6.28899.6",
    "resources",
    "app.asar",
  ),
);
const needlesFile = g("--needles", null);
const needles = needlesFile
  ? JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", needlesFile.replace(/^docs[\\/]/, "docs/")), "utf8"))
  : [];
const PAD = parseInt(g("--pad", "180"), 10);
const MAX = parseInt(g("--max", "5"), 10);

const buf = fs.readFileSync(file);
const lines = [`# asar probe ${file} size=${buf.length}`];
for (const n of needles) {
  const nb = Buffer.from(n, "utf8");
  let at = buf.indexOf(nb);
  const hits = [];
  while (at >= 0 && hits.length < MAX) {
    hits.push(at);
    at = buf.indexOf(nb, at + 1);
  }
  lines.push("", `## ${n}  → ${hits.length}${hits.length >= MAX ? "+" : ""}`);
  for (const h of hits) {
    const s = Math.max(0, h - PAD);
    const e = Math.min(buf.length, h + PAD);
    const txt = buf
      .subarray(s, e)
      .toString("utf8")
      .replace(/[^\x09\x0a\x20-\x7e]/g, "·");
    lines.push(`@${h}  …${txt}…`);
  }
}
process.stdout.write(lines.join("\n") + "\n");