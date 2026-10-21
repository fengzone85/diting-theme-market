// ============================================================
// catalog 读写与条目插入（按 short 大小写不敏感升序维护，禁止重复）。
// ============================================================
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * short 排序比较器：大小写不敏感、按 UTF-16 码位比较。
 * 写目录与校验目录必须共用同一个比较器，否则脚本写出的顺序会被 CI 判为非法。
 */
export const compareShort = (a, b) => {
  const x = String(a == null ? '' : a).toLowerCase();
  const y = String(b == null ? '' : b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

export function loadCatalog(repoRoot) {
  const catalog = JSON.parse(readFileSync(join(repoRoot, 'v1.json'), 'utf8'));
  if (!catalog || !Array.isArray(catalog.themes)) {
    throw new Error('v1.json 形态非法：顶层必须是含 themes 数组的对象');
  }
  return catalog;
}

/** 写回目录并立刻跑与 CI 相同的校验（失败即抛错，不产出非法 v1.json）。 */
export function writeCatalog(repoRoot, catalog) {
  const file = join(repoRoot, 'v1.json');
  writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n');
  execFileSync('node', [join(repoRoot, 'scripts', 'check-catalog.mjs')], {
    cwd: repoRoot, stdio: 'inherit',
  });
  return file;
}

/**
 * 插入或替换条目（同 short 大小写不敏感视为覆盖），并整体重排。
 * 返回 { replaced }。
 */
export function upsertTheme(catalog, entry) {
  const key = String(entry.short).toLowerCase();
  const idx = catalog.themes.findIndex((t) => String(t.short).toLowerCase() === key);
  let replaced = false;
  if (idx >= 0) { catalog.themes[idx] = entry; replaced = true; }
  else catalog.themes.push(entry);
  catalog.themes.sort((a, b) => compareShort(a.short, b.short));
  catalog.updated_at = new Date().toISOString();
  return { replaced };
}

/**
 * Issue Form 正文解析："### 标题\n\n值" 段落 → { label: value }。
 * 用段落切分而非正则 lookahead（JS 没有 \Z，最后一个字段会被吞掉）。
 */
export function parseIssueForm(body) {
  const map = {};
  const sections = String(body || '').split(/^###\s+/m).slice(1);
  for (const section of sections) {
    const nl = section.indexOf('\n');
    if (nl < 0) continue;
    const label = section.slice(0, nl).trim();
    if (!label) continue;
    let value = section.slice(nl + 1).trim();

    // GitHub Issue Form 对未填写的可选字段会写占位符
    if (/^_No response_$/i.test(value) || value === '') {
      map[label] = '';
      continue;
    }
    // checkbox 组：任一勾选即视为 true
    if (/^- \[[xX ]\]/m.test(value)) {
      value = /- \[[xX]\]/.test(value) ? 'true' : '';
    }
    map[label] = value;
  }
  return map;
}

/** 语义化比较（用于判断是否需要更新 version/download/sha）。 */
export function needsUpdate(entry, { version, download, sha256 }) {
  return entry.version !== version || entry.download !== download || entry.sha256 !== sha256;
}
