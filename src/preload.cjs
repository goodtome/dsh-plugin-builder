const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('builder', {
  chooseSource: () => ipcRenderer.invoke('choose-source'),
  preview: () => ipcRenderer.invoke('preview'),
  dshCli: () => ipcRenderer.invoke('dsh-cli'),
  chooseDshCli: () => ipcRenderer.invoke('choose-dsh-cli'),
  verifyDsh: options => ipcRenderer.invoke('verify-dsh', options),
  findClients: () => ipcRenderer.invoke('find-clients'),
  installClient: id => ipcRenderer.invoke('install-client', id),
  chooseOutput: () => ipcRenderer.invoke('choose-output'),
  build: options => ipcRenderer.invoke('build', options),
  cancel: () => ipcRenderer.invoke('cancel'),
  reveal: () => ipcRenderer.invoke('reveal'),
  copyPath: () => ipcRenderer.invoke('copy-path'),
  onProgress: callback => ipcRenderer.on('progress', (_, progress) => callback(progress))
});
