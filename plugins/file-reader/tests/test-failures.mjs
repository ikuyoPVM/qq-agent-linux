// 失败路径自测：确认给模型的提示是人话，而不是空洞的 null
import http from 'node:http';

process.env.QQ_AGENT_DATA_DIR = '/tmp/fr-data2';
const mod = await import('../index.js');
mod.setup({ config: () => ({ enabled: true, maxMB: 1, inlineChars: 40, maxChars: 20000, timeoutMs: 3000, maxPerHour: 2 }), log: () => {}, registerTool: () => '' });
const read = mod.providers['media.file-read'];

const server = http.createServer((_req, res) => { res.writeHead(404); res.end('nope'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const onebot = { call: async (action, p) => ({ url: `http://127.0.0.1:${port}/${p.file_id}.bin` }) };

console.log('1 体积超限 :', await read({ data: { name: 'big.pdf', file_id: 'big', file_size: 5 * 1024 * 1024 }, onebot, chat: { kind: 'group', id: '1' } }));
console.log('2 没有 file_id :', await read({ data: { name: 'x.pdf' }, onebot, chat: { kind: 'group', id: '1' } }));
console.log('3 下载 404 :', await read({ data: { name: 'missing.pdf', file_id: 'missing' }, onebot, chat: { kind: 'group', id: '1' } }));
console.log('4 频率上限（第 1 次读失败也计数）:', await read({ data: { name: 'again.pdf', file_id: 'again' }, onebot, chat: { kind: 'group', id: '1' } }));
console.log('5 超过 maxPerHour=2 :', await read({ data: { name: 'again2.pdf', file_id: 'again2' }, onebot, chat: { kind: 'group', id: '1' } }));
console.log('6 关掉开关 :', await read({ data: { name: 'a.pdf', file_id: 'a' }, onebot, chat: { kind: 'group', id: '1' } }));
console.log('7 没有 onebot :', await read({ data: { name: 'a.pdf', file_id: 'a' }, onebot: null, chat: { kind: 'group', id: '1' } }));

server.close();