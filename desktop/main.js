import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from "electron";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const dashboardUrl = "http://localhost:7777";
const hiddenLaunch = process.argv.includes("--hidden");
const appRoot = app.getAppPath();
const iconPath = join(appRoot, "build", "icon.png");

let mainWindow = null;
let tray = null;
let isQuitting = false;
let ownedServer = null;
let preferences = { launchAtStartup: true };

function showWindow() {
  if (!mainWindow) return;
  mainWindow.setSkipTaskbar(false);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideWindow() {
  if (!mainWindow) return;
  mainWindow.hide();
  mainWindow.setSkipTaskbar(true);
}

function startupShortcutOptions() {
  return {
    target: process.execPath,
    args: app.isPackaged ? "--hidden" : `\"${appRoot}\" --hidden`,
    cwd: app.isPackaged ? dirname(process.execPath) : appRoot,
    description: "Rocketman project control",
    icon: app.isPackaged ? process.execPath : iconPath,
    iconIndex: 0,
  };
}

async function applyStartupShortcut(enabled) {
  const shortcutPath = join(
    app.getPath("appData"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "Rocketman.lnk",
  );
  await mkdir(dirname(shortcutPath), { recursive: true });
  if (enabled) {
    const written = shell.writeShortcutLink(shortcutPath, startupShortcutOptions());
    if (!written) throw new Error("Windows did not create the Rocketman startup shortcut.");
    return;
  }
  await unlink(shortcutPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function savePreferences() {
  const path = join(app.getPath("userData"), "desktop-settings.json");
  await writeFile(path, JSON.stringify(preferences, null, 2), "utf8");
}

async function setLaunchAtStartup(enabled) {
  preferences.launchAtStartup = enabled;
  await applyStartupShortcut(enabled);
  await savePreferences();
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Rocketman", click: showWindow },
    { type: "separator" },
    {
      label: "Launch at startup",
      type: "checkbox",
      checked: preferences.launchAtStartup,
      click: (item) => void setLaunchAtStartup(item.checked),
    },
    { type: "separator" },
    {
      label: "Quit Rocketman",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

async function loadPreferences() {
  const userData = app.getPath("userData");
  const path = join(userData, "desktop-settings.json");
  await mkdir(userData, { recursive: true });
  try {
    preferences = { ...preferences, ...JSON.parse(await readFile(path, "utf8")) };
  } catch {
    await savePreferences();
  }
  await applyStartupShortcut(preferences.launchAtStartup);
}

async function ensureDesktopData() {
  const userData = app.getPath("userData");
  const configPath = join(userData, "projects.json");
  const dataPath = join(userData, "data");
  await mkdir(dataPath, { recursive: true });
  if (!existsSync(configPath)) {
    await copyFile(join(appRoot, "projects.json"), configPath);
  }
  process.env.ROCKETMAN_CONFIG_PATH = configPath;
  process.env.ROCKETMAN_DATA_DIR = dataPath;
}

async function dashboardIsRunning() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`${dashboardUrl}/api/health`, { signal: controller.signal });
    const body = await response.json();
    return response.ok && body?.name === "rocketman";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureDashboardServer() {
  if (await dashboardIsRunning()) return;
  const { startRocketmanServer } = await import("../server.js");
  const started = await startRocketmanServer({ openBrowser: false });
  ownedServer = started.server;
}

function createTray() {
  const image = nativeImage.createFromPath(iconPath).resize({ width: 24, height: 24 });
  tray = new Tray(image);
  tray.setToolTip("Rocketman project control");
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
  rebuildTrayMenu();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "Rocketman",
    width: 1420,
    height: 900,
    minWidth: 940,
    minHeight: 650,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f4f7fb",
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(dashboardUrl);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(dashboardUrl)) event.preventDefault();
  });
  mainWindow.on("page-title-updated", (event) => event.preventDefault());
  mainWindow.on("minimize", (event) => {
    event.preventDefault();
    hideWindow();
  });
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hideWindow();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.once("ready-to-show", () => {
    if (!hiddenLaunch) showWindow();
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("before-quit", () => {
    isQuitting = true;
  });
  app.on("window-all-closed", () => {});

  app.whenReady().then(async () => {
    app.setAppUserModelId("com.rocketman.projectcontrol");
    await loadPreferences();
    await ensureDesktopData();
    await ensureDashboardServer();
    createTray();
    createWindow();
  }).catch((error) => {
    console.error(error);
    app.quit();
  });
}

process.on("exit", () => {
  if (ownedServer?.listening) ownedServer.close();
});
