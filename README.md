# Diting Theme Market

Diting 内置主题市场使用的默认主题目录（官方源）。主题包仍由主题作者自行托管，本仓库只保存主题元数据、下载地址和 SHA-256 校验值。

生产目录为 [`v1.json`](/v1.json)，由 diting 服务端在运行时拉取：
`https://raw.githubusercontent.com/fengzone85/diting-theme-market/main/v1.json`
（server 端种子见 `diting/server/src/db.js` 的 `OFFICIAL_THEME_MARKET`，默认禁用，仓库上线后可开启。）

---

**English**: Diting Theme Market is the default catalog used by diting's built-in theme market. Theme packages remain hosted by their authors; this repository stores theme metadata, download URLs and SHA-256 checksums. The production catalog is [`v1.json`](/v1.json).

---

## 目录契约 / Catalog

每个可安装主题条目包含以下字段：

```json
{
  "name": { "zh_CN": "测试主题", "en": "Test Theme" },
  "short": "test-theme",
  "description": { "zh_CN": "一个用于 diting 的测试主题", "en": "A test theme" },
  "version": "1.0.0",
  "author": "diting",
  "url": "https://example.com/test-theme",
  "preview": "https://example.com/preview.png",
  "download": "https://example.com/test-theme-1.0.0.zip",
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

- `name` / `description` / `author`：字符串或多语言对象。多语言取值顺序与 diting 端一致：`zh_CN` → `zh` → `en` → `en_US` → 首个非空值。`author` 也可写为 `{ "name": ... }`。
- `short`：全局唯一短名称，只允许字母、数字、下划线、连字符（`/^[A-Za-z0-9_-]+$/`），**不能为 `default`**。条目必须按 `short` 大小写不敏感升序排列，不得重复。
- `download` / `sha256`：必须成对提供（或成对省略）。`download` 必须是绝对 HTTP(S) URL，指向**根目录包含 `diting-theme.json`** 的主题 ZIP（同时兼容 `komari-theme.json` 与旧版 `manifest.json`，与 diting server 的 manifest 三级链一致）；`sha256` 必须是该 ZIP 的小写 64 位十六进制摘要。diting server 安装时会重新下载并比对摘要，不符则拒绝安装（`theme_sha256_mismatch`）。
- `installable`（diting 扩展）：可选布尔值。显式 `false` 时该条目仅展示（可跳转 `url`），即使带 download/sha256 也不可一键安装。
- `url` / `preview`：可选，绝对 HTTP(S) URL。

本地校验：

```bash
node scripts/check-catalog.mjs
```

## 提交主题 / Submit a Theme

请在 [Issue 页面](../../issues/new/choose)选择对应模板。不要手动拼接字段名称，Action 会按 Issue Form 的固定字段读取内容。

### 在 GitHub 中开源的主题 / Open-source GitHub theme

只需填写 GitHub 仓库地址和预览图链接，并确认仓库公开且最新 Release 提供了包含根目录 `diting-theme.json` 的主题 ZIP。Action 会自动下载该 ZIP、读取包内 manifest（short、version 等）、计算 SHA-256 并创建收录 PR。

### 非 GitHub 托管的主题 / Theme hosted outside GitHub

需要填写项目地址、主题包下载地址、预览图、名称、short、版本、描述和作者。项目地址和主题包地址**不能是 GitHub 托管地址**（GitHub 托管请走上一模板，以便自动跟踪 Release）。

## Release 自动更新 / Release auto update

现有 Release 更新工作流**每六小时**运行一次（`update-releases.yml`）。它只处理目录中由 GitHub 仓库托管、已有 download + sha256 的主题：

1. 通过项目主页提取 `owner/repo`，读取最新 Release；
2. 用「最新 tag + 现有 asset 文件名」构造下载地址，GitHub API asset 地址作为后备；
3. 下载包通过根 manifest、`short` 与 SHA-256 校验后，才更新 `version` / `download` / `sha256`；
4. 任一字段发生变化即创建 PR，否则静默结束。

## 维护者设置 / Maintainer setup

> 当前状态：第 1–4 项已完成（仓库已上线、分支保护已开启、Actions 写权限已开启、标签已创建）；第 5 项待首个主题收录后执行。

1. 推送本仓库到 `github.com/fengzone85/diting-theme-market`，默认分支 `main`（diting 服务端官方源种子即指向该地址的 `v1.json`）。
2. **开启分支保护**：`main` 要求必须通过 PR 合并，并勾选状态检查 `Check catalog`；禁止直接 push。自动收录与自动更新都只创建 PR，须人工评审后合并。
3. **Actions 权限**：Settings → Actions → General → Workflow permissions 选择 *Read and write permissions*，否则脚本无法推送分支或创建 PR（使用内置 `GITHUB_TOKEN` 即可，无需 PAT）。
4. **创建标签**：在 Issues → Labels 中创建 `theme/github` 与 `theme/external`，与模板中的 `labels` 声明一致（缺失时脚本仍可按表单字段识别，但 PR 不便筛选）。
5. **启用官方源**：仓库上线（已完成）后，收录**首个主题**再把 `diting/server/src/db.js` 中 `OFFICIAL_THEME_MARKET.enabled` 置为 `true`，或由管理员在主题面板手动启用「Diting Official」来源；空目录提前启用只会让每次拉 catalog 多一次无结果的网络请求。

## 仓库结构 / Layout

```
v1.json                         # 生产目录（唯一数据文件）
scripts/check-catalog.mjs       # 目录校验（CI 与本地共用，排序比较器与写目录一致）
scripts/lib/theme-package.mjs   # 下载 / SHA-256 / ZIP manifest 读取
scripts/lib/catalog-edit.mjs    # 目录读写 / 排序插入 / Issue Form 解析 / 校验后写回
scripts/lib/pr.mjs              # 提交并创建或更新 PR（无变更不提交）
scripts/add-theme-from-issue.mjs  # 收录：Issue → PR
scripts/update-releases.mjs       # 更新：Release 跟踪 → PR
.github/workflows/check-catalog.yml    # push / PR 时校验
.github/workflows/submit-from-issue.yml # Issue 收录
.github/workflows/update-releases.yml   # 6h Release 跟踪
```
