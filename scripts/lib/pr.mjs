// ============================================================
// 把 v1.json 的改动发布为 PR。
// 统一处理：无变更不提交、同分支已有 PR 时改为更新而非重复创建。
// ============================================================
import { execFileSync } from 'node:child_process';

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/**
 * 提交 v1.json 并创建/更新 PR。
 * 返回 { changed, prNumber }；无改动时 changed=false 且不推送。
 */
export function commitAndOpenPR({ branch, commitMessage, title, body }) {
  run('git', ['config', 'user.name', 'diting-theme-market-bot']);
  run('git', ['config', 'user.email', 'bot@users.noreply.github.com']);
  run('git', ['checkout', '-B', branch]);
  run('git', ['add', 'v1.json']);

  let hasChanges = true;
  try {
    // 退出码 0 表示暂存区与 HEAD 无差异
    run('git', ['diff', '--cached', '--quiet']);
    hasChanges = false;
  } catch { /* 有差异 */ }
  if (!hasChanges) return { changed: false, prNumber: null };

  run('git', ['commit', '-m', commitMessage]);
  run('git', ['push', '-f', 'origin', branch]);

  const existing = JSON.parse(capture('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--limit', '1']));
  if (existing.length) {
    run('gh', ['pr', 'edit', String(existing[0].number), '--title', title, '--body', body]);
    return { changed: true, prNumber: existing[0].number };
  }
  run('gh', ['pr', 'create', '--title', title, '--body', body]);
  return { changed: true, prNumber: null };
}
