// 真实链路的端到端验证：真实群文件 id → 真实 OneBot 换链 → 真实 CDN 下载 → 抽取 → read_file
import fs from 'node:fs';

process.env.QQ_AGENT_DATA_DIR = '/tmp/fr-live';
const cfg = JSON.parse(fs.readFileSync(process.env.QQ_AGENT_CONFIG || 'data/config.json', 'utf8'));
const s = cfg.snowluma || {};
const base = s.httpUrl || 'http://127.0.0.1:3000';
const token = s.httpAccessToken || s.accessToken || '';

async function onebotCall(action, params) {
  const r = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params)
  });
  const body = await r.json();
  if (body.status !== 'ok' && body.retcode !== 0) throw new Error(`${action}: ${body.wording || body.retcode}`);
  return body.data;
}

const onebot = { call: onebotCall };
const GID = 1092669526;
const root = await onebotCall('get_group_root_files', { group_id: GID });
const files = root.files || [];

const mod = await import('../index.js');
const tools = {};
mod.setup({ config: () => ({ enabled: true, maxMB: 20, maxChars: 20000, inlineChars: 300, timeoutMs: 30000, toolChunkChars: 6000, keepFiles: 20, maxPerHour: 40 }), log: (...a) => console.log('  [skill]', ...a), registerTool: (d) => { tools[d.id] = d; return d.id; } });
const read = mod.providers['media.file-read'];

for (const f of files) {
  console.log(`\n──── ${f.file_name}（${(f.file_size / 1024).toFixed(0)} KB）`);
  const out = await read({
    data: { name: f.file_name, file_id: f.file_id, file_size: f.file_size, busid: f.busid },
    onebot,
    chat: { kind: 'group', id: String(GID) }
  });
  console.log('  返回：', typeof out === 'string' ? out.slice(0, 700) : out);
}

// read_file 分页：拿真实 pdf 的长正文验证一次
const pdf = files.find((f) => /\.pdf$/i.test(f.file_name));
if (pdf) {
  console.log('\n──── read_file 分页（' + pdf.file_name + '）');
  const p1 = await tools.read_file.execute({ file: pdf.file_name, offset: 0, limit: 400 });
  console.log(p1.content.slice(0, 900));
  const p2 = await tools.read_file.execute({ file: pdf.file_name, offset: 400, limit: 400 });
  console.log('\n' + p2.content.slice(0, 500));
}

console.log('\n缓存：', fs.existsSync('/tmp/fr-live/plugin-data/file-reader/cache') ? fs.readdirSync('/tmp/fr-live/plugin-data/file-reader/cache') : '无');