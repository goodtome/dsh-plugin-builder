const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { run } = require('./core.cjs');

function profileCandidates(appData, env = process.env, home = os.homedir()) {
  return [...new Set([
    env.DSH_HOME,
    path.join(appData, 'AlphaTrust-Kaiwu', 'dsh-home'),
    path.join(appData, 'AlphaTrust', 'dsh-home'),
    path.join(home, '.dsh'),
  ].filter(Boolean).map(value => path.resolve(value)))];
}
async function installedProfiles(packageName, homes) {
  const found = [];
  for (const home of homes) {
    const profile = path.join(home, 'profiles', 'desktop');
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(profile, 'package.json'), 'utf8')); } catch { continue; }
    const spec = manifest.dependencies?.[packageName];
    if (typeof spec !== 'string') continue;
    let version = null;
    try { version = JSON.parse(await fs.readFile(path.join(profile, 'node_modules', packageName, 'package.json'), 'utf8')).version ?? null; } catch {}
    found.push({ profile, spec, version, enabled: (manifest.dsh?.profile?.bundles ?? []).includes(packageName) });
  }
  return found;
}
function findDshCli(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'engines/dsh/apps/cli/lib/bin.js');
    if (fssync.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}
function redact(text) { return text.replace(/([?&]token=)[^\s&#]+/giu, '$1[redacted]'); }
function waitForWebReady(binary, args, { cwd, env, signal, log = () => {}, timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', settled = false, ready = false, outcome;
    let settleTimer, killTimer;
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      killTimer ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000);
    };
    const finish = error => { if (outcome || settled) return; outcome = error ?? true; stop(); };
    const cancel = () => finish(new Error('已取消 DSH 验证'));
    const timer = setTimeout(() => finish(new Error(`DSH 启动超时：${redact(output.slice(-1500))}`)), timeoutMs);
    const collect = data => {
      output = (output + data.toString()).slice(-10000);
      if (/startup failed|did not activate|error: listen|Error:/iu.test(output)) {
        finish(new Error(`DSH 启动未通过：${redact(output.slice(-2500))}`)); return;
      }
      if (!ready && /dsh web:\s+http:\/\/127\.0\.0\.1:\d+/u.test(output)) {
        ready = true; log('DSH Web Host 已在临时 Profile 启动。\n');
        settleTimer = setTimeout(() => finish(), 700);
      }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', error => { outcome = error; });
    child.on('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(settleTimer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', cancel);
      const error = outcome instanceof Error ? outcome : outcome === true ? null : new Error(`DSH 在就绪前退出（${code}）：${redact(output.slice(-2500))}`);
      error ? reject(error) : resolve({ started: true });
    });
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  });
}
async function verifyDshPackage({ archive, cli, runtime, offline = true, signal, phase = () => {}, log = () => {} }) {
  if (!cli || !fssync.existsSync(cli)) throw new Error('未找到 DSH CLI，请先选择已构建的 DSH CLI 文件');
  if (!fssync.existsSync(archive)) throw new Error('插件包文件不存在，请重新生成');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-verify-'));
  const env = {
    HOME: os.homedir(), TMPDIR: os.tmpdir(), LANG: process.env.LANG ?? 'en_US.UTF-8',
    PATH: `${runtime.bin}${path.delimiter}${process.env.PATH ?? ''}`,
    DSH_HOME: temp, DSH_AGENTS_HOME: path.join(temp, 'agents'),
    npm_config_offline: offline ? 'true' : 'false',
    npm_config_audit: 'false', npm_config_fund: 'false',
    // Offline installs must be able to read the user's existing package cache.
    ...(!offline ? { npm_config_cache: path.join(temp, 'npm-cache') } : {}),
  };
  const safeLog = value => log(redact(value));
  try {
    phase('检查 DSH 版本');
    const version = (await run(runtime.node, [cli, '--version'], { env, signal })).trim();
    phase('临时 Profile 安装');
    safeLog(`DSH ${version}，临时 Profile；依赖下载：${offline ? '关闭' : '允许'}。\n`);
    await run(runtime.node, [cli, 'plugin', '--profile', 'web', 'add', archive], { env, signal, log: safeLog });
    phase('组合 DSH 配置');
    await run(runtime.node, [cli, '--profile', 'web', '--dump-config'], { env, signal });
    phase('启动 DSH Web Host');
    await waitForWebReady(runtime.node, [cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, signal, log: safeLog });
    phase('DSH 验证通过');
    return { status: 'passed', version, checkedAt: new Date().toISOString(), scope: 'Temporary Web profile: package install, config composition, Host startup. Browser UI interactions not checked.' };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
module.exports = { profileCandidates, installedProfiles, findDshCli, redact, waitForWebReady, verifyDshPackage };
