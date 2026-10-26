const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { previewPlugin, dependencyOrigins, sensitiveFile } = require('../src/preview.cjs');
const { profileCandidates, installedProfiles, redact, waitForWebReady, verifyDshPackage } = require('../src/dsh-check.cjs');

const runtimeRoot = path.resolve(__dirname, '../.runtime');
const runtime = { node: path.join(runtimeRoot, 'bin/node'), bin: path.join(runtimeRoot, 'bin'), npm: path.join(runtimeRoot, 'npm/bin/npm-cli.js') };
async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-workflow-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('finds installed identities in distinct Desktop profiles', async t => {
  const root = await tempRoot(t);
  const homes = profileCandidates(path.join(root, 'Application Support'), { DSH_HOME: path.join(root, 'custom') }, root);
  assert.equal(homes.length, 4);
  const profile = path.join(homes[0], 'profiles/desktop');
  await fs.mkdir(path.join(profile, 'node_modules/@test/sample'), { recursive: true });
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ dependencies: { '@test/sample': 'file:/tmp/other-name.tgz' }, dsh: { profile: { bundles: ['@test/sample'] } } }));
  await fs.writeFile(path.join(profile, 'node_modules/@test/sample/package.json'), JSON.stringify({ version: '1.0.3' }));
  assert.deepEqual(await installedProfiles('@test/sample', homes), [{ profile, spec: 'file:/tmp/other-name.tgz', version: '1.0.3', enabled: true }]);
  assert.deepEqual(await installedProfiles('other', homes), []);
});

test('previews npm files, sizes, dependency origins and sensitive names', async t => {
  const root = await tempRoot(t);
  const pkg = { name: 'preview-sample', version: '1.0.0', main: 'index.js', files: ['index.js', 'cordis.patch.yml', 'secret.pem'], dsh: { bundle: { patch: 'cordis.patch.yml' } }, dependencies: { a: '^1', b: 'https://example.invalid/b.tgz' }, peerDependencies: { dsh: '*' } };
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
  await fs.writeFile(path.join(root, 'index.js'), 'module.exports = {};');
  await fs.writeFile(path.join(root, 'cordis.patch.yml'), '- insert: []\n');
  await fs.writeFile(path.join(root, 'secret.pem'), 'placeholder');
  const preview = await previewPlugin({ source: root, runtime });
  assert.ok(preview.files.some(file => file.path === 'secret.pem'));
  assert.deepEqual(preview.risks, ['secret.pem']);
  assert.ok(preview.estimatedSize > 0);
  assert.deepEqual(preview.origins, { registry: 1, gitOrUrl: 1, local: 0, peer: 1 });
  assert.equal(sensitiveFile('.env.production'), true);
  assert.equal(sensitiveFile('.env.example'), false);
  assert.equal(dependencyOrigins({ dependencies: { x: 'file:../x' } }).local, 1);
});

test('waits for Web Host process exit and redacts token from failures', async t => {
  const root = await tempRoot(t);
  const cli = path.join(root, 'web.cjs');
  const marker = path.join(root, 'closed');
  await fs.writeFile(cli, `process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes'); process.exit(0); }); console.log('dsh web: http://127.0.0.1:1234/?token=private'); setInterval(() => {}, 1000);`);
  assert.deepEqual(await waitForWebReady(process.execPath, [cli], { timeoutMs: 5000 }), { started: true });
  assert.equal(await fs.readFile(marker, 'utf8'), 'yes');
  assert.equal(redact('url?token=private&x=1'), 'url?token=[redacted]&x=1');
});

test('verifies with isolated profile and removes it after shutdown', async t => {
  const root = await tempRoot(t);
  const cli = path.join(root, 'fake-cli.cjs'), archive = path.join(root, 'sample.tgz'), marker = path.join(root, 'profile-path');
  await fs.writeFile(archive, 'synthetic archive');
  await fs.writeFile(cli, `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('1.2.3');
else if (args.includes('add')) { fs.mkdirSync(process.env.DSH_HOME, { recursive: true }); fs.writeFileSync(${JSON.stringify(marker)}, process.env.DSH_HOME); }
else if (args.includes('--dump-config')) { if (!fs.existsSync(${JSON.stringify(marker)})) process.exit(2); }
else if (args.includes('web')) { process.on('SIGTERM', () => process.exit(0)); console.log('dsh web: http://127.0.0.1:1234/?token=private'); setInterval(() => {}, 1000); }
`);
  const phases = [];
  const result = await verifyDshPackage({ archive, cli, runtime, phase: value => phases.push(value) });
  assert.equal(result.status, 'passed');
  assert.ok(phases.includes('启动 DSH Web Host'));
  await assert.rejects(fs.stat(await fs.readFile(marker, 'utf8')), { code: 'ENOENT' });
});
