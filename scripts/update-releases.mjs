#!/usr/bin/env node
// ============================================================
// 每 6 小时跟踪 GitHub 托管主题的最新 Release，自动刷新 catalog。
// 仅处理项目主页/下载地址指向 GitHub Release 的条目：
//   1. 通过项目主页 url 提取 owner/repo，取最新 Release；
//   2. 用「最新 tag + 现有 asset 文件名」构造下载地址，API asset 作后备；
//   3. 下载包须通过根 manifest 的 short 校验与 SHA-256 重算；
//   4. version/download/sha256 任一变化才更新；全部收集完再写盘。
// ============================================================
import { fetchAndVerifyPackage } from './lib/theme-package.mjs';
import { loadCatalog, upsertTheme, needsUpdate, writeCatalog } from './lib/catalog-edit.mjs';
import { commitAndOpenPR } from './lib/pr.mjs';

const REPO_ROOT = process.cwd();
const token = process.env.GITHUB_TOKEN;
const MAX_PKG_BYTES = 512 << 20;
const REPO_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/?$/i;

function githubRepoOf(entry) {
  // 仅跟踪 GitHub 托管条目：项目主页优先，download 兜底
  for (const v of [entry.url, entry.download]) {
    const m = typeof v === 'string' && v.match(REPO_RE);
    if (m) return { owner: m[1], repo: m[2] };
  }
  return null;
}

async function latestRelease(owner, repo) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return null; // 无 release：跳过
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const catalog = loadCatalog(REPO_ROOT);
  // 先收集，遍历结束后再落盘：upsertTheme 会重排数组，边遍历边改会漏项/重复处理
  const updates = [];
  const changed = [];

  for (const entry of catalog.themes) {
    const gh = githubRepoOf(entry);
    if (!gh || !entry.download || !entry.sha256) continue;
    try {
      const release = await latestRelease(gh.owner, gh.repo);
      if (!release) continue;
      const tag = release.tag_name;

      // 候选 1：最新 tag + 现有 asset 文件名；候选 2：API 最新 .zip asset
      const currentAsset = entry.download.split('/').pop();
      let download = `https://github.com/${gh.owner}/${gh.repo}/releases/download/${tag}/${currentAsset}`;
      const head = await fetch(download, { method: 'HEAD', redirect: 'follow' });
      if (!head.ok) {
        const asset = (release.assets || []).find((a) => /\.zip$/i.test(a.name));
        if (!asset) { console.warn(`  跳过 ${entry.short}: Release ${tag} 无 .zip 资源`); continue; }
        download = asset.browser_download_url;
      }

      // 仍是现有包（同 URL）→ 无需重算
      if (download === entry.download && entry.version) continue;

      const { manifest, sha256 } = await fetchAndVerifyPackage(download, {
        expectShort: entry.short, maxBytes: MAX_PKG_BYTES, token,
      });
      const version = typeof manifest.version === 'string' && manifest.version
        ? manifest.version
        : String(tag || '').replace(/^v/, '');
      if (!needsUpdate(entry, { version, download, sha256 })) continue;

      updates.push({ ...entry, version, download, sha256 });
      changed.push({ short: entry.short, version, tag });
      console.log(`→ ${entry.short}: ${entry.version || '-'} → ${version} (${tag})`);
    } catch (e) {
      // 单个条目失败不阻塞其它条目
      console.warn(`  跳过 ${entry.short}: ${e.message}`);
    }
  }

  if (!changed.length) {
    console.log('✓ 所有 GitHub 托管主题均已是最新，无需更新');
    return;
  }
  for (const entry of updates) upsertTheme(catalog, entry);
  writeCatalog(REPO_ROOT, catalog); // 内含 check-catalog

  const branch = `catalog/release-update-${new Date().toISOString().slice(0, 10)}`;
  const { changed: committed, prNumber } = commitAndOpenPR({
    branch,
    commitMessage: `catalog: release 自动更新 (${changed.map((c) => c.short).join(', ')})`,
    title: `catalog: Release 自动更新（${changed.length} 个主题）`,
    body: changed.map((c) => `- **${c.short}** → v${c.version}（${c.tag}）`).join('\n'),
  });
  if (!committed) console.log('✓ 目录内容无实际变化，跳过 PR');
  else console.log(`✓ 已${prNumber ? '更新' : '创建'} PR，更新 ${changed.length} 个主题`);
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
