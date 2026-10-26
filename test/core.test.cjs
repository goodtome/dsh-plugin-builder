const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inspect, buildPlugin, outputFileName, suggestedFileName } = require('../src/core.cjs');
const runtimeRoot = path.resolve(__dirname, '../.runtime');
const runtime = { node: path.join(runtimeRoot, 'bin/node'), bin: path.join(runtimeRoot, 'bin'), npm: path.join(runtimeRoot, 'npm/bin/npm-cli.js'), pnpm: path.join(runtimeRoot, 'pnpm/bin/pnpm.cjs') };
async function fixture(t, change = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), output = path.join(root, 'output');
  await fs.mkdir(source); await fs.mkdir(output);
  const pkg = { name: '@test/sample', version: '1.0.0', type: 'module', main: './index.js', files: ['index.js', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } }, ...change };
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify(pkg));
  await fs.writeFile(path.join(source, 'index.js'), 'export default {};');
  await fs.writeFile(path.join(source, 'cordis.patch.yml'), '- insert:\n    - id: sample\n      name: "@test/sample"\n');
  return { source, output, runtime };
}
test('packs actual npm tarball, excludes env, preserves source, writes digest and report', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.source, '.env'), 'TOKEN=never-pack');
  const before = await fs.readFile(path.join(f.source, 'package.json'), 'utf8');
  const result = await buildPlugin(f);
  assert.equal(result.sha256.length, 64); assert.ok(result.files.includes('package/index.js'));
  assert.ok(!result.files.some(file => file.includes('.env')));
  assert.equal(await fs.readFile(path.join(f.source, 'package.json'), 'utf8'), before);
  assert.ok(await fs.stat(`${result.path}.report.json`));
  const second = await buildPlugin({ ...f, fileName: '自定义插件包.tgz' });
  assert.equal(path.basename(second.path), '自定义插件包.tgz');
  assert.equal((await fs.readFile(`${second.path}.sha256`, 'utf8')).split('  ')[1].trim(), '自定义插件包.tgz');
  assert.equal(JSON.parse(await fs.readFile(`${second.path}.report.json`, 'utf8')).name, '@test/sample');
});
test('rejects missing DSH declarations and workspace dependencies', async t => {
  const f = await fixture(t, { dsh: {}, dependencies: { foo: 'workspace:*' } });
  const data = await inspect(f.source); assert.equal(data.errors.length, 2);
  await assert.rejects(buildPlugin(f), /dsh.bundle.patch/);
});
test('detects files omitted by npm files whitelist', async t => {
  const f = await fixture(t, { files: ['index.js'] });
  await assert.rejects(buildPlugin(f), /打包遗漏必要文件/); assert.deepEqual(await fs.readdir(f.output), []);
});
test('rejects output inside source and patch traversal', async t => {
  const f = await fixture(t); await assert.rejects(buildPlugin({ ...f, output: f.source }), /源码目录之外/);
  const pkg = JSON.parse(await fs.readFile(path.join(f.source, 'package.json'))); pkg.dsh.bundle.patch = '../outside.yml';
  await fs.writeFile(path.join(f.source, 'package.json'), JSON.stringify(pkg));
  assert.ok((await inspect(f.source)).errors.some(error => error.includes('超出源码目录')));
});
test('does not execute prepare/prepack lifecycle hooks', async t => {
  const f = await fixture(t, { scripts: { prepack: 'node -e "process.exit(99)"', prepare: 'node -e "process.exit(99)"' } });
  assert.ok((await buildPlugin(f)).path.endsWith('.tgz'));
});
test('build failure and cancellation publish no archive', async t => {
  const f = await fixture(t, { scripts: { build: 'node -e "process.exit(9)"' } });
  await assert.rejects(buildPlugin({ ...f, build: true }), /执行失败/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(buildPlugin({ ...f, signal: controller.signal }));
  assert.deepEqual(await fs.readdir(f.output), []);
});
test('defaults to package name and version, and refuses to overwrite any output', async t => {
  const f = await fixture(t);
  assert.equal(suggestedFileName('@test/sample', '1.0.0'), 'test-sample-1.0.0');
  const result = await buildPlugin(f);
  assert.equal(path.basename(result.path), 'test-sample-1.0.0.tgz');
  await assert.rejects(buildPlugin(f), /输出文件已存在/);
  assert.equal((await fs.readFile(result.path)).length, result.size);
  await fs.writeFile(path.join(f.output, 'other.tgz.report.json'), 'keep');
  await assert.rejects(buildPlugin({ ...f, fileName: 'other' }), /输出文件已存在/);
  assert.equal(await fs.readFile(path.join(f.output, 'other.tgz.report.json'), 'utf8'), 'keep');
});
test('rejects unsafe custom archive names', () => {
  for (const name of ['', '   ', '../bad', 'a/b', 'a\\b', '.hidden', 'a:', 'a\n', 'x'.repeat(121)]) {
    assert.throws(() => outputFileName(name));
  }
  assert.equal(outputFileName(' 插件甲.tgz '), '插件甲.tgz');
});
