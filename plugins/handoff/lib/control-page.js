// 本地控制台页面（浏览器打开 http://127.0.0.1:18191/ ）
// 为什么不用 .bat：插件市场禁止上传 exe/dll/bat/cmd/ps1/vbs/sh，
// 所以把"一键接管/交还"做成插件自带的网页，点到即用，且不落地任何可执行文件。
export function controlPageHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>双机接力 · 本地控制台</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0f1115;color:#e6e8ee;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#8b93a7;font-size:12px;margin-bottom:22px}
.card{background:#171a21;border:1px solid #232833;border-radius:12px;padding:16px 18px;margin-bottom:16px}
.kv{display:grid;grid-template-columns:100px 1fr;gap:6px 12px;font-size:13px}
.k{color:#8b93a7}
.v{word-break:break-all}
button{appearance:none;border:1px solid #2c3342;background:#1d2230;color:#e6e8ee;padding:10px 16px;border-radius:10px;font-size:14px;cursor:pointer;margin:0 8px 8px 0}
button:hover:not(:disabled){background:#242c3d}
button:disabled{opacity:.45;cursor:not-allowed}
#btn-take{border-color:#2f6f4f;background:#17301f}
#btn-give{border-color:#6f4f2f;background:#2c2217}
pre{background:#0b0d12;border:1px solid #1e232e;border-radius:10px;padding:12px;overflow:auto;max-height:280px;font-size:12px;margin:0;white-space:pre-wrap;word-break:break-all}
</style></head><body><div class="wrap">
<h1>双机接力 · 本地控制台</h1>
<div class="sub">本页只监听 127.0.0.1，关掉浏览器不影响 bot。接管前请确认服务端在线。</div>
<div class="card"><div class="kv" id="state"><div class="k">状态</div><div class="v">加载中…</div></div></div>
<div class="card">
  <button id="btn-take">接管到本地</button>
  <button id="btn-give">交还服务器</button>
  <div class="sub" style="margin:0 0 8px">连通性测试（可改成内网地址再试）：</div>
  <input id="chk-host" placeholder="服务端地址" style="background:#0b0d12;border:1px solid #2c3342;color:#e6e8ee;border-radius:8px;padding:8px 10px;margin:0 6px 8px 0;width:220px">
  <input id="chk-port" placeholder="端口" style="background:#0b0d12;border:1px solid #2c3342;color:#e6e8ee;border-radius:8px;padding:8px 10px;margin:0 6px 8px 0;width:90px">
  <button id="btn-check">测试服务端连通性</button>
  <button id="btn-refresh">刷新状态</button>
  <div class="sub" id="hint" style="margin:10px 0 0"></div>
</div>
<div class="card"><div class="sub" style="margin:0 0 8px">运行日志</div><pre id="log">就绪。</pre></div>
</div>
<script>
var $=function(id){return document.getElementById(id)};
var busy=false;
function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]})}
var roleIsClient=true;
function render(s){
  roleIsClient=(s&&s.role==="client");
  ["btn-take","btn-give"].forEach(function(id){var b=$(id);if(b)b.disabled=!roleIsClient});
  if(!roleIsClient){$("hint").textContent="本机是服务端（server）：这里只看状态，交接由本地端发起。"}
  var st=(s&&s.state)||{};
  var last=st.lastAt?(new Date(st.lastAt).toLocaleString()+" "+(st.lastDir||"")):"无";
  var rows=[["角色",s.role||"-"],["状态",st.status||"-"],["上次同步",last],["最近错误",st.lastError||"-"]];
  if(st.pending&&st.pending!=="none")rows.push(["待办",st.pending]);
  if(s.peer&&s.peer.host&&!$("chk-host").value){$("chk-host").value=s.peer.host}
  if(s.peer&&s.peer.port&&!$("chk-port").value){$("chk-port").value=s.peer.port}
  var kh=st.keys||{};
  if(kh.secret)rows.push(["共享密钥",kh.secret.ok?"✅ 已配置":"❌ "+kh.secret.detail]);
  if(kh.publicKey)rows.push(["RSA 公钥",kh.publicKey.ok?"✅ 可用":"❌ "+kh.publicKey.detail]);
  if(kh.privateKey)rows.push(["RSA 私钥",kh.privateKey.ok?"✅ 可用":"❌ "+kh.privateKey.detail]);
  $("state").innerHTML=rows.map(function(r){return '<div class="k">'+esc(r[0])+'</div><div class="v">'+esc(r[1])+'</div>'}).join("");
}
async function refresh(){
  try{var r=await fetch("/local/status",{cache:"no-store"});render(await r.json())}
  catch(e){$("log").textContent="读取状态失败："+e.message}
}
function log(t){var p=$("log");p.textContent+="\\n"+t;p.scrollTop=p.scrollHeight}
function lock(v){busy=v;["btn-take","btn-give"].forEach(function(id){$(id).disabled=v||!roleIsClient});$("hint").textContent=!roleIsClient?"本机是服务端：这里只看状态，交接由本地端发起。":(v?"进行中，请勿关闭页面…":"")}
async function act(path,name){
  if(busy)return;
  var tip=path==="/local/takeover"?"\\n服务端会先下线并同步数据过来，期间 bot 不回复。":"\\n本地会先暂停并停 QQ，把数据回传后服务端自动上线。";
  if(!confirm("确定要"+name+"吗？"+tip))return;
  lock(true);log("["+new Date().toLocaleTimeString()+"] "+name+" 开始…");
  var t0=Date.now();
  var timer=setInterval(function(){$("hint").textContent="进行中，已用 "+Math.round((Date.now()-t0)/1000)+" 秒…"},500);
  try{
    var r=await fetch(path,{method:"POST"});
    var j=await r.json();
    log(JSON.stringify(j,null,2));
    if(j&&j.needsRestart)log("数据已落盘，但没能自动重启：请手动重启一次 QQ Agent。");
  }catch(e){log("失败："+e.message)}
  finally{clearInterval(timer);lock(false);refresh()}
}
$("btn-take").onclick=function(){act("/local/takeover","接管到本地")};
$("btn-give").onclick=function(){act("/local/return","交还服务器")};
$("btn-check").onclick=async function(){
  log("正在测试到服务端的 TCP 连通性…");
  var h=$("chk-host").value.trim();var p=$("chk-port").value.trim();
  var qs="?"+new URLSearchParams({host:h,port:p}).toString();
  try{var r=await fetch("/local/check"+qs,{cache:"no-store"});var j=await r.json();log(JSON.stringify(j,null,2));
    if(j&&j.ok){log("✅ 端口通，可以点「接管到本地」")}
    else if(j&&j.hint){log("❌ "+j.hint)}
  }catch(e){log("测试失败："+e.message)}
};
$("btn-refresh").onclick=refresh;
refresh();
setInterval(refresh,5000);
</script></body></html>`;
}
