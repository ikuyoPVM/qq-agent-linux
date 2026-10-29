// 测试用 runner：按环境变量加载 handoff 插件（不启动 Electron，不使用真实项目目录）
import fs from 'node:fs';

const settingsFile = process.env.HANDOFF_TEST_SETTINGS;
if (!settingsFile) throw new Error('缺少 HANDOFF_TEST_SETTINGS');
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

const mod = await import('file:///E:/qq-agent/plugins/handoff/index.js');

const api = {
  config: () => settings,
  registerTool: () => {},
  log: (...a) => console.log('[plugin]', ...a),
  warn: (...a) => console.error('[plugin:warn]', ...a)
};
mod.setup(api);
if (typeof mod.activate === 'function') await mod.activate();
console.log('RUNNER_READY');
setInterval(() => {}, 1000);
