// config.mjs —— 共享配置加载器(Node 侧,与 Bash 侧 budget-config.sh 行为一致)
//
// 把全局 + 项目两层 `.conf` 里的 BUDGET_* 设置载入 process.env,供后续读取。
// 两份配置都可选;都不存在时行为与纯默认完全一致。
//
// 优先级(高 → 低):进程环境变量 > 项目配置 > 全局配置 > 内置默认。
//
// 文件:
//   全局   ${BUDGET_STATE_DIR:-$HOME/.budget-guard}/config
//   项目   从 cwd 向上查找的第一个 .budget-guard.conf
//
// 格式(与 Bash 侧 budget-config.sh 必须一致):
//   · 一行一个 BUDGET_KEY=VALUE;只接受明确安全的 BUDGET_* 调参 key。
//   · 整行注释(首个非空字符为 #)和空行忽略;不支持行尾内联注释。
//   · VALUE = 第一个 = 之后到行尾,去首尾空白,再去掉一层成对的 " 或 ' 引号。
//   · 不做变量展开 / 命令替换(字面值)。

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse as parsePath } from 'node:path';

const KEY_RE = /^BUDGET_[A-Za-z0-9_]+$/;
const CONFIG_KEYS = new Set([
  'BUDGET_WARN_ONCE',
  'BUDGET_WARN_REPEAT',
  'BUDGET_SOFT',
  'BUDGET_CHECKPOINT_LEAD',
  'BUDGET_HARD',
  'BUDGET_CACHE_TTL',
  'BUDGET_HIST_WINDOW',
  'BUDGET_CLAUDE_UA',
]);

const CONFIG_KEY_ALIASES = new Map([
  ['BUDGET_SOFT', 'BUDGET_WARN_REPEAT'],
]);

function canonicalConfigKey(key) {
  return CONFIG_KEY_ALIASES.get(key) || key;
}

function isRegularFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function stripOneQuotePair(val) {
  if (val.length >= 2) {
    const a = val[0];
    const b = val[val.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return val.slice(1, -1);
    }
  }
  return val;
}

// 解析单个配置文件 → { KEY: VALUE }(只含允许从配置文件载入的安全项)
function parseConfigFile(file) {
  const out = {};
  if (!isRegularFile(file)) return out;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    if (!CONFIG_KEYS.has(key)) continue;
    const target = canonicalConfigKey(key);
    const val = stripOneQuotePair(line.slice(eq + 1).trim());
    out[target] = val;
  }
  return out;
}

// 从 startDir 向上查找第一个 .budget-guard.conf;找不到返回 null
function findProjectConfig(startDir) {
  let dir = startDir;
  const root = parsePath(dir).root;
  // 包含根目录本身在内向上走
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(dir, '.budget-guard.conf');
    if (isRegularFile(candidate)) return candidate;
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 载入全局 + 项目配置到 process.env(env 始终胜)。
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env] 目标环境(测试可注入)
 * @param {string} [opts.cwd=process.cwd()] 项目查找起点
 * @returns {{global: string|null, project: string|null, applied: string[]}}
 */
export function loadBudgetConfig(opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd || env.PWD || process.cwd();

  // 1. 快照当前环境已有的 BUDGET_* key(这些最高优先,不被配置覆盖)
  const protectedKeys = new Set(
    Object.keys(env).filter((k) => KEY_RE.test(k))
  );
  if (protectedKeys.has('BUDGET_SOFT')) protectedKeys.add('BUDGET_WARN_REPEAT');
  if (protectedKeys.has('BUDGET_WARN_REPEAT')) protectedKeys.add('BUDGET_SOFT');

  const home = env.HOME || homedir();
  const stateDir = env.BUDGET_STATE_DIR || join(home, '.budget-guard');
  const globalPath = join(stateDir, 'config');
  const projectPath = findProjectConfig(cwd);

  const applied = [];
  // 2. 全局 → 项目(项目覆盖全局;两者都跳过 env 已设的 key)
  for (const file of [globalPath, projectPath]) {
    if (!file) continue;
    const parsed = parseConfigFile(file);
    for (const [k, v] of Object.entries(parsed)) {
      if (protectedKeys.has(k)) continue; // env 胜
      env[k] = v;
      if (!applied.includes(k)) applied.push(k);
    }
  }

  return {
    global: isRegularFile(globalPath) ? globalPath : null,
    project: projectPath,
    applied
  };
}
