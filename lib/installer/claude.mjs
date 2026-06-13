// Claude Code installer for budget-guard.
//
// Pure ESM, zero external deps, Node >=18. Self-deploys the installer payload
// (lib/probe, lib/guard when present, bin/probe.mjs, bin/guard.mjs when present,
// and the installer itself) into $HOME/.budget-guard/, then merges hook entries
// into ~/.claude/settings.json and writes the protocol block (passive monitor
// protocol + ACTIVE USAGE instructions) into ~/.claude/CLAUDE.md.
//
// Invariants:
//   - 100% idempotent: re-running install is a no-op for existing state.
//   - 100% reversible: --uninstall removes only what this installer added.
//   - backup-before-mutate: settings.json + CLAUDE.md get a `.bak.<ts>` copy
//     before any in-place change.
//   - fail-loud on hard errors (settings.json unparseable, permission denied):
//     stderr message + process.exit(1). soft warnings (missing optional files)
//     go to stdout and do not change the exit code.
//
// The public surface is `install({srcRoot, binDir, ...})` and
// `uninstall({binDir, ...})`; the CLI shim in bin/install-claude.mjs wires argv
// to those functions and exits with the right code.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, copyFileSync, readdirSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// ─── constants ────────────────────────────────────────────────────────────

export const AGENT = 'claude';
export const BUDGET_DIR_NAME = '.budget-guard';
export const CLAUDE_DIR_NAME = '.claude';
export const SETTINGS_FILE = 'settings.json';
export const MEMORY_FILE = 'CLAUDE.md';
export const MARK_START = '<!-- budget-guard:start -->';
export const MARK_END = '<!-- budget-guard:end -->';

const HOOK_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit';
const HOOK_TIMEOUT = 30;          // seconds (matches new spec; old was 15)
const HOOK_MARKER = 'guard.mjs';         // Node installer writes this
const HOOK_MARKER_BASH = 'budget_guard.sh'; // bash install.sh writes this — filter on upgrade

const PROTOCOL_VERSION = '1';

// Files under <srcRoot>/bin and <srcRoot>/lib to deploy. We tolerate missing
// optional files (lib/guard/*, bin/guard.mjs) with a soft warning, since the
// hook implementation is being landed in parallel by another task.
const REQUIRED_LIB_DIRS = ['probe', 'installer'];   // must exist
const OPTIONAL_LIB_DIRS = ['guard'];               // warning if missing
const REQUIRED_BIN_FILES = ['probe.mjs'];          // must exist
const OPTIONAL_BIN_FILES = ['guard.mjs'];          // warning if missing
const REQUIRED_BASH_RUNTIME_FILES = ['budget-probe', 'budget_guard.sh', 'watchdog.sh', 'budget-config.sh'];

// ─── small utilities ──────────────────────────────────────────────────────

function log(msg)  { process.stdout.write(msg + '\n'); }
function warn(msg) { process.stdout.write(`⚠  ${msg}\n`); }
function info(msg) { process.stdout.write('  ' + msg + '\n'); }
function err(msg)  { process.stderr.write(`✗  ${msg}\n`); }

function ts() { return Math.floor(Date.now() / 1000); }

function atomicWriteText(target, text) {
  const tmp = `${target}.tmp.${process.pid}.${ts()}`;
  writeFileSync(tmp, text);
  renameSync(tmp, target);
}

function atomicWriteJSON(target, obj) {
  atomicWriteText(target, JSON.stringify(obj, null, 2) + '\n');
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
}

function isFile(p) { try { return statSync(p).isFile(); } catch (_) { return false; } }
function isDir(p)  { try { return statSync(p).isDirectory(); } catch (_) { return false; } }

function safeBackup(target) {
  if (!existsSync(target)) return null;
  const bak = `${target}.bak.${ts()}`;
  copyFileSync(target, bak);
  return bak;
}

function readJSON(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  if (text.trim() === '') return null;
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`not_valid_json: ${path} (${e.message})`); }
}

function shellDoubleQuote(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
}

// ─── 1. self-deploy scripts ──────────────────────────────────────────────

/**
 * Copy source files into the install target. Writes are atomic (tmp + rename)
 * so a crash mid-deploy never leaves a half-written file at the destination.
 *
 * We re-read the source file from disk on every copy so that self-deploy
 * (copying lib/installer/* to dest/lib/installer/*) does not get a zero-byte
 * version of the running file. (We never copy onto the running file path
 * either, but belt-and-braces.)
 */
function deployTree(srcDir, destDir, { required, optional = [], only = null, kindLabel = srcDir } = {}) {
  const result = { copied: [], missing: [] };
  if (!isDir(srcDir)) {
    if (required) throw new Error(`missing_source_dir: ${srcDir}`);
    warn(`source ${kindLabel} 目录不存在: ${srcDir}`);
    return result;
  }
  const allFiles = readdirSync(srcDir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.'))
    .map((d) => d.name);

  if (allFiles.length === 0 && required) {
    throw new Error(`empty_source_dir: ${srcDir}`);
  }
  // `only` restricts deployment to a runtime whitelist (e.g. bin/ holds the
  // installer CLIs too, but we must NOT copy those into the user's runtime dir).
  const files = only ? allFiles.filter((n) => only.includes(n)) : allFiles;
  ensureDir(destDir);

  for (const name of files) {
    const src = join(srcDir, name);
    const dst = join(destDir, name);
    if (isFile(dst)) unlinkSync(dst);
    atomicWriteText(dst, readFileSync(src, 'utf8'));
    if (basename(dst) === 'probe.mjs' || basename(dst) === 'guard.mjs' || REQUIRED_BASH_RUNTIME_FILES.includes(basename(dst))) {
      try { chmodSync(dst, 0o755); } catch (_) { /* best-effort */ }
    }
    result.copied.push(name);
  }

  // log optional-but-missing files so the user can chase the parallel task
  for (const opt of optional) {
    if (!isFile(join(srcDir, opt))) warn(`可选 ${kindLabel} 文件未就位: ${opt} — 请确认对应子任务已完成`);
  }
  return result;
}

function step1_deploy({ srcRoot, binDir, libDir, label = '部署脚本' }) {
  log(`\n[1/5] ${label} → ${binDir}`);
  const probe = deployTree(join(srcRoot, 'lib', 'probe'), join(libDir, 'probe'),
    { required: true, kindLabel: 'lib/probe' });
  info(`lib/probe → ${probe.copied.length} 个文件 (${probe.copied.join(', ') || '空'})`);

  const guard = deployTree(join(srcRoot, 'lib', 'guard'), join(libDir, 'guard'),
    { required: false, kindLabel: 'lib/guard' });
  if (guard.copied.length) info(`lib/guard → ${guard.copied.length} 个文件`);

  const installer = deployTree(join(srcRoot, 'lib', 'installer'), join(libDir, 'installer'),
    { required: true, kindLabel: 'lib/installer (自部署)' });
  info(`lib/installer → ${installer.copied.length} 个文件 (${installer.copied.join(', ') || '空'})`);

  // bin/
  const probeBin = deployTree(join(srcRoot, 'bin'), binDir,
    { required: true, optional: OPTIONAL_BIN_FILES,
      only: [...REQUIRED_BIN_FILES, ...OPTIONAL_BIN_FILES], kindLabel: 'bin' });
  for (const f of probeBin.copied) {
    const dst = join(binDir, f);
    try { chmodSync(dst, 0o755); } catch (_) { /* best-effort */ }
    info(`bin/${f} → 已部署 (+x)`);
  }
  for (const opt of OPTIONAL_BIN_FILES) {
    if (!isFile(join(binDir, opt))) {
      warn(`bin/${opt} 未部署 — hook 暂时不会触发;请在对应子任务完成后重跑安装器`);
    }
  }

  const bashRuntime = deployTree(join(srcRoot, 'claude-budget-guard'), binDir,
    { required: true, only: REQUIRED_BASH_RUNTIME_FILES, kindLabel: 'claude-budget-guard runtime' });
  for (const f of bashRuntime.copied) {
    const dst = join(binDir, f);
    try { chmodSync(dst, 0o755); } catch (_) { /* best-effort */ }
    info(`${f} → 已部署 (+x)`);
  }
  for (const f of REQUIRED_BASH_RUNTIME_FILES) {
    if (!isFile(join(binDir, f))) throw new Error(`missing_deployed_runtime: ${f}`);
  }

  // version marker (single string for cheap "is it stale?" check later)
  const marker = {
    protocol_version: PROTOCOL_VERSION,
    src_root: srcRoot,
    deployed_at: new Date().toISOString(),
    file_hash: hashDir(srcRoot),
  };
  atomicWriteJSON(join(binDir, '.installed-version'), marker);
  info(`版本标记 → ${binDir}/.installed-version`);
  return { probe, guard, installer, probeBin, bashRuntime };
}

function hashDir(root) {
  // Cheap content hash over bin/* + lib/* + CLAUDE.md (non-secret) so we can
  // detect drift between installed payload and source. SHA-256 of all
  // file paths joined with their mtime+size — not a real content digest but
  // enough to spot "source moved on, deployed didn't".
  const h = createHash('sha256');
  const walk = (p) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isFile()) h.update(`${p}|${st.mtimeMs}|${st.size}\n`);
    else if (st.isDirectory()) {
      for (const e of readdirSync(p).sort()) walk(join(p, e));
    }
  };
  walk(join(root, 'bin'));
  walk(join(root, 'lib'));
  walk(join(root, 'claude-budget-guard'));
  return h.digest('hex').slice(0, 16);
}

// ─── 2. merge hooks into settings.json ────────────────────────────────────

const MANAGED_HOOK_COMMAND_RE = new RegExp(
  String.raw`^\s*(?:node\s+)?(?:(?:"[^"]*[/\\]\.budget-guard[/\\]bin[/\\](?:${escapeRe(HOOK_MARKER)}|${escapeRe(HOOK_MARKER_BASH)})"|'[^']*[/\\]\.budget-guard[/\\]bin[/\\](?:${escapeRe(HOOK_MARKER)}|${escapeRe(HOOK_MARKER_BASH)})')|(?:(?:/|~|\.{1,2}/|[A-Za-z]:[/\\]).*?[/\\]\.budget-guard[/\\]bin[/\\](?:${escapeRe(HOOK_MARKER)}|${escapeRe(HOOK_MARKER_BASH)})))\s+${AGENT}\s+(?:prompt|pre|post|stop|resume)(?:\s|$)`
);

function isManagedHookCommand(command) {
  return typeof command === 'string' && MANAGED_HOOK_COMMAND_RE.test(command);
}

function cleanBudgetGuardEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  let changed = false;
  const next = { ...entry };

  if (isManagedHookCommand(next.command)) {
    delete next.command;
    changed = true;
  }

  if (Array.isArray(next.hooks)) {
    const kept = [];
    for (const hook of next.hooks) {
      if (hook && typeof hook === 'object' && isManagedHookCommand(hook.command)) {
        changed = true;
      } else {
        kept.push(hook);
      }
    }
    if (kept.length) next.hooks = kept;
    else delete next.hooks;
  }

  if (!changed) return entry;
  if (next.command || (Array.isArray(next.hooks) && next.hooks.length)) return next;
  return null;
}

function upsertHookArray(arr, build) {
  const filtered = arr.map(cleanBudgetGuardEntry).filter((e) => e !== null);
  filtered.push(build());
  return filtered;
}

function buildHookEntry({ binDir, phase, matcher, timeout }) {
  const entry = {
    hooks: [{
      type: 'command',
      command: `${shellDoubleQuote(`${binDir}/guard.mjs`)} ${AGENT} ${phase}`,
      timeout,
    }],
  };
  if (matcher) entry.matcher = matcher;
  return entry;
}

const HOOK_PLAN = [
  ['UserPromptSubmit', 'prompt', null],
  ['PreToolUse',       'pre',    HOOK_MATCHER],
  ['PostToolUse',      'post',   HOOK_MATCHER],
  ['Stop',             'stop',   null],
  ['SessionStart',     'resume', null],
];

function step2_mergeSettings({ settingsPath, binDir, claudeDir }) {
  log(`\n[2/5] 合并 hook → ${settingsPath}`);
  ensureDir(claudeDir);

  let cfg = {};
  if (isFile(settingsPath)) {
    cfg = readJSON(settingsPath);
    if (cfg === null) cfg = {};
  }
  const hooks = cfg.hooks || {};
  const plan = HOOK_PLAN.map(([event, phase, matcher]) =>
    ({ event, entry: buildHookEntry({ binDir, phase, matcher, timeout: HOOK_TIMEOUT }) }));

  // back up before mutating
  const bak = isFile(settingsPath) ? safeBackup(settingsPath) : null;
  if (bak) info(`备份 → ${basename(bak)}`);

  const newHooks = { ...hooks };
  let addedCount = 0;
  for (const { event, entry } of plan) {
    const before = Array.isArray(newHooks[event]) ? newHooks[event] : [];
    newHooks[event] = upsertHookArray(before, () => entry);
    if (newHooks[event].length !== before.length) addedCount++;
  }
  cfg.hooks = newHooks;

  atomicWriteJSON(settingsPath, cfg);
  info(`注册事件数: ${plan.length}; 净新增条目: ${addedCount}; 总条目: ${countHookEntries(newHooks)}`);
  return { addedCount, totalEvents: plan.length };
}

function countHookEntries(hooks) {
  let n = 0;
  for (const ev of Object.keys(hooks)) {
    if (Array.isArray(hooks[ev])) n += hooks[ev].length;
  }
  return n;
}

// ─── 3. write protocol block to CLAUDE.md (the "使用方式" part) ───────────

const PROTOCOL_BLOCK = `## 额度守卫协议(自动安装,无需手动配置)

你运行在一个会监控订阅额度的环境里。装好后这套**自然生效**,你**无需人提醒**——遇到下列情况就按规约执行,不要等人催。

### A. 被动监控(默认开启,平时静默)
- util < 软线(默认 80%):完全静默,不要主动提额度。
- T1 提醒(~80%,本窗口一次):收到带「额度已用 X%」的一次性提示,确认目标能收束,继续推进。
- T2 提醒(~90%,重复):每次收到都收尾当前步,把进度写到 $BUDGET_CHECKPOINT(默认 .agent/checkpoint.md)。
- T3 硬线(~92%):轮末会被强制停(\`continue:false\` / 工具被 deny)。**立即停,不要重试、不要换工具、不要绕路**。

### B. 主动使用方式(新会话 / 长任务 / 自己想查时用)
- **查自己剩余额度**(任意时刻):
  - \`~/.budget-guard/bin/probe.mjs claude probe\`  → stdout 一行 JSON(ok / util / bucket_id / reset_epoch / buckets[] / extra_usage / source / stale)
  - \`~/.budget-guard/bin/probe.mjs claude doctor\` → 人类可读诊断(阈值 / 缓存 / 429 闸 / schema)
  - 设置 \`BUDGET_USAGE_FIXTURE=<path>\` 可纯本地解析(测试用)
- **临近 T2/T3 时主动等刷新,不退出**:
  - 轮询自等: \`while true; do r=\$(~/.budget-guard/bin/probe.mjs claude probe | jq -r '.util // 0'); [ "\$r" -lt ${'$'}{BUDGET_WARN_ONCE:-80} ] && break; sleep 60; done\`
  - 或读取 \`reset_epoch\` 字段计算 \`reset_epoch - now()\` 自行 \`sleep\` 到刷新点
- **写 checkpoint**(写文件不被 hook 拦,放心写):
  - 路径: **$BUDGET_CHECKPOINT**(默认 \`.agent/checkpoint.md\`)
  - 模板见下方;写完即可停,等下一轮 / 新会话续接
- **hard-stop 时的标准动作**:
  - **不重试 / 不换工具 / 不绕路**(T3 已经在轮末,硬冲只会更糟)
  - 只做两件事:① 把进度写到 \`.agent/checkpoint.md\` ② 用文字把"下一步"告诉用户
- **长任务(/goal /loop /batch /background)启动**:
  - 会先收到一段规划预估(还能跑多久、何时刷新)。据此**把目标切成 checkpoint 化小块**,先做最关键部分。
- **新会话自动续接**:
  - 带「续接」提示时,从 checkpoint 的「下一步」继续,跳过「已完成」。

### Checkpoint 模板
写到 \`$BUDGET_CHECKPOINT\`:
\`\`\`
# Checkpoint <ISO 时间>
## 任务: <一句话>
## 已完成: ...
## 进行中(中断点): <文件/函数/步骤>
## 下一步: 1) ... 2) ...
## 关键决策/约束: ...
## 别再做: <已完成项>
\`\`\`

### 阈值与排查
- 阈值: \`BUDGET_WARN_ONCE=80 BUDGET_WARN_REPEAT=90 BUDGET_HARD=92\`,非法时 doctor 退出码 = 4
- 状态目录: \`$HOME/.budget-guard/\`(可 \`BUDGET_STATE_DIR\` 覆盖);含 \`usage_claude.json\`(缓存)、\`ratelimit_claude.json\`(429 闸)、\`hist_claude.jsonl\`(消耗速率)
- 自动续跑(托管,默认关闭): \`BUDGET_WATCHDOG_ARM=1\` 启用 watchdog.sh,见 README
`;

function buildProtocolBlock() {
  return `${MARK_START}\n${PROTOCOL_BLOCK.trim()}\n${MARK_END}\n`;
}

const MANAGED_PROTOCOL_HEADER = '## 额度守卫协议(自动安装,无需手动配置)';

function* protocolBlocks(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+/g) || [];
  let offset = 0;
  let candidate = null;
  let fence = null;

  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const content = line.endsWith('\n') ? line.slice(0, -1) : line;
    const fenceMatch = content.match(/^\s*(`{3,}|~{3,})/);

    if (fenceMatch) {
      const marker = { ch: fenceMatch[1][0], len: fenceMatch[1].length };
      if (!fence) fence = marker;
      else if (marker.ch === fence.ch && marker.len >= fence.len) fence = null;
      offset = lineEnd;
      continue;
    }

    if (!fence) {
      if (content === MARK_START) {
        candidate = { start: lineStart, bodyStart: lineEnd };
      } else if (content === MARK_END && candidate) {
        yield { start: candidate.start, end: lineEnd, body: text.slice(candidate.bodyStart, lineStart) };
        candidate = null;
      }
    }

    offset = lineEnd;
  }
}

function isManagedProtocolBody(body) {
  for (const line of body.split(/\n/)) {
    if (line.trim()) return line === MANAGED_PROTOCOL_HEADER;
  }
  return false;
}

function appendProtocolBlock(text, block) {
  if (text.length === 0) return block;
  if (text.endsWith('\n\n')) return text + block;
  if (text.endsWith('\n')) return text + '\n' + block;
  return text + '\n\n' + block;
}

function upsertManagedProtocolBlock(text, block) {
  const pieces = [];
  let last = 0;
  let replaced = false;

  for (const { start, end, body } of protocolBlocks(text)) {
    if (!isManagedProtocolBody(body)) continue;
    pieces.push(text.slice(last, start));
    if (!replaced) {
      pieces.push(block);
      replaced = true;
    }
    last = end;
  }

  if (!replaced) return appendProtocolBlock(text, block);
  pieces.push(text.slice(last));
  return pieces.join('');
}

function stripManagedProtocolBlocks(text) {
  const pieces = [];
  let last = 0;
  let changed = false;

  for (const { start, end, body } of protocolBlocks(text)) {
    if (!isManagedProtocolBody(body)) continue;
    pieces.push(text.slice(last, start));
    last = end;
    changed = true;
  }

  if (!changed) return { text, changed: false };
  pieces.push(text.slice(last));
  return { text: pieces.join(''), changed: true };
}

function step3_writeMemory({ memoryPath, claudeDir }) {
  log(`\n[3/5] 写入协议 + 使用方式 → ${memoryPath}`);
  ensureDir(claudeDir);

  const bak = isFile(memoryPath) ? safeBackup(memoryPath) : null;
  if (bak) info(`备份 → ${basename(bak)}`);

  let body = '';
  if (isFile(memoryPath)) body = readFileSync(memoryPath, 'utf8');

  const block = buildProtocolBlock();
  const next = upsertManagedProtocolBlock(body, block);
  atomicWriteText(memoryPath, next);
  const bytes = Buffer.byteLength(block, 'utf8');
  info(`协议块大小: ${bytes} bytes(含被动监控 + 主动使用方式)`);
  return { bytes };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ─── 4. doctor self-check (non-fatal) ────────────────────────────────────

function step4_doctor({ binDir }) {
  log(`\n[4/5] 自检 doctor → ${binDir}/probe.mjs claude doctor`);
  const probe = join(binDir, 'probe.mjs');
  if (!isFile(probe)) {
    warn(`probe.mjs 不在 ${binDir};跳过 doctor`);
    return { code: -1, stdout: '', stderr: 'probe.mjs not found' };
  }
  const r = spawnSync('node', [probe, AGENT, 'doctor'], { encoding: 'utf8', timeout: 15000 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const code = r.status ?? 1;
  if (code === 0) {
    info('doctor 退出码 0,全绿');
  } else if (code === 1) {
    warn(`doctor 退出码 1(警告:429 闸可能激活)`);
  } else if (code === 4) {
    warn('doctor 退出码 4(阈值配置非法;已回退到默认值)');
  } else {
    warn(`doctor 退出码 ${code}(网络 / schema / 取数失败;安装本身已成功)`);
  }
  return { code, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// import child_process lazily to keep the module surface narrow
// (real import is hoisted at the top of the file)

// ─── 5. print summary ────────────────────────────────────────────────────

function step5_summary({ summary }) {
  log('\n[5/5] 安装摘要');
  for (const line of summary) info(line);
  log('\n— 试试看 —');
  info('开一个新会话,然后跑: /goal demo "重构某模块"');
  info('观察钩子日志:`tail -f ~/.budget-guard/*.log`(如有)');
  info('看 hook 是否挂上: Claude Code 的 /hooks 应能列出 budget_guard');
  info('卸载: `node bin/install-claude.mjs --uninstall`');
}

// ─── uninstall ────────────────────────────────────────────────────────────

/**
 * Remove everything this installer added:
 *   - hook entries from settings.json (idempotent filter)
 *   - protocol block from CLAUDE.md (regex strip)
 * Script payload at ~/.budget-guard/ is left in place (manual `rm -rf`).
 */
export function uninstall({ settingsPath, memoryPath, binDir, claudeDir }) {
  log('卸载 budget-guard(claude)…');
  let touched = [];

  if (isFile(settingsPath)) {
    const cfg = readJSON(settingsPath);
    if (cfg && cfg.hooks) {
      const bak = safeBackup(settingsPath);
      const newHooks = {};
      for (const [ev, arr] of Object.entries(cfg.hooks)) {
        if (!Array.isArray(arr)) continue;
        const kept = arr.map(cleanBudgetGuardEntry).filter((e) => e !== null);
        if (kept.length) newHooks[ev] = kept;
      }
      if (Object.keys(newHooks).length === 0) delete cfg.hooks;
      else cfg.hooks = newHooks;
      atomicWriteJSON(settingsPath, cfg);
      touched.push(`settings.json ${bak ? '(已备份 ' + basename(bak) + ')' : ''}`);
    }
  } else {
    info('settings.json 不存在,跳过');
  }

  if (isFile(memoryPath)) {
    const bak = safeBackup(memoryPath);
    const text = readFileSync(memoryPath, 'utf8');
    const { text: stripped } = stripManagedProtocolBlocks(text);
    const next = stripped.trimEnd();
    if (next.length === 0) {
      // protocol block was the only content — drop the file entirely
      try { unlinkSync(memoryPath); } catch (_) { /* best-effort */ }
      info(`CLAUDE.md 内容已清空,已删除文件 ${memoryPath}`);
    } else {
      atomicWriteText(memoryPath, next + '\n');
    }
    touched.push(`CLAUDE.md ${bak ? '(已备份 ' + basename(bak) + ')' : ''}`);
  } else {
    info('CLAUDE.md 不存在,跳过');
  }

  log('\n— 卸载完成 —');
  for (const t of touched) info(t);
  info(`脚本本体仍在 ${binDir}(可手动 rm -rf);${claudeDir}/* 已清理 guard 写入项`);
  info('提示:`rm -rf ~/.budget-guard ~/.claude/settings.json.bak.* ~/.claude/CLAUDE.md.bak.*` 彻底清场');
  return { touched };
}

// ─── public entry points ──────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} [opts.srcRoot]   - source tree root (default: <bin>/..)
 * @param {string} [opts.home]      - $HOME override (default: os.homedir())
 * @param {string} [opts.cwd]       - CWD for --project resolution
 * @param {boolean} [opts.project]  - write CLAUDE.md into ./CLAUDE.md instead of ~/.claude/CLAUDE.md
 * @param {boolean} [opts.skipDoctor] - skip the doctor self-check
 */
export function install(opts = {}) {
  const srcRoot = opts.srcRoot || defaultSrcRoot();
  const home    = opts.home    || homedir();
  const cwd     = opts.cwd     || process.cwd();
  const project = !!opts.project;

  // resolve paths
  const budgetDir   = join(home, BUDGET_DIR_NAME);
  const binDir      = join(budgetDir, 'bin');
  const libDir      = join(budgetDir, 'lib');
  const claudeDir   = join(home, CLAUDE_DIR_NAME);
  const settingsPath = join(claudeDir, SETTINGS_FILE);
  const memoryPath  = project
    ? join(cwd, MEMORY_FILE)
    : join(claudeDir, MEMORY_FILE);

  log(`[budget-guard installer] claude  → ${budgetDir}`);
  log(`source: ${srcRoot}`);
  log(`memory target: ${memoryPath}${project ? ' (--project 模式)' : ''}`);

  // 1. deploy
  const deployResult = step1_deploy({ srcRoot, binDir, libDir });
  // 2. settings.json
  const settingsResult = step2_mergeSettings({ settingsPath, binDir, claudeDir });
  // 3. CLAUDE.md protocol
  const memoryResult = step3_writeMemory({ memoryPath, claudeDir });

  // 4. doctor
  const doctorResult = opts.skipDoctor
    ? { code: -1, stdout: '', stderr: 'skipped' }
    : step4_doctor({ binDir });

  // 5. summary
  step5_summary({
    summary: [
      `脚本位置: ${binDir}/probe.mjs (+ guard.mjs 若已就位)`,
      `settings.json hook 已注册: ${settingsResult.totalEvents} 个事件 (${settingsPath})`,
      `CLAUDE.md 协议块: ${memoryResult.bytes} bytes (${memoryPath})`,
      `doctor 退出码: ${doctorResult.code} (${doctorCodeLabel(doctorResult.code)})`,
    ],
  });

  return {
    ok: true,
    binDir, libDir, claudeDir, settingsPath, memoryPath,
    deployResult, settingsResult, memoryResult, doctorResult,
  };
}

function doctorCodeLabel(c) {
  return c === 0  ? 'OK'
       : c === 1  ? 'WARN(429 闸激活或软警告)'
       : c === 2  ? 'PARTIAL(网络/认证失败)'
       : c === 3  ? 'SCHEMA(响应不可识别)'
       : c === 4  ? 'CONFIG INVALID(阈值非法,已回退)'
       : c === -1 ? 'SKIPPED'
       : `EXIT=${c}`;
}

function defaultSrcRoot() {
  // this file lives at <srcRoot>/lib/installer/claude.mjs when deployed in-tree.
  // When running from a copy at $HOME/.budget-guard/lib/installer/claude.mjs,
  // the installer still works but srcRoot is the deployed copy — caller can
  // pass opts.srcRoot to override (the CLI shim does this).
  const here = dirname(fileURLToPath(import.meta.url));
  // walk up until we find a `lib/probe/index.mjs` sibling, that's the source root
  let cur = here;
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(cur, 'lib', 'probe', 'index.mjs'))) return cur;
    cur = dirname(cur);
  }
  // fall back to two levels up (bin/install-claude.mjs → <root>)
  return dirname(dirname(here));
}
