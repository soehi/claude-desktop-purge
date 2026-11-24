#!/usr/bin/env node
// claude-desktop-purge / tools/binprobe.mjs
//
// 只读二进制探针：把 Claude Code CLI 那个 387 MB 的 Bun 单文件 exe 读进内存，
// 提供两种编码的 needle 搜索、按偏移回读原文、以及区域密度统计。
//
// 用途：给 24 条补丁重新取锚点（find 文本 / 实际存储编码 / 全部出现位置）。
// 绝不写盘。

import fs from "node:fs";

export const ENCODINGS = ["utf16le", "utf8"];

export function loadBuffer(file) {
  const st = fs.statSync(file);
  const buf = fs.readFileSync(file);
  return { buf, size: st.size, file };
}

/** 所有出现位置（cap 保护） */
export function findAll(buf, needle, encoding, cap = 64) {
  const nb = Buffer.from(needle, encoding);
  if (!nb.length) return [];
  const hits = [];
  let from = 0;
  for (;;) {
    const at = buf.indexOf(nb, from);
    if (at < 0) break;
    hits.push(at);
    if (hits.length >= cap) break;
    from = at + 1;
  }
  return hits;
}

export function searchAll(buf, needle, cap = 64) {
  const out = {};
  for (const enc of ENCODINGS) {
    const hits = findAll(buf, needle, enc, cap);
    if (hits.length) out[enc] = hits;
  }
  return out;
}

/** 从 offset 起按编码回读，遇 NUL / 换行 / 指定终止符停止 */
export function readAt(buf, offset, encoding, opts = {}) {
  const max = opts.max ?? 4096;
  const stopAt = opts.stop ?? "\u0000\n\r";
  if (encoding === "utf16le") {
    const chars = [];
    for (let i = offset; i + 1 < buf.length && chars.length < max; i += 2) {
      const code = buf.readUInt16LE(i);
      if (code === 0) break;
      const ch = String.fromCharCode(code);
      if (stopAt.includes(ch)) break;
      chars.push(ch);
    }
    return chars.join("");
  }
  const bytes = [];
  for (let i = offset; i < buf.length && bytes.length < max; i++) {
    const b = buf[i];
    if (b === 0) break;
    const ch = String.fromCharCode(b);
    if (stopAt.includes(ch)) break;
    bytes.push(b);
  }
  return Buffer.from(bytes).toString("utf8");
}

/** 提取定长片段并按两种编码尽力解码（用于区域勘察） */
export function dumpRegion(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  return {
    utf16le: slice.toString("utf16le"),
    utf8: slice.toString("utf8"),
    hex: slice.subarray(0, Math.min(96, len)).toString("hex"),
  };
}

/** 分窗统计「UTF-16LE 可打印率」，定位内联 JS 源码段 */
export function utf16PrintableWindows(buf, windowBytes = 4 * 1024 * 1024) {
  const rows = [];
  for (let base = 0; base + windowBytes <= buf.length; base += windowBytes) {
    let printable = 0;
    let total = 0;
    for (let i = base; i + 1 < base + windowBytes; i += 2) {
      const code = buf.readUInt16LE(i);
      total++;
      if (code >= 0x20 && code < 0xfffd && code !== 0x7f) printable++;
    }
    rows.push({ base, ratio: total ? +(printable / total).toFixed(3) : 0 });
  }
  return rows;
}

export function argOf(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}