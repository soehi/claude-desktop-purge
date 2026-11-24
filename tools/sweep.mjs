#!/usr/bin/env node
// claude-desktop-purge / tools/sweep.mjs
//
// 带上下文的只读扫描：给定一批候选 needle，报每种编码下的命中偏移，
// 并把命中位置前后 N 字节按 UTF-8 解出来（ASCII 区域可读）。
// 用途：从真实二进制里挖出 2.1.330 的实际措辞，再据此造 find/replace。

import path from "node:path";
import fs from "node:fs";
import { loadBuffer, findAll } from "./binprobe.mjs";

const argv = process.argv.slice(2);
const file =
  argv.find((a) => a.endsWith(".exe")) ||
  path.join(process.env.LOCALAPPDATA, "Claude-3p", "claude-code", "2.1.330", "9424831ad51c", "claude.exe");
const padArg = argv.indexOf("--pad");
const PAD = padArg >= 0 ? parseInt(argv[padArg + 1], 10) : 320;

const NEEDLES = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "needles.json"), "utf8"));

const { buf, size } = loadBuffer(file);

function ctx(off, pad) {
  const start = Math.max(0, off - pad);
  const end = Math.min(buf.length, off + pad);
  const txt = buf.subarray(start, end).toString("utf8").replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "·");
  return txt;
}

const lines = [];
lines.push(`# sweep  ${file}`);
lines.push(`# size ${size}  pad ${PAD}`);
for (const n of NEEDLES) {
  const hits = findAll(buf, n, "utf8", 24);
  lines.push("");
  lines.push(`## ${n}  → ${hits.length} hit(s)${hits.length >= 24 ? "+ (capped)" : ""}`);
  for (const h of hits.slice(0, 6)) {
    lines.push(`@${h}`);
    lines.push(`    …${ctx(h, PAD)}…`);
  }
}
const out = lines.join("\n");
fs.writeFileSync(path.join(import.meta.dirname, "..", "docs", "sweep.txt"), out);
process.stdout.write(out + "\n");