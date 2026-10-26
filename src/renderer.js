const $ = id => document.getElementById(id);
let project = null, output = null, preview = null, result = null, cli = null, busy = false, clients = [];
function failure(error) { $('error').textContent = error; $('error').hidden = false; }
function update() {
  $('pack').disabled = busy || !project || project.errors.length > 0 || !output || !preview || preview.risks.length > 0 || !$('filename').value.trim();
  $('source').disabled = $('output').disabled = busy;
  $('preview').disabled = busy || !project || project.errors.length > 0;
  $('filename').disabled = busy || !project;
  $('build').disabled = busy || !project?.build;
  $('install').disabled = busy || !$('build').checked;
  $('verify').disabled = busy || !result || !cli;
  $('choose-cli').disabled = busy;
  $('refresh-clients').disabled = busy;
  $('client-target').disabled = busy || !clients.length;
  $('install-client').disabled = busy || !result || !$('client-target').value || Boolean(clients.find(item => item.id === $('client-target').value)?.installed);
  $('cancel').hidden = !busy;
}
async function unwrap(promise) { const response = await promise; if (!response.ok) throw new Error(response.error); return response.value; }
function installedText(rows) {
  return rows.length ? `已在 ${rows.length} 个常见 Desktop Profile 发现同名插件。安装新版前，请在对应 DSH 中卸载旧版：\n${rows.map(row => `${row.version ?? row.spec} · ${row.profile}`).join('\n')}` : '常见 Desktop Profile 中未发现同名插件。其他位置的 Profile 未检查。';
}
function formatSize(bytes) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`; }
function resetPreview() {
  preview = null; $('preview-summary').textContent = '先检查会进入插件包的文件，再生成。';
  $('preview-origins').textContent = ''; $('preview-risks').hidden = $('preview-list').hidden = true;
  $('preview-files').replaceChildren();
}
async function refreshClients() {
  try {
    clients = await unwrap(window.builder.findClients());
    $('client-target').replaceChildren();
    for (const client of clients) {
      const option = document.createElement('option'); option.value = client.id;
      option.textContent = `${client.name}${client.version ? ` ${client.version}` : ''}${client.installed ? `（已安装 ${client.installed}）` : ''} · ${client.profile}`;
      $('client-target').append(option);
    }
    $('client-status').textContent = clients.length ? `找到 ${clients.length} 个可选客户端 Profile。已安装同名插件的目标需先在客户端卸载旧版。` : '未找到已初始化的 DSH 架构客户端。请先启动一次客户端，再重新扫描。';
  } catch (error) { clients = []; $('client-target').replaceChildren(); $('client-status').textContent = `扫描失败：${error.message}`; }
  update();
}
$('source').onclick = async () => {
  try {
    const data = await unwrap(window.builder.chooseSource()); if (!data) return;
    project = data; result = null; clients = []; resetPreview(); $('error').hidden = $('result').hidden = $('verify-panel').hidden = $('client-panel').hidden = true;
    $('empty').hidden = true; $('project').hidden = false;
    $('name').textContent = data.name ?? '未命名项目'; $('version').textContent = data.version ?? '';
    $('source-path').textContent = data.root; $('description').textContent = data.description;
    $('installed').textContent = installedText(data.installed);
    $('checks').replaceChildren();
    const lines = [...data.errors.map(text => ['bad', text]), ...data.warnings.map(text => ['warn', text])];
    if (!data.errors.length) lines.unshift(['good', 'DSH 组合包声明有效，可以预览打包文件']);
    for (const [kind, text] of lines) { const row = document.createElement('div'); row.className = `check ${kind}`; row.textContent = text; $('checks').append(row); }
    $('build').checked = Boolean(data.build); $('install').checked = false;
    $('filename').value = data.suggestedName;
    $('build-note').textContent = data.build ? `${data.manager} run build；在临时副本中执行` : '项目没有 build 脚本，直接打包已有文件';
    $('status').textContent = data.errors.length ? '请修复检查项后重新导入。' : '请预览打包文件。'; update();
  } catch (error) { failure(error.message); }
};
$('output').onclick = async () => { try { const value = await unwrap(window.builder.chooseOutput()); if (value) { output = value; $('output-path').textContent = value; update(); } } catch (error) { failure(error.message); } };
$('filename').oninput = () => { $('error').hidden = true; update(); };
$('build').onchange = () => { if (!$('build').checked) $('install').checked = false; update(); };
$('preview').onclick = async () => {
  busy = true; $('error').hidden = true; $('status').textContent = '正在预览发布文件…'; update();
  try {
    preview = await unwrap(window.builder.preview());
    $('preview-summary').textContent = `${preview.files.length} 个文件，预计压缩后 ${formatSize(preview.estimatedSize)}。${preview.warning ?? ''}`;
    const origins = preview.origins;
    $('preview-origins').textContent = `依赖来源：注册表 ${origins.registry}、Git/URL ${origins.gitOrUrl}、本地 ${origins.local}、DSH peer ${origins.peer}。实际下载源由项目的 npm/pnpm 配置决定。`;
    $('preview-files').replaceChildren();
    for (const file of preview.files) {
      const item = document.createElement('li'), name = document.createElement('span'), size = document.createElement('span');
      name.textContent = file.path; size.textContent = formatSize(file.size); item.append(name, size); $('preview-files').append(item);
    }
    $('preview-list').hidden = false;
    if (preview.risks.length) {
      $('preview-risks').textContent = `发现可能含凭据的文件，已阻止打包：${preview.risks.join('、')}`;
      $('preview-risks').hidden = false;
    }
    $('status').textContent = preview.risks.length ? '请从发布文件中排除敏感文件后重新预览。' : output ? '预览完成，可以生成插件包。' : '预览完成，请选择输出位置。';
  } catch (error) { preview = null; failure(`预览文件失败：${error.message}`); $('status').textContent = '预览失败。'; }
  finally { busy = false; update(); }
};
$('pack').onclick = async () => {
  busy = true; result = null; clients = []; $('error').hidden = $('result').hidden = $('verify-panel').hidden = $('client-panel').hidden = $('copy-feedback').hidden = true;
  $('copy').textContent = '复制安装路径'; $('log').textContent = ''; $('logs').open = true; $('log-state').textContent = '进行中'; $('status').textContent = '正在准备…'; $('phase').hidden = false; update();
  try {
    result = await unwrap(window.builder.build({ fileName: $('filename').value, build: $('build').checked, install: $('install').checked }));
    $('result').hidden = $('verify-panel').hidden = $('client-panel').hidden = false; $('result-file').textContent = result.path;
    $('result-identity').textContent = `包内插件身份：${result.name}@${result.version}`;
    $('result-meta').textContent = `${result.files.length} 个归档条目 · ${formatSize(result.size)} · 已检查包结构与入口`;
    $('installed').textContent = installedText(result.installed);
    $('status').textContent = '包已生成。可以选择本机客户端直接安装，或复制路径。'; $('log-state').textContent = '已完成';
    $('cli-status').textContent = cli ? '已找到 DSH CLI，可验证实际加载。' : '未找到 DSH CLI。请选择已构建的 DSH CLI bin.js 文件。';
    $('verify-status').textContent = '未验证，当前仅通过结构检查。';
    await refreshClients();
    $('result').scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  } catch (error) { failure(error.message); $('status').textContent = '未生成插件包，请查看失败阶段和日志。'; $('log-state').textContent = '已停止'; }
  finally { busy = false; update(); }
};
$('refresh-clients').onclick = refreshClients;
$('client-target').onchange = () => {
  const selected = clients.find(item => item.id === $('client-target').value);
  $('client-status').textContent = selected?.installed ? `${selected.name} 已安装同名插件 ${selected.installed}。请先在该客户端卸载旧版。` : '请完全退出所选客户端，再点击安装。';
  update();
};
$('install-client').onclick = async () => {
  busy = true; $('error').hidden = true; $('logs').open = true; $('log-state').textContent = '安装中';
  $('client-status').textContent = '正在安装到所选客户端…'; update();
  try {
    const installed = await unwrap(window.builder.installClient($('client-target').value));
    const selected = clients.find(item => item.id === $('client-target').value);
    if (selected) selected.installed = installed.version;
    $('client-status').textContent = `${installed.client} 已安装 ${installed.name}@${installed.version}。重新打开客户端即可使用。`;
    $('status').textContent = '客户端安装完成。'; $('log-state').textContent = '安装完成';
  } catch (error) { failure(error.message); $('client-status').textContent = '客户端安装未完成，请查看错误和日志。'; $('log-state').textContent = '安装失败'; }
  finally { busy = false; update(); }
};
$('choose-cli').onclick = async () => {
  try { cli = await unwrap(window.builder.chooseDshCli()); $('cli-status').textContent = cli ? `DSH CLI：${cli}` : '未找到 DSH CLI'; update(); }
  catch (error) { failure(error.message); }
};
$('verify').onclick = async () => {
  busy = true; $('error').hidden = true; $('logs').open = true; $('log-state').textContent = '验证中'; $('verify-status').textContent = '正在使用临时 DSH Profile 验证…'; $('log').textContent += '\nDSH 临时验证开始\n'; update();
  try {
    const checked = await unwrap(window.builder.verifyDsh({ offline: $('offline').checked }));
    $('verify-status').textContent = `DSH ${checked.version} 临时安装、配置组合及 Web Host 启动通过。浏览器交互未验证。`;
    $('status').textContent = 'DSH 临时验证通过，可以复制安装路径。'; $('log-state').textContent = '验证通过';
  } catch (error) { $('verify-status').textContent = 'DSH 临时验证未通过。生成的插件包仍保留。'; failure(error.message); $('log-state').textContent = '验证失败'; }
  finally { busy = false; update(); }
};
$('cancel').onclick = () => { window.builder.cancel(); $('status').textContent = '正在取消…'; };
$('reveal').onclick = () => window.builder.reveal();
$('copy').onclick = async () => {
  try {
    const copied = await unwrap(window.builder.copyPath());
    if (copied !== $('result-file').textContent) throw new Error('复制的路径与当前插件包不一致，请重新生成');
    $('copy').textContent = '路径已复制';
    $('copy-feedback').textContent = '已复制 .tgz 文件的完整路径。打开 DSH 插件安装页面，粘贴并安装。';
    $('copy-feedback').hidden = false;
  } catch (error) { failure(error.message); }
};
window.builder.onProgress(({ kind, value }) => {
  if (kind === 'phase') { $('phase').hidden = false; $('phase').textContent = `当前阶段：${value}`; $('status').textContent = value; }
  else { $('log').textContent = ($('log').textContent + value).slice(-160000); $('log').scrollTop = $('log').scrollHeight; }
});
void unwrap(window.builder.dshCli()).then(value => { cli = value; update(); }).catch(() => {});
