// 音乐链接归档（默认 <DATA_DIR>/Music/，目录可注入）。
//
// 为什么需要：聊天存档里的音乐卡片只有文字（[音乐分享：《歌名》 歌手：xx]），
// 链接没存 —— 需要链接时（查歌词、再分享一次）无处可取。
// 这里把**双方**的音乐卡片都归档：机器人发送的（send_music 成功后）。
// 每条一个 JSON 文件，含跳转链接。
//
// 与聊天存档（核心的 ChatStore）是两套独立存储：
//   - 聊天存档回答"群里聊了什么"，滚动上限由核心的 store 配置控制；
//   - 音乐存档回答"这首歌的链接是什么"，滚动保留最近 MAX_FILES 条。
// 因此音乐存档不跟着聊天存档裁剪，也不进提示词背景。
//
// ── 数据目录怎么来的 ──
// 不 import 核心的 config.js（那会让本技能与核心内部结构耦合，核心一改动就崩）。
// 改用运行时环境变量 QQ_AGENT_DATA_DIR（由 electron/main.js 设置），
// 取不到时按目录层级推算：lib/ → music/ → skills/ → 应用根/data。
// 这与安装版既有的 data/Music/ 归档路径完全一致，历史记录能继续用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..', '..');
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(APP_ROOT, 'data');

const MAX_FILES = 1000;   // 滚动保留最近 N 条，超出删最旧（文件名按时间排序）

// 同毫秒写入的记录文件名时间戳相同，排序会退化为按随机后缀 —— 连发两首歌
// 顺序会颠倒。用进程内单调递增序号保证文件名字典序 = 写入顺序。
let writeSeq = 0;

export class MusicStore {
  /** @param {{dir?: string}} options dir = 归档目录，默认 <DATA_DIR>/Music */
  constructor({ dir } = {}) {
    this.dir = path.resolve(dir || path.join(DATA_DIR, 'Music'));
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* 建不了就在首次 record 时再试 */ }
  }

  /**
   * 归档一条音乐记录（机器人发送成功后调用）。
   * song: { name, singer, platform, jumpUrl, audioUrl? }
   * @returns 归档的条目（name 为空时不归档，返回 null）
   */
  record(chatKey, song, { mid = null } = {}) {
    const name = String(song?.name ?? '').trim();
    if (!name) return null;
    const entry = {
      chatKey: String(chatKey || ''),
      mid: mid ?? null,
      name,
      singer: String(song?.singer ?? '').trim(),
      platform: String(song?.platform ?? '').trim(),
      jumpUrl: String(song?.jumpUrl ?? '').trim(),
      audioUrl: String(song?.audioUrl ?? '').trim(),
      ts: Date.now()
    };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `${Date.now().toString(36)}-${String(writeSeq = (writeSeq + 1) % 1e6).padStart(4, '0')}-${Math.random().toString(36).slice(2, 6)}.json`);
      fs.writeFileSync(file, JSON.stringify(entry, null, 1), 'utf8');
      this.#prune();
      return entry;
    } catch (error) {
      console.warn('[music-store] 归档失败（不影响发送/聊天）:', error?.message ?? error);
      return null;
    }
  }

  /**
   * 查询最近的音乐记录（时间倒序）。
   * chatKey 非空只看该会话；query 按歌名/歌手模糊过滤（不区分大小写）。
   */
  recent({ chatKey = '', query = '', limit = 10 } = {}) {
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort().reverse();
    } catch { return []; }   // 目录还没有 = 没归档过
    const q = String(query ?? '').trim().toLowerCase();
    const n = Math.max(1, Math.min(50, Number(limit) || 10));
    const out = [];
    for (const f of files) {
      if (out.length >= n) break;
      let e;
      try { e = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); } catch { continue; }
      if (chatKey && e.chatKey !== chatKey) continue;
      if (q && !`${e.name ?? ''} ${e.singer ?? ''}`.toLowerCase().includes(q)) continue;
      out.push(e);
    }
    return out;
  }

  /** 滚动淘汰：只保留最近 MAX_FILES 个文件。 */
  #prune() {
    try {
      const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort();
      if (files.length > MAX_FILES) {
        for (const f of files.slice(0, files.length - MAX_FILES)) {
          try { fs.unlinkSync(path.join(this.dir, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
}
