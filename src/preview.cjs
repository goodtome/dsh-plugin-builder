const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inspect, run } = require('./core.cjs');

function dependencyOrigins(pkg) {
  const groups = { registry: 0, gitOrUrl: 0, local: 0, peer: 0 };
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (/^(?:https?:|git\+|git@|github:|gitlab:)/iu.test(version)) groups.gitOrUrl++;
    else if (/^(?:file:|link:|workspace:|\.?\.?\/)/iu.test(version)) groups.local++;
    else groups.registry++;
  }
  groups.peer = Object.keys(pkg.peerDependencies ?? {}).length;
  return groups;
}
function sensitiveFile(file) {
  return /(^|\/)(?:\.env(?:\.[^/]+)?|id_rsa|id_ed25519|[^/]+\.(?:pem|key|p12|pfx))$/iu.test(file) && !file.endsWith('.example');
}
async function previewPlugin({ source, runtime, signal, log = () => {} }) {
  const inspected = await inspect(source);
  if (inspected.errors.length) throw new Error(inspected.errors.join('\n'));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-preview-'));
  try {
    const env = { ...process.env, PATH: `${runtime.bin}${path.delimiter}${process.env.PATH ?? ''}`, npm_config_cache: path.join(temp, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false' };
    const output = await run(runtime.node, [runtime.npm, 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: inspected.root, env, signal, log });
    const parsed = JSON.parse(output)[0];
    if (!parsed || !Array.isArray(parsed.files)) throw new Error('npm 未返回可用的文件清单');
    const files = parsed.files.map(item => ({ path: item.path, size: item.size }));
    const risks = files.filter(item => sensitiveFile(item.path)).map(item => item.path);
    return {
      name: inspected.name, version: inspected.version, files,
      estimatedSize: parsed.size, unpackedSize: parsed.unpackedSize,
      risks, origins: dependencyOrigins(inspected.pkg),
      warning: inspected.build ? '这是当前源码文件预览。运行 build 后，实际文件清单可能变化。' : null,
    };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
module.exports = { previewPlugin, dependencyOrigins, sensitiveFile };
