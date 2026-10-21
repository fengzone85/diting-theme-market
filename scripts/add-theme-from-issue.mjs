#!/usr/bin/env node
// ============================================================
// 从收录 Issue 生成 catalog 条目并创建 PR。
// 触发：issues.opened（Issue Form 模板，见 .github/ISSUE_TEMPLATE/）。
//
// GitHub 托管主题：只填仓库地址 + 预览图；元数据从最新 Release 的 ZIP
// 根 manifest 读取（short/version），包经 SHA-256 校验后入库。
// 非 GitHub 托管主题：表单提供全字段，包经 manifest.short/version 与
// SHA-256 校验后入库。
// ============================================================
import { fetchAndVerifyPackage } from './lib/theme-package.mjs';
import { loadCatalog, upsertTheme, parseIssueForm, writeCatalog } from './lib/catalog-edit.mjs';
import { commitAndOpenPR } from './lib/pr.mjs';

const REPO_ROOT = process.cwd();
const token = process.env.GITHUB_TOKEN;
const MAX_PKG_BYTES = 512 << 20; // 与 diting server 解压总上限对齐
const REPO_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/?$/i;

// 抛出而非 process.exit，确保外层 catch 能把失败原因回评到 Issue
function fail(msg) { throw new Error(msg); }

async function main() {
  const event = JSON.parse(process.env.EVENT_PAYLOAD || '{}');
  const issue = event.issue;
  if (!issue) fail('事件中缺少 issue');
  const form = parseIssueForm(issue.body);
  const labels = (issue.labels || []).map((l) => l.name);

  const isGithubMode = labels.includes('theme/github') ||
    Boolean(form['主题 GitHub 仓库地址'] || form['Theme GitHub repository']);
  const get = (...names) => {
    for (const n of names) if (form[n]) return form[n].trim();
    return '';
  };
  // 非收录表单（无任何模板字段）→ 静默跳过，避免误评论
  if (!isGithubMode && !form['主题包下载地址'] && !form['Theme package URL']) {
    console.log('非收录表单 Issue，忽略');
    return;
  }

  let entry;
  if (isGithubMode) {
    const repoUrl = get('主题 GitHub 仓库地址', 'Theme GitHub repository');
    const preview = get('预览图 URL', 'Preview image URL');
    const m = repoUrl.match(REPO_RE);
    if (!m) fail(`仓库地址必须是 https://github.com/<owner>/<repo> 形式，实际: ${repoUrl}`);
    if (!preview) fail('缺少预览图 URL');
    const [, owner, repo] = m;

    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) fail(`获取 ${owner}/${repo} 最新 Release 失败: HTTP ${res.status}`);
    const release = await res.json();
    const asset = (release.assets || []).find((a) => /\.zip$/i.test(a.name));
    if (!asset) fail(`最新 Release (${release.tag_name}) 中没有 .zip 资源`);
    console.log(`→ ${owner}/${repo}@${release.tag_name} 资源: ${asset.name}`);

    const { manifest, sha256 } = await fetchAndVerifyPackage(asset.browser_download_url, {
      maxBytes: MAX_PKG_BYTES, token,
    });
    const short = String(manifest.short || manifest.id || '');
    if (!short) fail('包内 manifest 缺少 short 字段');
    entry = {
      name: manifest.name || short,
      short,
      description: manifest.description || '',
      // manifest.version 必须是字符串；非字符串时回退 tag，避免写入 "[object Object]"
      version: typeof manifest.version === 'string' && manifest.version
        ? manifest.version
        : String(release.tag_name || '').replace(/^v/, ''),
      author: manifest.author || owner,
      url: repoUrl,
      preview,
      download: asset.browser_download_url,
      sha256,
    };
  } else {
    // 非 GitHub 托管：全字段来自表单
    entry = {
      name: get('主题名称', 'Theme name'),
      short: get('唯一短名称 short', 'Unique short name'),
      description: get('描述', 'Description'),
      version: get('版本号', 'Version'),
      author: get('作者', 'Author'),
      url: get('项目地址', 'Project URL'),
      preview: get('预览图 URL', 'Preview image URL'),
      download: get('主题包下载地址', 'Theme package URL'),
    };
    for (const [k, v] of Object.entries(entry)) {
      if (!v && k !== 'description') fail(`表单字段「${k}」缺失`);
    }
    for (const field of ['url', 'download']) {
      if (/github\.com/i.test(entry[field])) {
        fail(`非 GitHub 托管模式的 ${field} 不得指向 github.com（GitHub 托管请走另一模板）`);
      }
    }

    const { manifest, sha256 } = await fetchAndVerifyPackage(entry.download, {
      expectShort: entry.short, maxBytes: MAX_PKG_BYTES,
    });
    entry.sha256 = sha256;
    if (typeof manifest.version === 'string' && manifest.version && manifest.version !== entry.version) {
      fail(`包内 manifest.version (${manifest.version}) 与表单版本 (${entry.version}) 不一致`);
    }
  }

  const catalog = loadCatalog(REPO_ROOT);
  // 防抢占：short 已存在但项目地址不同 → 静默覆盖会让他人主题被顶替，需人工处理
  const existing = catalog.themes.find(
    (t) => String(t.short || '').toLowerCase() === String(entry.short).toLowerCase());
  if (existing && existing.url && entry.url &&
      String(existing.url).toLowerCase() !== String(entry.url).toLowerCase()) {
    fail(`short「${entry.short}」已被 ${existing.url} 占用；请更换 short 或联系维护者`);
  }
  // 内容完全一致：不制造只改 updated_at 的空 PR
  const sameFields = ['name', 'short', 'description', 'version', 'author', 'url', 'preview', 'download', 'sha256'];
  if (existing && sameFields.every((k) => JSON.stringify(existing[k] ?? null) === JSON.stringify(entry[k] ?? null))) {
    console.log(`✓ ${entry.short} 已在目录中且内容一致，无需更新`);
    return;
  }
  const { replaced } = upsertTheme(catalog, entry);
  writeCatalog(REPO_ROOT, catalog); // 内含 check-catalog，非法即抛错

  // 分支名只保留安全字符，避免 owner/repo 里的特殊字符进入 ref
  const branch = `catalog/add-${entry.short}`.toLowerCase().replace(/[^a-z0-9-_.]/g, '-');
  const { changed, prNumber } = commitAndOpenPR({
    branch,
    commitMessage: `catalog: ${replaced ? 'update' : 'add'} ${entry.short}`,
    title: `catalog: ${replaced ? '更新' : '收录'}主题 ${entry.short}`,
    body: [
      `来自 #${issue.number}。`,
      '',
      `- short: \`${entry.short}\``,
      `- version: \`${entry.version}\``,
      `- sha256: \`${entry.sha256}\``,
      '',
      `Closes #${issue.number}`,
    ].join('\n'),
  });

  if (!changed) {
    console.log(`✓ ${entry.short} 已在目录中且内容未变化，无需创建 PR`);
    return;
  }
  console.log(`✓ 已${prNumber ? '更新' : '创建'} PR（${replaced ? '更新' : '收录'} ${entry.short}）`);
}

main().catch(async (e) => {
  console.error('✗ 收录失败:', e.message);
  try {
    const event = JSON.parse(process.env.EVENT_PAYLOAD || '{}');
    if (event.issue?.number) {
      const { execFileSync } = await import('node:child_process');
      execFileSync('gh', ['issue', 'comment', String(event.issue.number),
        '--body', `收录失败：\n\n\`\`\`\n${e.message}\n\`\`\``], { stdio: 'inherit' });
    }
  } catch { /* 评论失败不掩盖原始错误 */ }
  process.exit(1);
});
