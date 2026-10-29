// file-reader 离线自测：直接调 extract.js + 模拟能力调用（不联网、不碰生产服务）
import fs from 'node:fs';
import path from 'node:path';
import { extractText } from '../extract.js';

const DIR = '/tmp/fr-test';
const files = fs.readdirSync(DIR).filter((f) => !f.startsWith('.'));

for (const name of files) {
  const file = path.join(DIR, name);
  try {
    const r = await extractText(file, name, { maxChars: 20000 });
    const preview = String(r.text || '').replace(/\s+/g, ' ').slice(0, 90);
    console.log(`✓ ${name.padEnd(16)} kind=${r.kind.padEnd(7)} chars=${String(r.text.length).padEnd(5)} meta=${JSON.stringify(r.meta)} notes=${JSON.stringify(r.notes)}`);
    console.log(`   ${preview || '(空)'}`);
  } catch (error) {
    console.log(`✗ ${name.padEnd(16)} ${error.message}`);
  }
}