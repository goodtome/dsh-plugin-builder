const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = __dirname;
const repo = path.resolve(root, '../..');
const engine = path.join(repo, 'engines/dsh');
async function copyDependency(name, destination, seen = new Set(), from = engine) {
  if (seen.has(name)) return; seen.add(name);
  const pkgPath = require.resolve(`${name}/package.json`, { paths: [from] });
  const source = path.dirname(pkgPath), pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  await fs.cp(source, path.join(destination, name), { recursive: true, dereference: true });
  for (const dependency of Object.keys(pkg.dependencies ?? {})) await copyDependency(dependency, destination, seen, source);
}
(async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('当前打包脚本仅生成 Apple Silicon Mac 版本');
  const runtime = path.join(root, '.runtime');
  await fs.mkdir(path.join(runtime, 'bin'), { recursive: true });
  await fs.copyFile(process.execPath, path.join(runtime, 'bin/node'));
  await fs.chmod(path.join(runtime, 'bin/node'), 0o755);
  const npmRoot = path.resolve(path.dirname(await fs.realpath(execFileSync('/usr/bin/which', ['npm'], { encoding: 'utf8' }).trim())), '..');
  await fs.cp(npmRoot, path.join(runtime, 'npm'), { recursive: true, dereference: true });
  const pnpmRoot = await fs.realpath(path.join(engine, 'node_modules/pnpm'));
  await fs.cp(pnpmRoot, path.join(runtime, 'pnpm'), { recursive: true, dereference: true });
  for (const [name, target] of [['npm', '../npm/bin/npm-cli.js'], ['npx', '../npm/bin/npx-cli.js'], ['pnpm', '../pnpm/bin/pnpm.cjs']]) {
    const file = path.join(runtime, 'bin', name); await fs.rm(file, { force: true }); await fs.symlink(target, file);
  }
  const modules = path.join(root, 'node_modules');
  await fs.mkdir(modules, { recursive: true });
  const seen = new Set(); for (const name of ['js-yaml', 'semver']) await copyDependency(name, modules, seen);
  const output = path.join(root, 'dist'); await fs.mkdir(output, { recursive: true });
  const app = path.join(output, 'DSH Plugin Builder.app');
  // Refresh only this tool's generated bundle.
  await fs.rm(app, { recursive: true, force: true });
  const electronRoot = path.dirname(require.resolve('electron/package.json', { paths: [path.join(engine, 'apps/desktop')] }));
  await fs.cp(path.join(electronRoot, 'dist/Electron.app'), app, { recursive: true, verbatimSymlinks: true });
  const resources = path.join(app, 'Contents/Resources');
  const application = path.join(resources, 'app'); await fs.mkdir(application, { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(application, 'src'), { recursive: true });
  await fs.copyFile(path.join(root, 'package.json'), path.join(application, 'package.json'));
  await fs.cp(modules, path.join(application, 'node_modules'), { recursive: true, dereference: true });
  await fs.cp(runtime, path.join(resources, 'runtime'), { recursive: true, verbatimSymlinks: true });
  await fs.rm(path.join(resources, 'default_app.asar'), { force: true });
  await fs.rename(path.join(app, 'Contents/MacOS/Electron'), path.join(app, 'Contents/MacOS/DSH Plugin Builder'));
  const plist = path.join(app, 'Contents/Info.plist');
  for (const [key, value] of Object.entries({ CFBundleExecutable: 'DSH Plugin Builder', CFBundleDisplayName: 'DSH Plugin Builder', CFBundleName: 'DSH Plugin Builder', CFBundleIdentifier: 'com.alphatrust.dsh-plugin-builder', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1', LSApplicationCategoryType: 'public.app-category.developer-tools' })) execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log(app);
})().catch(error => { console.error(error); process.exitCode = 1; });
