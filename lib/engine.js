// claude-desktop-purge / lib/engine.js
//
// L1 引擎层：对真身 CLI（Bun 单文件 exe）做**等长字节写回**。
//
// 为什么必须等长：Bun 的 payload 用绝对偏移寻址，插入或删除 1 个字节都会让后面的
// 常量、字符串指针、字节码表全部错位 —— 结果是 exe 直接跑不起来。
// 所以：replace 短于 find 时尾部补 0x00（NUL 对模型不可见），写盘后断言 size 不变。
//
// 完整性门（本机实测）：
//   .verified   marker 文件。缺失时主进程打印
//               "[CCD] Binary preflight: .verified marker missing but binary exists ... Proceeding with spawn"
//               → 改完 exe 删掉它即可放行。
//   .payload    {"sha256":..., "size":...}。改完必须重算回写，否则预检会判失败。
//   Authenticode  签名 Valid，但宿主**不校验**签名（只查上面两件），所以不需要重签。
//
// 所有写操作前先落 journal（逐字节 originalHex），--revert 按偏移写回并断言 size。

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ALL_PATCHES, buildReplacementBuffer } from "./patches.js";
import { journalDir, ensureDir, exists } from "./paths.js";

const LOG = "[cdpurge]";

export function log(...args) {
  process.stdout.write(`${LOG} ${args.join(" ")}\n`);
}

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------

export function fileHash(filePath) {
  const h = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let read = 0;
    do {
      read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read > 0) h.update(chunk.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

export function readPayload(cliDir) {
  const file = path.join(cliDir, ".payload");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writePayload(cliDir, obj) {
  const file = path.join(cliDir, ".payload");
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  return file;
}

export function readVerified(cliDir) {
  const file = path.join(cliDir, ".verified");
  try {
    return { exists: true, file, content: fs.readFileSync(file, "utf8") };
  } catch {
    return { exists: false, file, content: null };
  }
}

export function removeVerified(cliDir) {
  const file = path.join(cliDir, ".verified");
  if (exists(file)) {
    fs.rmSync(file, { force: true });
    return true;
  }
  return false;
}

export function restoreVerified(cliDir, content) {
  const file = path.join(cliDir, ".verified");
  if (content == null) {
    if (exists(file)) fs.rmSync(file, { force: true });
    return false;
  }
  fs.writeFileSync(file, content);
  return true;
}

function hexSlice(buf, offset, length) {
  return buf.subarray(offset, offset + length).toString("hex");
}

// ---------------------------------------------------------------------------
// 只读扫描
// ---------------------------------------------------------------------------

/**
 * 扫描全部补丁在本机二进制上的命中情况。
 * 三种状态：
 *   hit      find 原样存在 → 可打
 *   patched  原位置已经是 replace+NUL → 已打过
 *   miss     两者都没有 → 锚点失效（版本变了）
 *
 * @returns {{file,size,sha256,counts:{hit,patched,miss},results:[...]}}
 */
export function scanEngine({ file, patches = ALL_PATCHES } = {}) {
  if (!file || !exists(file)) throw new Error(`找不到引擎文件：${file}`);
  const size = fs.statSync(file).size;
  const buf = fs.readFileSync(file);
  const results = [];

  for (const p of patches) {
    const targets = [];
    for (const t of p.targets) {
      const findBuf = Buffer.from(t.find, t.encoding);
      const replBuf = buildReplacementBuffer(t);
      const hitOffsets = [];
      let from = 0;
      for (;;) {
        const at = buf.indexOf(findBuf, from);
        if (at < 0) break;
        hitOffsets.push(at);
        from = at + 1;
      }
      const patchedOffsets = [];
      let from2 = 0;
      for (;;) {
        const at = buf.indexOf(replBuf, from2);
        if (at < 0) break;
        patchedOffsets.push(at);
        from2 = at + 1;
      }
      targets.push({
        encoding: t.encoding,
        findBytes: t.findBytes,
        replaceBytes: t.replaceBytes,
        padBytes: t.padBytes,
        declared: t.offsets,
        hits: hitOffsets,
        patched: patchedOffsets,
        status: hitOffsets.length ? "hit" : patchedOffsets.length ? "patched" : "miss",
      });
    }
    const status = targets.every((t) => t.status === "patched")
      ? "patched"
      : targets.some((t) => t.status === "hit")
        ? "hit"
        : "miss";
    results.push({
      id: p.id,
      kind: p.kind,
      layer: p.layer,
      desc: p.desc,
      source: p.source,
      encoding: p.encoding,
      status,
      targets,
      offsets: targets.flatMap((t) => (t.hits.length ? t.hits : t.patched)),
    });
  }

  const counts = { hit: 0, patched: 0, miss: 0 };
  for (const r of results) counts[r.status] += 1;
  return { file, size, sha256: fileHash(file), counts, results };
}

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

function journalName(identity) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const v = identity?.version ?? "unknown";
  const h = identity?.hash ?? "unknown";
  return `${ts}_${v}_${h}.json`;
}

export function listJournals(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

/** 该 exe 最近一份 journal */
export function latestJournalFor(dir, file) {
  const all = listJournals(dir).reverse();
  for (const j of all) {
    try {
      const data = JSON.parse(fs.readFileSync(j, "utf8"));
      if (path.resolve(data.file) === path.resolve(file)) return { path: j, data };
    } catch {
      /* 跳过坏文件 */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 写盘
// ---------------------------------------------------------------------------

/**
 * 应用全部补丁。
 *
 * verifiedMode（完整性门策略，本机实测结论）：
 *   "keep"  保留 .verified 标记、只把 .payload 重算成改后文件的 {sha256,size}。
 *           —— Windows 上唯一能持久的方式：宿主的 findInstalledBinaryPath 要求
 *              `installDir/.verified` 存在，缺失即判定「未安装」，启动时 prefetch
 *              会拉 132 MB 原版并覆盖回去（本机 10:44:57 的 [download:1] 就是证据）。
 *   "drop"  删掉 .verified（旧假设：预检会打印 "marker missing but binary exists ...
 *           Proceeding with spawn"）。该分支只在 getHostBinaryPathIfPresent 路径上生效，
 *           前提是 manifest 里已有 checksum 且没有 in-flight 的 install；Windows 上
 *           实测会触发重下载，仅用于对照实验。
 *
 * @param {{file:string, cliDir?:string, identity?:object, patches?:Array, dirs?:object,
 *          dryRun?:boolean, skipSidecar?:boolean, force?:boolean, verifiedMode?:'keep'|'drop'}} o
 * @returns 摘要
 */
export function applyEnginePatches({
  file,
  cliDir = path.dirname(file),
  identity = null,
  patches = ALL_PATCHES,
  dirs = {},
  dryRun = false,
  skipSidecar = false,
  force = false,
  verifiedMode = "keep",
} = {}) {
  if (!file || !exists(file)) throw new Error(`找不到引擎文件：${file}`);
  const jdir = dirs.journalDir ?? journalDir();

  const sizeBefore = fs.statSync(file).size;
  const buf = fs.readFileSync(file);
  const shaBefore = createHash("sha256").update(buf).digest("hex");

  const ops = [];
  const misses = [];
  const already = [];

  for (const p of patches) {
    for (const t of p.targets) {
      const findBuf = Buffer.from(t.find, t.encoding);
      const replBuf = buildReplacementBuffer(t);
      const hits = [];
      let from = 0;
      for (;;) {
        const at = buf.indexOf(findBuf, from);
        if (at < 0) break;
        hits.push(at);
        from = at + 1;
      }
      if (!hits.length) {
        // 已经是打过状态？
        const done = buf.indexOf(replBuf) >= 0;
        if (done) already.push({ id: p.id, encoding: t.encoding });
        else misses.push({ id: p.id, encoding: t.encoding, find: t.find.slice(0, 60) });
        continue;
      }
      for (const offset of hits) {
        ops.push({
          id: p.id,
          encoding: t.encoding,
          offset,
          length: t.findBytes,
          originalHex: hexSlice(buf, offset, t.findBytes),
          patchedHex: replBuf.toString("hex"),
        });
      }
    }
  }

  if (misses.length && !force) {
    const detail = misses.map((m) => `${m.id}(${m.encoding})`).join(", ");
    const err = new Error(`有补丁锚点未命中，已中止（可加 --force 跳过）：${detail}`);
    err.misses = misses;
    throw err;
  }

  const sidecar = {
    verified: readVerified(cliDir),
    payload: readPayload(cliDir),
  };

  // dry-run：只报告，不写盘
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      file,
      sizeBefore,
      sizeAfter: sizeBefore,
      shaBefore,
      shaAfter: shaBefore,
      count: ops.length,
      patches: new Set(ops.map((o) => o.id)).size,
      ops,
      misses,
      already,
      sidecar,
      journalPath: null,
    };
  }

  // 1) 先落 journal（写盘前备份）
  ensureDir(jdir);
  const journalPath = path.join(jdir, journalName(identity));
  fs.writeFileSync(
    journalPath,
    `${JSON.stringify(
      {
        schema: 1,
        tool: "claude-desktop-purge",
        createdAt: new Date().toISOString(),
        target: {
          version: identity?.version ?? null,
          hash: identity?.hash ?? null,
          exe: file,
          sizeBefore,
          sha256Before: shaBefore,
        },
        file,
        ops,
        sidecar: {
          verified: { path: sidecar.verified.file, existed: sidecar.verified.exists, content: sidecar.verified.content },
          payload: { path: path.join(cliDir, ".payload"), existed: !!sidecar.payload, before: sidecar.payload },
          verifiedMode,
        },
      },
      null,
      2,
    )}\n`,
  );

  // 2) 等长写回
  const fd = fs.openSync(file, "r+");
  try {
    for (const op of ops) {
      const bytes = Buffer.from(op.patchedHex, "hex");
      if (bytes.length !== op.length) throw new Error(`内部错误：${op.id} 写入长度不一致`);
      fs.writeSync(fd, bytes, 0, bytes.length, op.offset);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  // 3) 断言 size 不变
  const sizeAfter = fs.statSync(file).size;
  if (sizeAfter !== sizeBefore) {
    throw new Error(`等长写回失败：size ${sizeBefore} → ${sizeAfter}（应立即用 --revert 回滚）`);
  }
  const shaAfter = fileHash(file);

  // 4) 完整性门：处理 .verified、重算 .payload
  let verifiedRemoved = false;
  let payloadWritten = false;
  if (!skipSidecar) {
    if (verifiedMode === "drop") {
      verifiedRemoved = removeVerified(cliDir);
    }
    // .verified 的存在性判定（publishedInstallDirs → pathExists）决定宿主认不认可这次安装，
    // 内容只是 build checksum 标记，与 exe 内容无关，所以 keep 模式下原样保留。
    writePayload(cliDir, { sha256: shaAfter, size: sizeAfter });
    payloadWritten = true;
  }

  return {
    ok: true,
    dryRun: false,
    file,
    sizeBefore,
    sizeAfter,
    shaBefore,
    shaAfter,
    count: ops.length,
    patches: new Set(ops.map((o) => o.id)).size,
    ops,
    misses,
    already,
    journalPath,
    sidecar: {
      verifiedRemoved,
      verified: sidecar.verified,
      payloadBefore: sidecar.payload,
      payloadWritten,
    },
  };
}

/**
 * 按 journal 逐字节回写。
 * @returns {{ok, file, restored, size, sha256, verifiedRestored, payloadRestored}}
 */
export function revertFromJournal({ journalPath }) {
  const data = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const file = data.file;
  if (!exists(file)) throw new Error(`找不到引擎文件：${file}`);

  const sizeBefore = fs.statSync(file).size;
  // 目标是「回到 journal 记录的那份」
  const fd = fs.openSync(file, "r+");
  let restored = 0;
  try {
    for (const op of [...data.ops].reverse()) {
      const bytes = Buffer.from(op.originalHex, "hex");
      if (bytes.length !== op.length) throw new Error(`journal 损坏：${op.id} 长度不符`);
      fs.writeSync(fd, bytes, 0, bytes.length, op.offset);
      restored += 1;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  const sizeAfter = fs.statSync(file).size;
  if (sizeAfter !== sizeBefore) throw new Error(`还原后 size 变化：${sizeBefore} → ${sizeAfter}`);

  const cliDir = path.dirname(file);
  let verifiedRestored = false;
  let payloadRestored = false;
  const sc = data.sidecar ?? {};
  if (sc.verified) {
    verifiedRestored = restoreVerified(cliDir, sc.verified.existed ? sc.verified.content : null);
  }
  if (sc.payload?.existed && sc.payload.before) {
    writePayload(cliDir, sc.payload.before);
    payloadRestored = true;
  } else if (sc.payload) {
    // 原本没有 .payload → 删掉我们写的那份，避免留残
    const p = path.join(cliDir, ".payload");
    if (exists(p)) fs.rmSync(p, { force: true });
    payloadRestored = true;
  }

  const sha256 = fileHash(file);
  return {
    ok: true,
    file,
    journalPath,
    restored,
    size: sizeAfter,
    sha256,
    expectedSha256: data.target?.sha256Before ?? null,
    hashMatches: data.target?.sha256Before ? sha256 === data.target.sha256Before : null,
    verifiedRestored,
    payloadRestored,
  };
}