const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { inspect, buildPlugin, suggestedFileName } = require('./core.cjs');
const { previewPlugin } = require('./preview.cjs');
const { profileCandidates, installedProfiles, findDshCli, verifyDshPackage } = require('./dsh-check.cjs');
const { discoverClients, installToClient } = require('./client-install.cjs');
let window, source, output, result, running, cli, targets = [];
function runtime() {
  const root = require('node:fs').existsSync(path.join(process.resourcesPath, 'runtime/bin/node')) ? path.join(process.resourcesPath, 'runtime') : path.join(__dirname, '..', '.runtime');
  return { node: path.join(root, 'bin/node'), bin: path.join(root, 'bin'), npm: path.join(root, 'npm/bin/npm-cli.js'), pnpm: path.join(root, 'pnpm/bin/pnpm.cjs') };
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window?.webContents || !event.senderFrame.url.startsWith('file:')) throw new Error('无效的调用来源');
    try { return { ok: true, value: await fn(...args) }; } catch (error) { return { ok: false, error: error.message }; }
  });
}
app.whenReady().then(() => {
  app.setName('DSH Plugin Builder');
  cli = findDshCli(app.getAppPath());
  window = new BrowserWindow({ width: 980, height: 790, minWidth: 780, minHeight: 680, title: 'DSH 插件打包工具', backgroundColor: '#f5f6f8', titleBarStyle: 'hiddenInset', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (!running) return;
    const choice = dialog.showMessageBoxSync(window, { type: 'question', message: '打包仍在进行，取消并退出？', buttons: ['继续打包', '取消并退出'], defaultId: 0, cancelId: 0 });
    if (choice === 0) event.preventDefault(); else running.abort();
  });
  handle('choose-source', async () => {
    if (running) throw new Error('请先等待打包结束');
    const selected = await dialog.showOpenDialog(window, { title: '选择包含 package.json 的源码目录', properties: ['openDirectory'] });
    if (selected.canceled) return null;
    const data = await inspect(selected.filePaths[0]); source = data.root; result = null;
    const { pkg, ...view } = data;
    return { ...view, suggestedName: suggestedFileName(data.name, data.version), installed: await installedProfiles(data.name, profileCandidates(app.getPath('appData'))) };
  });
  handle('preview', async () => {
    if (running) throw new Error('已有任务正在进行');
    if (!source) throw new Error('请先选择源码');
    running = new AbortController();
    try { return await previewPlugin({ source, runtime: runtime(), signal: running.signal }); }
    finally { running = null; }
  });
  handle('dsh-cli', () => cli);
  handle('choose-dsh-cli', async () => {
    if (running) throw new Error('请先等待当前任务结束');
    const selected = await dialog.showOpenDialog(window, { title: '选择 DSH CLI 的 bin.js 文件', properties: ['openFile'], filters: [{ name: 'JavaScript', extensions: ['js'] }] });
    if (!selected.canceled) cli = selected.filePaths[0];
    return cli;
  });
  handle('choose-output', async () => {
    if (running) throw new Error('请先等待打包结束');
    const selected = await dialog.showOpenDialog(window, { title: '选择插件包输出目录', defaultPath: app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled) return null;
    output = selected.filePaths[0]; return output;
  });
  handle('build', async options => {
    if (running) throw new Error('已有打包任务正在进行');
    if (!source || !output) throw new Error('请先选择源码和输出目录');
    if (!options || typeof options.build !== 'boolean' || typeof options.install !== 'boolean' || typeof options.fileName !== 'string') throw new Error('无效的打包选项');
    if (options.build) {
      const answer = await dialog.showMessageBox(window, { type: 'question', message: '允许执行此项目的构建脚本？', detail: '构建脚本以你的账户权限运行。请仅构建你信任的源码。依赖安装脚本保持禁用。', buttons: ['取消', '构建并打包'], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) throw new Error('已取消构建');
    }
    running = new AbortController(); result = null;
    const send = (kind, value) => { if (!window.isDestroyed()) window.webContents.send('progress', { kind, value }); };
    let currentPhase = '准备打包';
    try {
      result = await buildPlugin({ source, output, fileName: options.fileName, build: options.build, install: options.install, runtime: runtime(), signal: running.signal, log: value => send('log', value), phase: value => { currentPhase = value; send('phase', value); } });
      result.installed = await installedProfiles(result.name, profileCandidates(app.getPath('appData')));
      return result;
    } catch (error) { throw new Error(`${currentPhase}失败：${error.message}`); }
    finally { running = null; }
  });
  handle('verify-dsh', async options => {
    if (running) throw new Error('已有任务正在进行');
    if (!result) throw new Error('请先生成插件包');
    if (!cli) throw new Error('未找到 DSH CLI，请选择 DSH CLI 文件');
    if (!options || typeof options.offline !== 'boolean') throw new Error('无效的验证选项');
    const answer = await dialog.showMessageBox(window, {
      type: 'question', message: '在临时 DSH Profile 中运行此插件？',
      detail: '验证会执行插件代码，使用你的账户权限。Profile 数据单独存放并在结束后删除。请仅验证你信任的插件。',
      buttons: ['取消', '开始验证'], defaultId: 0, cancelId: 0,
    });
    if (answer.response !== 1) throw new Error('已取消 DSH 验证');
    running = new AbortController();
    const send = (kind, value) => { if (!window.isDestroyed()) window.webContents.send('progress', { kind, value }); };
    let currentPhase = '准备 DSH 验证';
    try {
      const checked = await verifyDshPackage({ archive: result.path, cli, runtime: runtime(), offline: options.offline, signal: running.signal, phase: value => { currentPhase = value; send('phase', value); }, log: value => send('log', value) });
      const reportPath = `${result.path}.report.json`;
      const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
      await fs.writeFile(reportPath, JSON.stringify({ ...report, runtimeCheck: checked }, null, 2) + '\n');
      return checked;
    }
    catch (error) { throw new Error(`${currentPhase}失败：${error.message}`); }
    finally { running = null; }
  });
  handle('find-clients', async () => {
    if (running) throw new Error('请先等待当前任务结束');
    targets = await discoverClients({ appData: app.getPath('appData') });
    return Promise.all(targets.map(async ({ id, name, version, appPath, profile, home }) => {
      const installed = result ? (await installedProfiles(result.name, [home]))[0] : null;
      return { id, name, version, appPath, profile, installed: installed ? installed.version ?? installed.spec : null };
    }));
  });
  handle('install-client', async id => {
    if (running) throw new Error('已有任务正在进行');
    if (!result) throw new Error('请先生成插件包');
    const target = targets.find(item => item.id === id);
    if (!target) throw new Error('请重新扫描并选择目标客户端');
    const answer = await dialog.showMessageBox(window, {
      type: 'question', message: `安装 ${result.name}@${result.version} 到 ${target.name}？`,
      detail: `目标 Profile：${target.profile}\n\n请先完全退出该客户端。安装会运行其内置 DSH 包管理器及插件安装脚本，可能下载依赖。已安装同名插件时不会自动卸载。`,
      buttons: ['取消', '安装到客户端'], defaultId: 0, cancelId: 0,
    });
    if (answer.response !== 1) throw new Error('已取消安装');
    running = new AbortController();
    const send = (kind, value) => { if (!window.isDestroyed()) window.webContents.send('progress', { kind, value }); };
    let currentPhase = '准备客户端安装';
    try {
      return await installToClient({ target, archive: result.path, name: result.name, version: result.version, sha256: result.sha256,
        signal: running.signal, phase: value => { currentPhase = value; send('phase', value); }, log: value => send('log', value) });
    } catch (error) { throw new Error(`${currentPhase}失败：${error.message}`); }
    finally { running = null; }
  });
  handle('cancel', () => { running?.abort(); });
  handle('reveal', () => { if (result) shell.showItemInFolder(result.path); });
  handle('copy-path', () => {
    if (!result) throw new Error('请先生成插件包');
    clipboard.writeText(result.path);
    return result.path;
  });
  window.loadFile(path.join(__dirname, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
