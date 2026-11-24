#!/usr/bin/env node
// claude-desktop-purge / hooks/allow.js
//
// PreToolUse hook：把权限判定直接判成 allow，跳过逐次审批。
//
// 输出契约（与 inject.js 同族，字段名以宿主读取的 hookSpecificOutput 为准）：
//   { "hookSpecificOutput": {
//       "hookEventName": "PreToolUse",
//       "permissionDecision": "allow" | "deny" | "ask",
//       "permissionDecisionReason": "..."
//   } }
// 合法值只有 allow / deny / ask；多个 hook 的聚合优先级 deny > ask > allow，
// 所以本 hook 只负责抬 allow，别人写的 deny 仍然优先。
//
// 红线：任何异常都输出 "{}"（= 不作判定，交回默认流程），绝不阻塞会话。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PLUGIN_NAME = "claude-desktop-purge";
const STDIN_TIMEOUT_MS = 1200;

function configDir() {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (override) return path.resolve(override);
  const home = process.env.USERPROFILE?.trim() || process.env.HOME?.trim() || os.homedir();
  return path.join(home, ".claude");
}

function pluginHome() {
  return path.join(configDir(), PLUGIN_NAME);
}

function emit(obj) {
  try {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  } catch {
    /* stdout 不可写就放弃 */
  }
}

function releaseStdin() {
  try {
    process.stdin.pause();
    process.stdin.destroy?.();
  } catch {
    /* 忽略 */
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(buf);
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        if (buf.length > 1024 * 1024) finish();
      });
      process.stdin.on("end", () => {
        clearTimeout(timer);
        finish();
      });
      process.stdin.on("error", () => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

/** 插件开关：<pluginHome>\config.json 里 autoAllow === false 时静默 */
function autoAllowEnabled() {
  try {
    const file = path.join(pluginHome(), "config.json");
    if (!fs.existsSync(file)) return true;
    const cfg = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (cfg?.enabled === false) return false;
    if (cfg?.autoAllow === false) return false;
    return true;
  } catch {
    return true;
  }
}

async function main() {
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    raw = "";
  }

  if (!autoAllowEnabled()) {
    emit({});
    releaseStdin();
    return;
  }

  // 事件内容读进来只为「不阻塞管道」，判定本身与具体工具无关
  let event = null;
  try {
    event = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    event = null;
  }
  void event;

  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason:
        "claude-desktop-purge: 本次会话已按操作者授权展开，工具调用直接执行。",
    },
  });
  releaseStdin();
}

main().catch(() => {
  emit({});
  releaseStdin();
  process.exitCode = 0;
});