const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("workbench", {
  request: (op, args) => ipcRenderer.invoke("workbench:request", op, args),
  chooseFile: () => ipcRenderer.invoke("workbench:file"),
});
