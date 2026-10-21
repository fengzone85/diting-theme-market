#!/usr/bin/env node
// ============================================================
// 校验 v1.json 目录，规则与 diting server 端 parseCatalog 严格对齐：
// server 端会静默跳过非法条目（theme-market.js parseCatalog），
// 因此凡是会被跳过的条目必须在这里报错拦截，避免"上架了但用户看不到"。
//
// 用法：node scripts/check-catalog.mjs [catalog.json]（默认 v1.json）
// 退出码：0 通过；1 存在问题（逐条打印）。
// ============================================================
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareShort } from './lib/catalog-edit.mjs'; // 与写目录共用同一比较器

const SHORT_RE = /^[A-Za-z0-9_-]+$/; // 与 diting server/src/theme.js SHORT_RE 一致
const RESERVED_SHORTS = new Set(['default']); // isValidShort 拒绝 default
const SHA_RE = /^[0-9a-f]{64}$/;

const arg = process.argv[2] || 'v1.json';
const catalogPath = resolve(process.cwd(), arg); // 相对路径按 cwd 解析

const errors = [];
const fail = (msg) => errors.push(msg);

// ---- i18n 文本：字符串 或 对象（值全为字符串，至少一个非空）----
// 与 diting theme.localized 的取值面一致（zh_CN > zh > en > en_US > 首个非空）。
function isLocalizedText(v, field, idx) {
  if (typeof v === 'string') {
    if (!v.trim()) fail(`themes[${idx}].${field}: 空字符串`);
    return;
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const vals = Object.values(v);
    if (vals.some((x) => typeof x !== 'string')) {
      fail(`themes[${idx}].${field}: i18n 对象的值必须全为字符串`);
      return;
    }
    if (!vals.some((x) => x.trim())) fail(`themes[${idx}].${field}: i18n 对象至少需要一个非空值`);
    return;
  }
  fail(`themes[${idx}].${field}: 必须是字符串或多语言对象`);
}

function isAbsoluteHttpUrl(v, field, idx) {
  if (typeof v !== 'string' || !v.trim()) {
    fail(`themes[${idx}].${field}: 必须是非空字符串 URL`);
    return;
  }
  let parsed;
  try { parsed = new URL(v); } catch { parsed = null; }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname) {
    fail(`themes[${idx}].${field}: 必须是绝对 HTTP(S) URL（实际: ${JSON.stringify(v)}）`);
  }
}

// ---- 主流程 ----
let json;
try {
  json = JSON.parse(readFileSync(catalogPath, 'utf8'));
} catch (e) {
  console.error(`✗ ${catalogPath}: JSON 解析失败: ${e.message}`);
  process.exit(1);
}

if (!json || typeof json !== 'object' || Array.isArray(json)) {
  fail('顶层必须是对象（生产目录固定为 {schema, updated_at, themes} 形态）');
} else {
  if (json.schema !== 1) fail(`schema 必须为 1（实际: ${JSON.stringify(json.schema)}）`);
  if (typeof json.updated_at !== 'string' || Number.isNaN(Date.parse(json.updated_at))) {
    fail('updated_at 必须是 ISO 8601 时间字符串');
  }
  if (!Array.isArray(json.themes)) fail('themes 必须是数组');
}

const themes = Array.isArray(json && json.themes) ? json.themes : [];
themes.forEach((t, idx) => {
  if (!t || typeof t !== 'object' || Array.isArray(t)) {
    fail(`themes[${idx}]: 必须是对象`);
    return;
  }
  const label = (s) => `themes[${idx}](${typeof t.short === 'string' ? t.short : '?'})${s ? '.' + s : ''}`;

  // short：server 端不合法会静默跳过，这里必须拦截
  const short = typeof t.short === 'string' ? t.short : '';
  if (!short) fail(`${label()}: 缺少 short`);
  else {
    if (!SHORT_RE.test(short)) fail(`${label()}: short 只允许字母/数字/下划线/连字符`);
    if (RESERVED_SHORTS.has(short)) fail(`${label()}: short 不能为保留字 default`);
  }

  // name 必填；description/author 可省略（省略时不校验）
  if (t.name === undefined) fail(`${label()}: 缺少 name`);
  else isLocalizedText(t.name, 'name', idx);
  if (t.description !== undefined && t.description !== '') isLocalizedText(t.description, 'description', idx);
  if (t.author !== undefined && t.author !== '') {
    if (t.author && typeof t.author === 'object' && !Array.isArray(t.author) && typeof t.author.name !== 'undefined') {
      isLocalizedText(t.author.name, 'author.name', idx); // diting: localized(author.name)
    } else {
      isLocalizedText(t.author, 'author', idx);
    }
  }

  if (t.version !== undefined && typeof t.version !== 'string') {
    fail(`${label('version')}: 必须是字符串`);
  }
  for (const field of ['url', 'preview', 'download']) {
    if (t[field] !== undefined && t[field] !== '') isAbsoluteHttpUrl(t[field], field, idx);
  }

  // download 与 sha256 成对；sha256 64 位 hex（允许 sha256: 前缀，与 server normalizeSha 一致）
  const hasDownload = typeof t.download === 'string' && t.download.trim() !== '';
  const hasSha = typeof t.sha256 === 'string' && t.sha256.trim() !== '';
  if (hasDownload !== hasSha) fail(`${label()}: download 与 sha256 必须成对提供（或成对省略）`);
  if (hasSha) {
    const sha = t.sha256.trim().toLowerCase().replace(/^sha256:/, '');
    if (!SHA_RE.test(sha)) fail(`${label('sha256')}: 必须是 64 位十六进制摘要（可带 sha256: 前缀）`);
  }

  // installable 显式 false 时允许缺 download/sha（仅展示条目）
  if (t.installable !== undefined && typeof t.installable !== 'boolean') {
    fail(`${label('installable')}: 必须是布尔值`);
  }
});

// 排序与重复：short 大小写不敏感升序、禁止重复（与 upsertTheme 共用 compareShort）
for (let i = 1; i < themes.length; i++) {
  const prev = themes[i - 1], cur = themes[i];
  const ps = typeof prev?.short === 'string' ? prev.short : '';
  const cs = typeof cur?.short === 'string' ? cur.short : '';
  if (!ps || !cs) continue;
  const cmp = compareShort(ps, cs);
  if (cmp === 0) fail(`themes[${i}]: short 重复（大小写不敏感）: ${cur.short}`);
  else if (cmp > 0) fail(`themes[${i}]: 未按 short 大小写不敏感升序排列（${prev.short} 应排在 ${cur.short} 之后）`);
}

if (errors.length) {
  console.error(`✗ 校验失败，共 ${errors.length} 处：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`✓ ${catalogPath} 校验通过（${themes.length} 个主题条目）`);
