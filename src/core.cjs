const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const yaml = require('js-yaml');
const semver = require('semver');

function run(binary, args, { cwd, env, signal, log = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, signal, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = data => { const text = data.toString(); output = (output + text).slice(-2_000_000); log(text); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', error => { signal?.removeEventListener('abort', stop); reject(error); });
    child.on('close', code => { signal?.removeEventListener('abort', stop); code === 0 ? resolve(output) : reject(new Error(signal?.aborted ? '已取消打包' : `执行失败（${code}）：${output.slice(-5000)}`)); });
  });
}
function inside(root, file) { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
function suggestedFileName(name, version) { return `${name.replace(/^@/, '').replace('/', '-')}-${version}`; }
function outputFileName(value) {
  if (typeof value !== 'string') throw new Error('请输入插件包名称');
  if (/[/\\:\x00-\x1f\x7f]/u.test(value)) throw new Error('插件包名称不能包含路径分隔符、冒号或控制字符');
  const base = value.trim().replace(/\.tgz$/i, '').normalize('NFC');
  if (!base || base === '.' || base === '..' || base.startsWith('.') || base.endsWith('.') || Buffer.byteLength(base) > 120) {
    throw new Error('插件包名称不能包含路径分隔符、冒号或控制字符，也不能以点开头或结尾，最长 120 字节');
  }
  return `${base}.tgz`;
}
function patchFiles(pkg) { const value = pkg.dsh?.bundle?.patch; return typeof value === 'string' ? [value] : Array.isArray(value) && value.length && value.every(v => typeof v === 'string') ? value : []; }
function targets(value) { return typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(targets) : []; }
function entries(pkg) {
  const exp = pkg.exports;
  const found = [...targets(pkg.main), ...targets(typeof exp === 'string' ? exp : exp?.['.']), ...targets(exp?.['./client']), ...targets(pkg.dsh?.client?.entry)];
  return [...new Set(found)].filter(file => !file.endsWith('.d.ts') && !file.includes('*'));
}
async function inspect(root, { built = false } = {}) {
  root = await fs.realpath(root);
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const errors = [], warnings = [];
  if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(pkg.name ?? '')) errors.push('package.json 缺少合法的 npm 包名 name');
  if (!semver.valid(pkg.version)) errors.push('version 必须是有效的语义化版本，例如 1.0.0');
  const patches = patchFiles(pkg);
  if (!patches.length) errors.push('缺少 dsh.bundle.patch。请先将项目适配为 DSH 组合包');
  if (!pkg.files?.length) warnings.push('未声明 files 白名单，建议明确限定发布文件');
  if (!pkg.engines?.dsh) warnings.push('未声明 engines.dsh，无法确认目标 DSH 版本兼容范围');
  else if (!semver.validRange(pkg.engines.dsh)) errors.push('engines.dsh 不是有效的版本范围');
  for (const [group, deps] of Object.entries({ dependencies: pkg.dependencies, optionalDependencies: pkg.optionalDependencies, peerDependencies: pkg.peerDependencies })) {
    for (const [name, version] of Object.entries(deps ?? {})) {
      if (/^(workspace:|catalog:|file:|link:|\/|\.\.?\/)/.test(version)) errors.push(`${group}.${name} 使用本地或工作区引用 ${version}，请改为可分发的版本`);
    }
  }
  async function local(file, required) {
    const full = path.resolve(root, file);
    if (!inside(root, full)) { errors.push(`入口超出源码目录：${file}`); return; }
    try {
      const real = await fs.realpath(full);
      if (!inside(root, real)) errors.push(`入口链接指向源码目录外：${file}`);
      if (!(await fs.stat(real)).isFile()) errors.push(`入口不是文件：${file}`);
    } catch { (required ? errors : warnings).push(`缺少文件：${file}${required ? '' : '，需要构建后生成'}`); }
  }
  for (const file of patches) {
    await local(file, true);
    const full = path.resolve(root, file);
    if (!inside(root, full) || !await exists(full)) continue;
    if (!inside(root, await fs.realpath(full))) continue;
    try {
      const patch = yaml.load(await fs.readFile(full, 'utf8'), { schema: yaml.JSON_SCHEMA });
      if (!Array.isArray(patch)) errors.push(`${file} 必须是 DSH patch 数组`);
      if (Array.isArray(patch) && !patch.length) warnings.push(`${file} 是空数组，没有注册插件`);
    } catch (error) { errors.push(`${file} YAML 解析失败：${error.message}`); }
  }
  const hostEntries = entries(pkg);
  if (!hostEntries.length) warnings.push('未声明可检查的 Host/Client 入口，可能是只组合其他插件的 bundle');
  for (const file of hostEntries) await local(file, built);
  if (pkg.dsh?.client && !pkg.exports?.['./client'] && !pkg.dsh.client.entry) errors.push('声明了 dsh.client，但缺少 exports["./client"] 客户端入口');
  return { root, name: pkg.name, version: pkg.version, description: pkg.description ?? '', build: pkg.scripts?.build ?? null, manager: pkg.packageManager?.startsWith('pnpm@') ? 'pnpm' : 'npm', patches, entries: hostEntries, errors, warnings, pkg };
}
async function copySource(from, to, { dependencies = false } = {}) {
  const excluded = new Set(['.git', '.DS_Store', '.cache', '.local', 'coverage']);
  async function visit(source, target, dependencyTree = false) {
    await fs.mkdir(target, { recursive: true });
    for (const item of await fs.readdir(source, { withFileTypes: true })) {
      if (excluded.has(item.name) || item.name === '.env' || item.name.startsWith('.env.') && !item.name.endsWith('.example')) continue;
      if (item.name === 'node_modules' && !dependencies) continue;
      const origin = path.join(source, item.name), dest = path.join(target, item.name);
      if (item.isSymbolicLink()) {
        // Dependencies may contain pnpm links. Materialize them; source links are rejected.
        if (!dependencyTree) throw new Error(`源码含符号链接，请先替换为实际文件：${origin}`);
        await fs.cp(origin, dest, { recursive: true, dereference: true });
      } else if (item.isDirectory()) await visit(origin, dest, dependencyTree || item.name === 'node_modules');
      else if (item.isFile()) await fs.copyFile(origin, dest);
      else throw new Error(`不支持的文件类型：${origin}`);
    }
  }
  await visit(from, to);
}
async function buildPlugin({ source, output, fileName, install = false, build = false, runtime, signal, log = () => {}, phase = () => {} }) {
  const initial = await inspect(source);
  if (initial.errors.length) throw new Error(initial.errors.join('\n'));
  if (install && !build) throw new Error('安装依赖仅用于构建，请同时启用构建');
  const destination = await fs.realpath(output);
  if (inside(initial.root, destination)) throw new Error('输出目录请选在源码目录之外，避免将产物再次打包');
  const filename = outputFileName(fileName ?? suggestedFileName(initial.name, initial.version));
  const target = path.join(destination, filename);
  const outputs = [target, `${target}.sha256`, `${target}.report.json`];
  if ((await Promise.all(outputs.map(exists))).some(Boolean)) throw new Error(`输出文件已存在，请修改插件包名称：${filename}`);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-builder-'));
  const stage = path.join(temp, 'source');
  const env = { ...process.env, ...runtime.env, PATH: `${runtime.bin}${path.delimiter}${process.env.PATH ?? ''}`, npm_config_cache: path.join(temp, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', COREPACK_ENABLE_PROJECT_SPEC: '0' };
  const options = { cwd: stage, env, signal, log };
  let timer;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  options.signal = controller.signal;
  timer = setTimeout(abort, 15 * 60 * 1000);
  try {
    phase('准备源码副本'); log(`项目：${initial.name}@${initial.version}\n源码：${initial.root}\n`);
    await copySource(initial.root, stage, { dependencies: build && !install });
    controller.signal.throwIfAborted();
    const manager = initial.manager === 'pnpm' ? runtime.pnpm : runtime.npm;
    if (install) {
      phase('安装构建依赖'); log('安装依赖，禁用依赖安装脚本。\n');
      const args = initial.manager === 'pnpm' ? ['install', '--ignore-scripts', '--config.manage-package-manager-versions=false'] : [await exists(path.join(stage, 'package-lock.json')) ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'];
      await run(runtime.node, [manager, ...args], options);
    }
    if (build && initial.build) { phase('构建插件'); await run(runtime.node, [manager, 'run', 'build'], options); }
    phase('检查发布入口');
    const prepared = await inspect(stage, { built: true });
    if (prepared.errors.length) throw new Error(prepared.errors.join('\n'));
    const packed = path.join(temp, 'packed'); await fs.mkdir(packed);
    phase('生成插件包');
    // No prepare/prepack/postpack execution. Build is an explicit, separately chosen step.
    await run(runtime.node, [runtime.npm, 'pack', '--ignore-scripts', '--pack-destination', packed], options);
    const archives = (await fs.readdir(packed)).filter(file => file.endsWith('.tgz'));
    if (archives.length !== 1) throw new Error('没有生成唯一的 tgz 插件包');
    const archive = path.join(packed, archives[0]);
    phase('验证插件包');
    const listing = await run('/usr/bin/tar', ['-tzf', archive], { signal: controller.signal });
    const files = listing.trim().split('\n');
    for (const file of files) {
      if (!file.startsWith('package/') || file.split('/').includes('..')) throw new Error(`插件包存在非法路径：${file}`);
      if (/(^|\/)(?:\.env(?:\.[^/]+)?|id_rsa|id_ed25519|[^/]+\.(?:pem|key|p12|pfx))$/iu.test(file) && !file.endsWith('.example')) throw new Error(`发布内容包含敏感配置文件：${file}`);
    }
    const extracted = path.join(temp, 'verify'); await fs.mkdir(extracted);
    // npm pack only emits regular source files; still reject archive links before extraction.
    const detail = await run('/usr/bin/tar', ['-tvzf', archive], { signal: controller.signal });
    if (detail.split('\n').some(line => /^[lh]/.test(line))) throw new Error('插件包包含链接，不能发布');
    await run('/usr/bin/tar', ['-xzf', archive, '-C', extracted], { signal: controller.signal });
    const verified = await inspect(path.join(extracted, 'package'), { built: true });
    if (verified.errors.length) throw new Error(`打包遗漏必要文件：\n${verified.errors.join('\n')}`);
    const bytes = await fs.readFile(archive), digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const receipt = { name: initial.name, version: initial.version, createdAt: new Date().toISOString(), sha256: digest, size: bytes.length, files, warnings: verified.warnings, validation: 'DSH manifest, YAML and packed entry files checked. Runtime installation/loading not tested.', engines: initial.pkg.engines ?? {}, dependencies: initial.pkg.dependencies ?? {}, peerDependencies: initial.pkg.peerDependencies ?? {} };
    controller.signal.throwIfAborted();
    if ((await Promise.all(outputs.map(exists))).some(Boolean)) throw new Error(`输出文件已存在，请修改插件包名称：${filename}`);
    const created = [];
    try {
      await fs.writeFile(target, bytes, { flag: 'wx' }); created.push(target);
      await fs.writeFile(`${target}.sha256`, `${digest}  ${filename}\n`, { flag: 'wx' }); created.push(`${target}.sha256`);
      await fs.writeFile(`${target}.report.json`, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); created.push(`${target}.report.json`);
    } catch (error) {
      await Promise.all(created.map(file => fs.rm(file, { force: true })));
      throw error;
    }
    log(`\n生成成功：${target}\nSHA256：${digest}\n已验证包结构和入口。尚未验证 DSH 实际加载；安装时可能需要联网获取依赖。\n`);
    return { path: target, ...receipt };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await fs.rm(temp, { recursive: true, force: true }); }
}
module.exports = { inspect, buildPlugin, run, inside, outputFileName, suggestedFileName };
