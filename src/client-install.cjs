const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { run } = require('./core.cjs');
const { installedProfiles } = require('./dsh-check.cjs');

const execFileAsync = promisify(execFile);
const entry = 'app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js';
async function plistValue(plist, key) {
  try { return (await execFileAsync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])).stdout.trim(); }
  catch { return null; }
}
async function isFile(file) { try { return (await fs.stat(file)).isFile(); } catch { return false; } }
function possibleHomes(name, bundleId, appData, home = os.homedir()) {
  const names = name && name !== '.' && name !== '..' && !/[/\\:]/u.test(name) ? [name] : [];
  if (bundleId === 'com.alphatrust.kaiwu.client') names.push('AlphaTrust-Kaiwu', 'AlphaTrust');
  const homes = names.filter(Boolean).map(value => path.join(appData, value, 'dsh-home'));
  if (bundleId.startsWith('com.deepseek.') || name === 'DeepSeek Harness') homes.push(path.join(home, '.dsh'));
  return [...new Set(homes)];
}
async function inspectApp(appPath, appData, home) {
  const real = await fs.realpath(appPath);
  if (!real.endsWith('.app')) return [];
  const contents = path.join(real, 'Contents');
  const plist = path.join(contents, 'Info.plist');
  const bundleId = await plistValue(plist, 'CFBundleIdentifier');
  const executable = await plistValue(plist, 'CFBundleExecutable');
  const name = await plistValue(plist, 'CFBundleName') ?? path.basename(real, '.app');
  if (!bundleId || !executable || path.basename(executable) !== executable) return [];
  const binary = path.join(contents, 'MacOS', executable);
  const cli = path.join(contents, 'Resources/runtime/cli/bin/dsh');
  const asar = path.join(contents, 'Resources/app.asar');
  if (!await isFile(binary) || !await isFile(cli) || !await isFile(asar)) return [];
  if (!(await fs.readFile(cli, 'utf8')).includes('@deepseek-ai/dsh-desktop-host/lib/cli.js')) return [];
  const version = await plistValue(plist, 'CFBundleShortVersionString');
  const targets = [];
  for (const dshHome of possibleHomes(name, bundleId, appData, home)) {
    const profile = path.join(dshHome, 'profiles/desktop');
    if (!await isFile(path.join(profile, 'package.json')) || !await isFile(path.join(profile, 'cordis.yml'))) continue;
    targets.push({ id: crypto.createHash('sha256').update(`${real}\0${dshHome}`).digest('hex'), name, bundleId, version, appPath: real, home: dshHome, profile, binary, cliEntry: path.join(contents, 'Resources', entry) });
  }
  return targets;
}
async function discoverClients({ appData, home = os.homedir(), directories = ['/Applications', path.join(home, 'Applications')], extraApps = [] }) {
  const apps = [...extraApps];
  for (const directory of directories) {
    let items;
    try { items = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const item of items) if (item.name.endsWith('.app') && (item.isDirectory() || item.isSymbolicLink())) apps.push(path.join(directory, item.name));
  }
  const targets = [];
  for (const app of new Set(apps)) {
    try { targets.push(...await inspectApp(app, appData, home)); } catch {}
  }
  return [...new Map(targets.map(item => [item.id, item])).values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.home.localeCompare(b.home));
}
async function installToClient({ target, archive, name, version, sha256, signal, phase = () => {}, log = () => {} }) {
  const fresh = (await inspectApp(target.appPath, path.dirname(path.dirname(target.home)), os.homedir())).find(item => item.id === target.id && item.home === target.home);
  if (!fresh) throw new Error('目标客户端或其 Desktop Profile 已变化，请重新扫描');
  if ((await installedProfiles(name, [target.home])).length) throw new Error(`目标客户端已安装 ${name}。请先在该客户端卸载旧版，再安装新包`);
  const digest = crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  if (digest !== sha256) throw new Error('插件包已变化，请重新生成');
  phase('向所选客户端安装插件');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: target.home };
  await run(target.binary, ['--expose-internals', target.cliEntry, 'plugin', '--profile', 'desktop', 'add', archive], { env, signal, log });
  phase('确认客户端安装结果');
  const installed = (await installedProfiles(name, [target.home]))[0];
  if (!installed || installed.version !== version) throw new Error('安装命令已结束，但目标 Profile 未显示预期版本，请在客户端检查');
  return { name, version, client: target.name, appPath: target.appPath, profile: target.profile, installedAt: new Date().toISOString() };
}
module.exports = { possibleHomes, inspectApp, discoverClients, installToClient };
