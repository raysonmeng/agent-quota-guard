#!/usr/bin/env node
// token-budget-guard — 统一安装 CLI(npx 入口)。
//
//   token-budget-guard claude  [--uninstall] [--project] [--skip-doctor]
//   token-budget-guard codex   [--uninstall]
//   token-budget-guard --help
//   token-budget-guard --version
//
// 薄分发器:`claude` 调 Node 安装器(bin/install-claude.mjs);`codex` 调随包
// 携带的 bash 安装器(codex-budget-guard/install.sh)。真正的逻辑都在那两个里
// (均已过交叉审),本文件只做参数分发 + 退出码透传,不重复实现安装语义。

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `token-budget-guard —— Claude Code / Codex 额度守卫安装器

用法:
  token-budget-guard claude  [选项]    安装到 Claude Code(~/.claude)
  token-budget-guard codex   [选项]    安装到 Codex(~/.codex)
  token-budget-guard --help            显示本帮助
  token-budget-guard --version         显示版本

通用选项(透传给底层安装器):
  --uninstall        只移除本工具装入的内容(保留 ~/.budget-guard/ 脚本)

claude 专属选项:
  --project          把协议写进 ./CLAUDE.md(项目级),而非 ~/.claude/CLAUDE.md
  --skip-doctor      跳过装后 probe doctor 自检

前置依赖:jq(运行期)、python3(Codex 安装期做 JSON 安全合并)、
         node>=18;Codex 的 MCP server 装时会自动 npm install SDK。

示例:
  npx token-budget-guard claude
  npx token-budget-guard codex
  npx token-budget-guard claude --uninstall
`;

function out(s) { process.stdout.write(s.endsWith('\n') ? s : s + '\n'); }
function err(s) { process.stderr.write(s.endsWith('\n') ? s : s + '\n'); }

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const argv = process.argv.slice(2);
const target = argv[0];
const rest = argv.slice(1);

if (!target || target === '--help' || target === '-h' || target === 'help') {
  out(USAGE);
  process.exit(target ? 0 : 1);
}

if (target === '--version' || target === '-v') {
  out(readVersion());
  process.exit(0);
}

if (target === 'claude') {
  const shim = join(ROOT, 'bin', 'install-claude.mjs');
  if (!existsSync(shim)) {
    err(`✗ 包内缺少 Claude 安装器:${shim}`);
    process.exit(2);
  }
  const r = spawnSync(process.execPath, [shim, ...rest], { stdio: 'inherit' });
  if (r.error) {
    err(`✗ 启动 Claude 安装器失败:${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

if (target === 'codex') {
  const installer = join(ROOT, 'codex-budget-guard', 'install.sh');
  if (!existsSync(installer)) {
    err(`✗ 包内缺少 Codex 安装器:${installer}`);
    process.exit(2);
  }
  const r = spawnSync('bash', [installer, ...rest], { stdio: 'inherit' });
  if (r.error) {
    if (r.error.code === 'ENOENT') {
      err('✗ 未找到 bash —— Codex 安装器需要 bash。');
    } else {
      err(`✗ 启动 Codex 安装器失败:${r.error.message}`);
    }
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

err(`✗ 未知目标:${target}\n`);
err(USAGE);
process.exit(2);
