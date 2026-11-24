// claude-desktop-purge / lib/ui.js
//
// 本地面板：127.0.0.1 上的单页控制台，零依赖（node:http）。
//
// 端点：
//   GET  /                 面板
//   GET  /api/status       四层状态
//   GET  /api/scan         引擎扫描（只读）
//   POST /api/apply        应用（body: {dryRun, rule}）
//   POST /api/revert       回滚
//   GET  /api/rules        规则集列表
//   GET  /api/rule?id=     规则集正文
//   PUT  /api/rule         写规则集（body: {id, body}）
//   POST /api/restart      重启宿主
//
// 全部输出简体中文；代码标识符与命令保持原文。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  apply,
  listRuleSets,
  readConfig,
  readRuleSet,
  revert,
  scan,
  status,
  writeRuleSet,
  writeConfig,
} from "./apply.js";

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>claude-desktop-purge</title>
<style>
  :root{--bg:#0f1110;--fg:#e8e8e3;--dim:#8b918d;--line:#242a26;--acc:#7ee0a0;--warn:#e8c35a;--bad:#e8705a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:baseline}
  h1{font-size:14px;margin:0;letter-spacing:.06em}
  header small{color:var(--dim)}
  main{display:grid;grid-template-columns:1fr 1fr}
  section{padding:14px 18px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);overflow:auto}
  section:nth-child(2n){border-right:none}
  h2{font-size:11px;color:var(--dim);letter-spacing:.14em;margin:0 0 10px}
  button{background:#1a1f1c;color:var(--fg);border:1px solid var(--line);padding:5px 11px;border-radius:4px;cursor:pointer;font:inherit}
  button:hover{border-color:var(--acc);color:var(--acc)}
  button.acc{border-color:var(--acc);color:var(--acc)}
  button.warn{border-color:var(--warn);color:var(--warn)}
  button.bad{border-color:var(--bad);color:var(--bad)}
  .row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
  pre{background:#0a0c0b;border:1px solid var(--line);padding:10px;border-radius:4px;overflow:auto;margin:0;max-height:46vh;white-space:pre-wrap}
  textarea{width:100%;min-height:30vh;background:#0a0c0b;color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:10px;font:inherit}
  select{background:#1a1f1c;color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:5px}
  .full{grid-column:1/-1;border-right:none}
  .ok{color:var(--acc)}.pend{color:var(--warn)}.miss{color:var(--bad)}
</style></head><body>
<header><h1>claude-desktop-purge</h1><small id="where">载入中…</small></header>
<main>
  <section>
    <h2>操作</h2>
    <div class="row">
      <button class="acc" onclick="act('apply',{})">应用四层</button>
      <button onclick="act('apply',{dryRun:true})">试运行</button>
      <button class="warn" onclick="act('revert',{})">回滚</button>
      <button class="bad" onclick="if(confirm('重启宿主？'))act('restart',{})">重启宿主</button>
    </div>
    <div class="row">
      <select id="ruleSel" onchange="useRule(this.value)"></select>
      <button onclick="loadRules()">刷新规则集</button>
    </div>
    <pre id="out">就绪。</pre>
  </section>
  <section>
    <h2>引擎扫描</h2>
    <pre id="scan">载入中…</pre>
  </section>
  <section class="full">
    <h2>四层状态</h2>
    <pre id="status">载入中…</pre>
  </section>
  <section class="full">
    <h2>规则集正文 <small id="ruleMeta"></small></h2>
    <textarea id="ruleBody"></textarea>
    <div class="row" style="margin-top:8px">
      <button onclick="saveRule()">保存为用户规则集</button>
    </div>
  </section>
</main>
<script>
const $=id=>document.getElementById(id);
async function j(url,opt){const r=await fetch(url,opt);return r.json()}
function show(el,txt){$(el).textContent=typeof txt==='string'?txt:JSON.stringify(txt,null,2)}
async function loadStatus(){const s=await j('/api/status');
  $('where').textContent=(s.cli?s.cli.exe:'未找到 CLI');
  const L=[];
  L.push('宿主外壳  '+(s.host.exe||'未找到'));
  if(s.cli){L.push('真身 CLI  '+s.cli.exe);L.push('版本/哈希 '+s.cli.version+' / '+s.cli.hash+(s.cli.running?'（运行中）':''))}
  if(s.engine){L.push('L1 引擎   size '+s.engine.size+'  sha256 '+String(s.engine.sha256).slice(0,16)+'…');
    L.push('          .verified '+(s.engine.verified?'存在':'已删')+'   .payload '+(s.engine.payload&&s.engine.payload.sha256?s.engine.payload.sha256.slice(0,16)+'…':'无'));
    L.push('          journal '+(s.engine.journal?String(s.engine.journal).split(/[\\\\/]/).pop()+'（'+s.engine.patchedOps+' 处）':'无'))}
  L.push('L2 配置   defaultMode='+(s.config.defaultMode??'未设')+'  permissions.defaultMode='+(s.config.permissionsDefaultMode??'未设'));
  L.push('          outputStyle='+(s.config.outputStyle??'未设')+'  hooks='+(s.config.hooksInstalled?'已装':'未装'));
  L.push('L3 提示词 '+(s.style.exists?s.style.file:'未写入'));
  L.push('L4 会话层 CLAUDE.md 注入='+(s.session.injected?'是':'否')+'  注入正文='+(s.session.promptExists?'就绪':'缺失'));
  L.push('');L.push('锚点数据  '+s.meta.generatedAt+'  '+((s.meta.target&&s.meta.target.identity)||''));
  show('status',L.join('\\n'));}
async function doScan(){const r=await j('/api/scan');
  if(r.error)return show('scan','扫描失败：'+r.error);
  const L=[(r.file||''),(r.size?r.size.toLocaleString()+' B':'') ,''];
  for(const x of r.results||[]){
    const st=x.status==='hit'?'命中':x.status==='patched'?'已打':'未命中';
    L.push((x.id+'    ').slice(0,5)+st.padEnd(5)+' '+(x.offsets||[]).slice(0,4).join(',')+((x.offsets||[]).length>4?' …':''));}
  L.push('');L.push('命中 '+r.counts.hit+' / 已打 '+r.counts.patched+' / 未命中 '+r.counts.miss);
  show('scan',L.join('\\n'));}
async function loadRules(){const r=await j('/api/rules');
  $('ruleSel').innerHTML=(r.rules||[]).map(x=>'<option '+(x.id===r.current?'selected':'')+' value="'+x.id+'">'+x.id+'（'+(x.source==='user'?'用户':'内置')+'）</option>').join('');
  await loadRule($('ruleSel').value);}
async function loadRule(id){if(!id)return;const r=await j('/api/rule?id='+encodeURIComponent(id));
  $('ruleBody').value=r.body||'';$('ruleMeta').textContent=r.path||'';}
async function saveRule(){const id=$('ruleSel').value;if(!id)return;
  await j('/api/rule',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({id,body:$('ruleBody').value})});
  show('out','已保存用户规则集：'+id);}
async function useRule(id){if(!id)return;await j('/api/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({rule:id})});show('out','默认规则集 → '+id);}
async function act(kind,body){show('out','执行中…');
  const url=kind==='apply'?'/api/apply':kind==='revert'?'/api/revert':'/api/restart';
  const r=await j(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
  show('out',r);await loadStatus();await doScan();}
loadStatus();doScan();loadRules();
</script></body></html>`;

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 4 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

export async function startUI({ port = 8787, open = true } = {}) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(PAGE);
      }
      if (req.method === "GET" && u.pathname === "/api/status") return json(res, status());
      if (req.method === "GET" && u.pathname === "/api/scan") {
        try {
          return json(res, scan());
        } catch (e) {
          return json(res, { error: String(e?.message || e) });
        }
      }
      if (req.method === "POST" && u.pathname === "/api/apply") {
        const body = await readBody(req);
        try {
          const r = await apply({ dryRun: !!body.dryRun, rule: body.rule || null });
          return json(res, r);
        } catch (e) {
          return json(res, { error: String(e?.message || e) }, 500);
        }
      }
      if (req.method === "POST" && u.pathname === "/api/revert") {
        try {
          return json(res, revert());
        } catch (e) {
          return json(res, { error: String(e?.message || e) }, 500);
        }
      }
      if (req.method === "POST" && u.pathname === "/api/restart") {
        const { restartHost } = await import("./restart.js");
        try {
          return json(res, restartHost({}));
        } catch (e) {
          return json(res, { error: String(e?.message || e) }, 500);
        }
      }
      if (req.method === "GET" && u.pathname === "/api/rules") {
        const cfg = readConfig();
        return json(res, { current: cfg.rule, rules: listRuleSets() });
      }
      if (req.method === "GET" && u.pathname === "/api/rule") {
        const id = u.searchParams.get("id");
        const rs = readRuleSet(id);
        if (!rs) return json(res, { error: "规则集不存在", id }, 404);
        return json(res, { id: rs.id, path: rs.path, body: rs.body });
      }
      if (req.method === "PUT" && u.pathname === "/api/rule") {
        const body = await readBody(req);
        if (!body.id) return json(res, { error: "缺少 id" }, 400);
        return json(res, writeRuleSet(body.id, String(body.body ?? "")));
      }
      if (req.method === "PUT" && u.pathname === "/api/config") {
        const body = await readBody(req);
        return json(res, writeConfig(body));
      }
      json(res, { error: "未知端点", path: u.pathname }, 404);
    } catch (e) {
      json(res, { error: String(e?.message || e) }, 500);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const url = `http://127.0.0.1:${port}/`;
  if (open) {
    try {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch {
      /* 打不开就把链接打出来 */
    }
  }
  return { server, url };
}

export { PAGE };