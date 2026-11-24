// claude-desktop-purge / lib/patches.js
//
// 补丁表。目标真身：%LOCALAPPDATA%\Claude-3p\claude-code\<版本>\<哈希>\claude.exe
// （Bun 编译的单文件 CLI，387 MB；Claude Code Desktop 只是 UI，补丁打在这个子进程上）
//
// 锚点数据由 tools/gen-patches.mjs 从**本机二进制**里切出来，落在 patches.data.json：
//   - 11 条沿用 cc-haha 原文（I01–I03 / R01–R03 / B01–B03 / F01 / T01），在本机重新确认编码与偏移；
//   - 13 条按 2.1.330 的真实文本重新取锚（S01–S10 / B04 / C01 / M01）——
//     2.1.330 的分类器提示词整体改版（HARD/SOFT BLOCK + severity 评分），旧锚点全部失效。
//
// 硬约束：Bun 的 payload 用绝对偏移寻址，任何长度变化都会让后面的常量错位。
// 所以全部是**等长字节写回**：replace 比 find 短的部分由写盘器补 0x00。
//
// 编码：本机二进制的主 payload 是 **UTF-8**（Bun 把 JS 源码按 UTF-8 内联）；
// 少数区段是 UTF-16LE。每条 target 的 encoding 都是实测值，不是猜的。

import fs from "node:fs";
import path from "node:path";

const DATA_FILE = path.join(import.meta.dirname, "patches.data.json");

export const PATCH_LAYERS = {
  identity: "身份",
  prompt: "提示词",
  policy: "策略",
  permission: "权限",
  sandbox: "沙箱",
  context: "上下文",
  malware: "恶意样本",
  engine: "引擎",
};

/** 面板/CLI 的分组顺序 */
export const DISPLAY_GROUPS = [
  ["identity", "身份层"],
  ["prompt", "提示词层"],
  ["policy", "策略层"],
  ["permission", "权限层"],
  ["sandbox", "沙箱层"],
  ["context", "上下文信任"],
  ["malware", "恶意样本策略"],
  ["engine", "引擎开关"],
];

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`缺少锚点数据：${DATA_FILE}（先跑 node tools/gen-patches.mjs）`);
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

/** 把一条生成项拆成 targets（主片段 + extra 附加片段） */
function toTargets(entry) {
  const one = (x) => ({
    encoding: x.encoding ?? entry.encoding ?? "utf8",
    find: x.find,
    replace: x.replace,
    findBytes: x.findBytes ?? Buffer.byteLength(x.find, x.encoding ?? "utf8"),
    replaceBytes: x.replaceBytes ?? Buffer.byteLength(x.replace, x.encoding ?? "utf8"),
    padBytes: x.padBytes ?? 0,
    offsets: Array.isArray(x.offsets) ? x.offsets.slice() : [],
  });
  const list = [one(entry)];
  for (const e of entry.extra ?? []) list.push(one(e));
  return list;
}

/** 全量补丁（含运行时校验） */
export const ALL_PATCHES = (() => {
  const data = loadData();
  const out = data.patches.map((entry) => {
    const targets = toTargets(entry);
    for (const t of targets) {
      if (t.replaceBytes > t.findBytes) {
        throw new Error(
          `补丁 ${entry.id} 的替换超出等长上限：find=${t.findBytes}B replace=${t.replaceBytes}B`,
        );
      }
      t.padBytes = t.findBytes - t.replaceBytes;
    }
    return {
      id: entry.id,
      kind: entry.kind,
      layer: entry.layer,
      desc: entry.desc,
      source: entry.source, // "cc-haha" | "2.1.330"
      encoding: entry.encoding,
      targets,
      findBytes: targets.reduce((s, t) => s + t.findBytes, 0),
      occurrences: targets.reduce((s, t) => s + t.offsets.length, 0),
    };
  });
  const dataMeta = {
    generatedAt: data.generatedAt,
    target: data.target,
    problems: data.problems ?? [],
  };
  Object.defineProperty(out, "meta", { value: dataMeta, enumerable: false });
  return out;
})();

export const PATCH_DATA_META = ALL_PATCHES.meta;

export function patchById(id) {
  return ALL_PATCHES.find((p) => p.id === id) ?? null;
}

export function patchesByKind() {
  const map = new Map();
  for (const p of ALL_PATCHES) {
    if (!map.has(p.kind)) map.set(p.kind, []);
    map.get(p.kind).push(p);
  }
  return map;
}

/** 生成「等长字节串」：replace bytes + NUL 填充 */
export function buildReplacementBuffer(target) {
  const body = Buffer.from(target.replace, target.encoding);
  if (body.length > target.findBytes) {
    throw new Error(`替换超长：${target.findBytes}B 上限，实际 ${body.length}B`);
  }
  const pad = Buffer.alloc(target.findBytes - body.length, 0x00);
  return Buffer.concat([body, pad]);
}

/** 把等长字节串解码回可读文本（尾部 NUL 去掉），用于 --status/--scan 显示 */
export function decodePatched(buf, encoding = "utf8") {
  return buf.toString(encoding).replace(/\u0000+$/, "");
}

/** 概要：条数与字节数 */
export function patchSummary() {
  return {
    total: ALL_PATCHES.length,
    occurrences: ALL_PATCHES.reduce((s, p) => s + p.occurrences, 0),
    bytes: ALL_PATCHES.reduce((s, p) => s + p.findBytes, 0),
    bySource: ALL_PATCHES.reduce((acc, p) => {
      acc[p.source] = (acc[p.source] || 0) + 1;
      return acc;
    }, {}),
  };
}