// ============================================================
// 主题包处理共享库：下载（大小封顶）、SHA-256、从 ZIP 读取根 manifest。
// 供 add-theme-from-issue.mjs 与 update-releases.mjs 复用。
// 运行环境为 GitHub Actions ubuntu runner（自带 unzip，无需三方依赖）。
// ============================================================
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

/** 流式下载到临时文件，超出 maxBytes 即中止。返回 { buffer, path, dir }。 */
export async function downloadToTemp(url, maxBytes, token) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: token ? { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' } : {},
  });
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`文件超过 ${maxBytes} 字节上限: ${url}`);

  const dir = await mkdtemp(join(tmpdir(), 'diting-theme-'));
  const filePath = join(dir, 'theme.zip');
  const out = createWriteStream(filePath);
  const reader = res.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`文件超过 ${maxBytes} 字节上限: ${url}`);
      }
      if (!out.write(Buffer.from(value))) {
        await new Promise((r) => out.once('drain', r));
      }
    }
    await new Promise((r, j) => { out.end(r); out.on('error', j); });
    return { buffer: await readFile(filePath), path: filePath, dir };
  } catch (e) {
    // 失败时清理临时目录，避免 runner 上残留
    out.destroy();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 从主题 ZIP 根目录读取 manifest（diting-theme.json > komari-theme.json > manifest.json，
 * 与 diting server readManifest 的三级链一致）。返回解析后的对象。
 */
export async function readManifestFromZip(zipPath) {
  for (const name of ['diting-theme.json', 'komari-theme.json', 'manifest.json']) {
    try {
      const { stdout } = await pExecFile('unzip', ['-p', zipPath, name], { maxBuffer: 2 << 20 });
      const manifest = JSON.parse(stdout);
      if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) return manifest;
    } catch { /* 尝试下一级 */ }
  }
  throw new Error('主题包根目录缺少 diting-theme.json / komari-theme.json / manifest.json');
}

/** 下载 ZIP 并校验根 manifest 的 short；返回 { manifest, sha256 }。 */
export async function fetchAndVerifyPackage(url, { expectShort, maxBytes, token }) {
  const { buffer, path, dir } = await downloadToTemp(url, maxBytes, token);
  try {
    const manifest = await readManifestFromZip(path);
    if (expectShort && String(manifest.short || manifest.id || '') !== expectShort) {
      throw new Error(`manifest.short (${manifest.short || manifest.id}) 与期望 (${expectShort}) 不一致`);
    }
    return { manifest, sha256: sha256Hex(buffer) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
