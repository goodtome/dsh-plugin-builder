const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { possibleHomes, discoverClients, installToClient } = require('../src/client-install.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-client-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appData = path.join(root, 'Application Support'), applications = path.join(root, 'Applications');
  const app = path.join(applications, 'Example.app'), contents = path.join(app, 'Contents');
  const binary = path.join(contents, 'MacOS/Example');
  const profile = path.join(appData, 'Example', 'dsh-home/profiles/desktop');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.mkdir(path.join(contents, 'Resources/runtime/cli/bin'), { recursive: true });
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.dsh</string><key>CFBundleExecutable</key><string>Example</string><key>CFBundleName</key><string>Example</string><key>CFBundleShortVersionString</key><string>1.0.0</string></dict></plist>`);
  await fs.writeFile(path.join(contents, 'Resources/app.asar'), 'fixture');
  await fs.writeFile(path.join(contents, 'Resources/runtime/cli/bin/dsh'), '#!/bin/sh\n# @deepseek-ai/dsh-desktop-host/lib/cli.js\n');
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ dependencies: {} }));
  await fs.writeFile(path.join(profile, 'cordis.yml'), 'plugins: {}\n');
  await fs.writeFile(binary, `#!/usr/bin/env node\nconst fs=require('node:fs');const path=require('node:path');const profile=path.join(process.env.DSH_HOME,'profiles/desktop');const pkg=JSON.parse(fs.readFileSync(path.join(profile,'package.json')));pkg.dependencies['example-plugin']='file:fixture.tgz';fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify(pkg));const folder=path.join(profile,'node_modules/example-plugin');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'package.json'),JSON.stringify({version:'1.2.3'}));`);
  await fs.chmod(binary, 0o755);
  return { root, appData, applications, app, profile };
}

test('detects only initialized DSH client applications', async t => {
  const f = await fixture(t);
  const targets = await discoverClients({ appData: f.appData, home: f.root, directories: [f.applications] });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, 'Example');
  assert.equal(targets[0].profile, f.profile);
  assert.equal(possibleHomes('AlphaTrust', 'com.alphatrust.kaiwu.client', f.appData, f.root).length, 2);
  await fs.rm(path.join(f.profile, 'cordis.yml'));
  assert.deepEqual(await discoverClients({ appData: f.appData, home: f.root, directories: [f.applications] }), []);
});

test('installs to selected client only, verifies identity and refuses repeat install', async t => {
  const f = await fixture(t);
  const target = (await discoverClients({ appData: f.appData, home: f.root, directories: [f.applications] }))[0];
  const archive = path.join(f.root, 'other-filename.tgz');
  const bytes = Buffer.from('synthetic archive'); await fs.writeFile(archive, bytes);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const result = await installToClient({ target, archive, name: 'example-plugin', version: '1.2.3', sha256 });
  assert.equal(result.profile, f.profile);
  assert.equal(result.version, '1.2.3');
  await assert.rejects(installToClient({ target, archive, name: 'example-plugin', version: '1.2.3', sha256 }), /已安装/);
});

test('rejects archive modified after export', async t => {
  const f = await fixture(t);
  const target = (await discoverClients({ appData: f.appData, home: f.root, directories: [f.applications] }))[0];
  const archive = path.join(f.root, 'sample.tgz'); await fs.writeFile(archive, 'changed');
  await assert.rejects(installToClient({ target, archive, name: 'example-plugin', version: '1.2.3', sha256: '0'.repeat(64) }), /已变化/);
});
