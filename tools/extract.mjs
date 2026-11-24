#!/usr/bin/env node
// claude-desktop-purge / tools/extract.mjs
// 按偏移抽窗口，解码成可读文本落盘（只读源文件）。
//   node tools/extract.mjs --at 331900000 --len 1300000 --out docs/win-cls.txt [--encoding utf8|utf16le]

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const get = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const file =
  argv.find((a) => a.endsWith(".exe")) ||
  path.join(process.env.LOCALAPPDATA, "Claude-3p", "claude-code", "2.1.330", "9424831ad51c", "claude.exe");
const at = parseInt(get("--at"), 10);
const len = parseInt(get("--len"), 10);
const out = get("--out", `docs/win-${at}.txt`);
const encoding = get("--encoding", "utf8");

const fd = fs.openSync(file, "r");
const buf = Buffer.alloc(len);
const read = fs.readSync(fd, buf, 0, len, at);
fs.closeSync(fd);
const slice = buf.subarray(0, read);

let text;
if (encoding === "utf16le") {
  text = slice.toString("utf16le");
} else {
  // 逐字节：可打印原样，NUL 转 ·，其余转 ·
  const chars = new Array(slice.length);
  for (let i = 0; i < slice.length; i++) {
    const b = slice[i];
    if (b === 9 || b === 10 || b === 13) chars[i] = String.fromCharCode(b);
    else if (b >= 0x20 && b < 0x7f) chars[i] = String.fromCharCode(b);
    else if (b === 0) chars[i] = "";
    else chars[i] = "\u00b7";
  }
  text = chars.join("");
}
const target = path.join(import.meta.dirname, "..", out);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, text);
process.stdout.write(`${out}  at=${at} len=${read} enc=${encoding} chars=${text.length}\n`);