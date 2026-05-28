import { BrowserWindow, app } from "electron";
import { resolve } from "node:path";

import { registerIpcHandlers } from "./ipcHandlers";

let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 820,
    minHeight: 620,
    title: "Lunace Tether Setup",
    backgroundColor: "#000000",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolve(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // In dev: dist/main/main.js -> ../../renderer/index.html (installer root).
  // When packaged, electron-builder copies the renderer folder verbatim
  // (via the "files" glob) into Resources/app/renderer/index.html, which
  // is also reachable as ../../renderer/index.html from dist/main/.
  const rendererIndex = resolve(__dirname, "..", "..", "renderer", "index.html");
  await mainWindow.loadFile(rendererIndex);
}

app.whenReady().then(async () => {
  // Where to look for the bundled .mcpb. In dev, walk up from the installer
  // directory to find it at the repo root. When packaged, electron-builder
  // copies it to process.resourcesPath via extraResources.
  const resourcesPath = app.isPackaged ? process.resourcesPath : resolve(__dirname, "..", "..", "..");
  registerIpcHandlers({
    resourcesPath,
    appPath: app.getAppPath(),
    appDataPath: app.getPath("appData"),
    quit: () => app.quit(),
  });
  await createWindow();
});

app.on("window-all-closed", () => {
  // Standard mac convention: keep app alive in dock when all windows close.
  // For a one-shot installer we just quit on all platforms.
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
