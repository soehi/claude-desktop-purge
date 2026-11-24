#!/usr/bin/env node
// claude-desktop-purge / tools/showrange.mjs
// 把二进制里 [at, at+len) 区间按 UTF-8 解出来，逐行显示并标注每行起始字节偏移。
//   node tools/showrange.mjs --at 332793000 --len 40000 [--out docs/x.txt]
// 只读。

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const g = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const file =
  g("--file") ||
  argv.find((a) => a.endsWith(".exe") || a.endsWith(".asar")) ||
  path.join(process.env.LOCALAPPDATA, "Claude-3p", "claude-code", "2.1.330", "9424831ad51c", "claude.exe");
const at = parseInt(g("--at"), 10);
const len = parseInt(g("--len"), 10);
const out = g("--out", null);

const fd = fs.openSync(file, "r");
const buf = Buffer.alloc(len);
const n = fs.readSync(fd, buf, 0, len, at);
fs.closeSync(fd);

// 逐字节可读化：保留 ASCII 与 \n\t，其余（含非 ASCII 与 NUL）显示为 ·
const lines = [];
let cur = [];
let curStart = at;
let col = 0;
const flush = () => {
  if (cur.length) lines.push(`@${String(curStart).padStart(9)} | ${cur.join("")}`);
  cur = [];
  col = 0;
};
for (let i = 0; i < n; i++) {
  const b = buf[i];
  if (b === 10) {
    flush();
    curStart = at + i + 1;
    continue;
  }
  if (col === 0) curStart = at + i;
  if (b === 9) cur.push("\\t");
  else if (b >= 0x20 && b < 0x7f) cur.push(String.fromCharCode(b));
  else if (b === 0) cur.push("∅");
  else cur.push("·");
  col++;
  if (col >= 150) flush();
}
flush();
const text = lines.join("\n");
if (out) fs.writeFileSync(path.join(import.meta.dirname, "..", out), text);
process.stdout.write(text + "\n");