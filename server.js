import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { watch } from "node:fs";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const baseDir = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(baseDir, "public");
const threeDir = join(baseDir, "node_modules", "three");
const dataDir = process.env.ROCKETMAN_DATA_DIR
  ? resolve(process.env.ROCKETMAN_DATA_DIR)
  : join(baseDir, "data");
const generatedDir = join(dataDir, "generated");
const configPath = process.env.ROCKETMAN_CONFIG_PATH
  ? resolve(process.env.ROCKETMAN_CONFIG_PATH)
  : join(baseDir, "projects.json");
const statePath = join(dataDir, "state.json");
const condaActivatePath = join(baseDir, "scripts", "conda-activate.cmd");
const host = "localhost";
const port = 7777;
const bootId = String(Date.now());
const liveReloadClients = new Set();
let reloadTimer = null;
let lifecycleQueue = Promise.resolve();
let configQueue = Promise.resolve();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function saveJson(path, payload) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
}

function sendLiveReload(reason) {
  const payload = `event: reload\ndata: ${JSON.stringify({ reason, bootId })}\n\n`;
  for (const res of liveReloadClients) res.write(payload);
}

function queueLiveReload(reason) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => sendLiveReload(reason), 120);
}

function startLiveReloadWatcher() {
  const watchTargets = [
    { path: publicDir, options: { recursive: true }, label: "public" },
    { path: configPath, options: {}, label: "projects" },
  ];
  for (const target of watchTargets) {
    if (!existsSync(target.path)) continue;
    try {
      watch(target.path, target.options, () => queueLiveReload(target.label));
    } catch (error) {
      console.log(`Live reload watcher skipped ${target.path}: ${error.message}`);
    }
  }
}

async function loadProjects() {
  const projects = await loadJson(configPath, []);
  return Array.isArray(projects) ? projects : [];
}

async function loadState() {
  const state = await loadJson(statePath, {});
  return state && typeof state === "object" && !Array.isArray(state) ? state : {};
}

function queueConfig(task) {
  const operation = configQueue.then(task, task);
  configQueue = operation.catch(() => {});
  return operation;
}

function projectId(name, projects) {
  const base = String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
  const ids = new Set(projects.map((project) => project.id));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function projectUrl(value, fallback, label) {
  const template = String(value || fallback).trim();
  let parsed;
  try {
    parsed = new URL(template.replaceAll("{port}", "8000"));
  } catch {
    throw new Error(`${label} must be a valid HTTP URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${label} must use http or https.`);
  }
  return template;
}

function validateProjectInput(input, projects) {
  const name = String(input.name || "").trim();
  const description = String(input.description || "").trim();
  const cwd = String(input.cwd || "").trim();
  const command = String(input.command || "").trim();
  const condaEnv = String(input.condaEnv || "").trim();
  const preferredPort = Number(input.preferredPort || 3000);
  const tags = Array.isArray(input.tags)
    ? input.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : String(input.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);

  if (!name || name.length > 80) throw new Error("Project name is required and must be 80 characters or fewer.");
  if (description.length > 240) throw new Error("Description must be 240 characters or fewer.");
  if (!cwd || !isAbsolute(cwd) || !existsSync(cwd)) throw new Error("Working directory must be an existing absolute path.");
  if (!command || command.length > 600) throw new Error("Start command is required and must be 600 characters or fewer.");
  if (!command.includes("{port}")) throw new Error("Start command must include the {port} placeholder.");
  if (!Number.isInteger(preferredPort) || preferredPort < 1025 || preferredPort > 65535) {
    throw new Error("Preferred port must be between 1025 and 65535.");
  }
  if (condaEnv.length > 80) throw new Error("Conda environment name must be 80 characters or fewer.");
  if (tags.length > 8 || tags.some((tag) => tag.length > 24)) throw new Error("Use at most 8 tags, each 24 characters or fewer.");

  return {
    id: projectId(name, projects),
    name,
    description,
    cwd: resolve(cwd),
    ...(condaEnv ? { condaEnv } : {}),
    preferredPort,
    command,
    urlTemplate: projectUrl(input.urlTemplate, "http://localhost:{port}", "App URL"),
    healthTemplate: projectUrl(input.healthTemplate, input.urlTemplate || "http://localhost:{port}", "Health URL"),
    tags: [...new Set(tags)],
  };
}

async function addProject(input) {
  return queueConfig(async () => {
    const projects = await loadProjects();
    const project = validateProjectInput(input, projects);
    projects.push(project);
    await saveJson(configPath, projects);
    return project;
  });
}

async function deleteProject(id) {
  return queueConfig(async () => {
    const projects = await loadProjects();
    const index = projects.findIndex((project) => project.id === id);
    if (index < 0) throw new Error("Unknown project id.");
    const status = (await reconciledProjects()).find((project) => project.id === id);
    if (status.running) throw new Error("Stop the project before deleting it.");
    const state = await loadState();
    const [removed] = projects.splice(index, 1);
    delete state[id];
    await Promise.all([saveJson(configPath, projects), saveJson(statePath, state)]);
    await Promise.all([
      unlink(join(generatedDir, `${id}.cmd`)).catch(() => {}),
      unlink(exitMarkerPath(id)).catch(() => {}),
    ]);
    return { ok: true, id: removed.id, name: removed.name };
  });
}

function cmdQuote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function chromePath() {
  const candidates = [
    process.env.ROCKETMAN_CHROME,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : null,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function windowsTerminalPath() {
  const candidates = [
    process.env.ROCKETMAN_WT,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "wt.exe") : null,
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  const result = spawnSync("where.exe", ["wt.exe"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
}

function processExists(pid) {
  if (!pid) return false;
  const result = spawnSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.includes(String(pid));
}

function urlPort(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    if (parsed.protocol === "https:") return 443;
    if (parsed.protocol === "http:") return 80;
  } catch {
    return null;
  }
  return null;
}

function projectPort(project) {
  return Number(project.preferredPort || 0) || urlPort(project.url) || urlPort(project.healthUrl);
}

function formatTemplate(value, portValue) {
  return String(value || "").replaceAll("{port}", String(portValue));
}

function runtimeProject(project, record = {}) {
  const selectedPort = Number(record.port || project.preferredPort || projectPort(project));
  return {
    ...project,
    selectedPort,
    command: formatTemplate(project.command, selectedPort),
    url: project.urlTemplate ? formatTemplate(project.urlTemplate, selectedPort) : formatTemplate(project.url, selectedPort),
    healthUrl: project.healthTemplate ? formatTemplate(project.healthTemplate, selectedPort) : formatTemplate(project.healthUrl, selectedPort),
  };
}

function firstFreePort(startPort, listeners = scanListeners(), reservedPorts = []) {
  const used = new Set([
    ...listeners.map((listener) => listener.port),
    ...reservedPorts.map(Number),
  ]);
  let candidate = Number(startPort || 3000);
  while (used.has(candidate)) candidate += 1;
  return candidate;
}

function reservedProjectPorts(state, listeners, excludeProjectId) {
  const now = Date.now();
  return Object.entries(state).flatMap(([projectId, record]) => {
    const reservedPort = Number(record?.port || 0);
    const startedAt = Date.parse(record?.startedAt || "");
    const starting = Number.isFinite(startedAt) && now - startedAt < 60000;
    const listening = Boolean(listenerForPort(reservedPort, listeners));
    return projectId !== excludeProjectId && reservedPort && (starting || listening) ? [reservedPort] : [];
  });
}

function queueLifecycle(task) {
  const operation = lifecycleQueue.then(task, task);
  lifecycleQueue = operation.catch(() => {});
  return operation;
}

function exitMarkerPath(projectId) {
  return join(generatedDir, `${projectId}.exit`);
}

async function healthOk(url) {
  if (!url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 450);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function listenerKey(listener) {
  return listener ? `${listener.port}:${listener.pid}` : "";
}

async function projectStatus(project, state, listeners = scanListeners(), options = {}) {
  let record = state[project.id] || {};
  let hasRuntimeState = Boolean(record.port || record.startedAt);
  let activeProject = runtimeProject(project, record);
  let portListener = listenerForPort(activeProject.selectedPort, listeners);
  let healthy = portListener ? await healthOk(activeProject.healthUrl) : false;

  if (!hasRuntimeState && portListener) {
    const claimed = options.claimedListeners?.has(listenerKey(portListener));
    if (!claimed && (healthy || options.allowListenerOnly)) {
      record = {
        pid: portListener.pid,
        port: portListener.port,
        startedAt: null,
        detected: true,
      };
      state[project.id] = record;
      hasRuntimeState = true;
      activeProject = runtimeProject(project, record);
    }
  }

  const launcherPid = record.detected ? 0 : Number(record.pid || 0);
  const launcherRunning = processExists(launcherPid);
  const launcherExited = existsSync(exitMarkerPath(project.id));
  const recentlyStarted = !launcherExited && record.startedAt && Date.now() - Date.parse(record.startedAt) < 30000;
  const running = hasRuntimeState
    ? healthy || Boolean(portListener) || Boolean(recentlyStarted)
    : false;
  if (hasRuntimeState && !launcherRunning && !running) {
    delete state[project.id];
  }
  return {
    ...activeProject,
    pid: running ? portListener?.pid || (launcherRunning ? launcherPid : null) : null,
    launcherPid: running && launcherRunning ? launcherPid : null,
    port: activeProject.selectedPort,
    running,
    healthy,
    startedAt: running ? record.startedAt : null,
    detected: running && Boolean(record.detected),
    origin: running && record.detected ? "detected" : "configured",
  };
}

function preferredPortCounts(projects) {
  const counts = new Map();
  for (const project of projects) {
    const portValue = Number(project.preferredPort || projectPort(project));
    if (portValue) counts.set(portValue, (counts.get(portValue) || 0) + 1);
  }
  return counts;
}

function ghostProjects(listeners, claimedListeners) {
  const seen = new Set();
  const ghosts = [];
  const claimedPids = new Set([...claimedListeners].map((key) => Number(key.split(":")[1])));
  for (const listener of listeners) {
    const key = listenerKey(listener);
    if (listener.protected || claimedListeners.has(key) || claimedPids.has(listener.pid) || seen.has(key)) continue;
    seen.add(key);
    ghosts.push({
      id: `ghost-${listener.pid}-${listener.port}`,
      name: `Untracked ${listener.processName || "server"}`,
      description: "Live server detected outside Rocketman.",
      ghost: true,
      running: true,
      healthy: false,
      detected: true,
      origin: "ghost",
      port: listener.port,
      preferredPort: listener.port,
      pid: listener.pid,
      processName: listener.processName || "unknown",
      address: listener.address,
      url: listener.url,
      healthUrl: listener.url,
      startedAt: null,
      tags: ["Discovered", listener.processName || "Server"],
    });
  }
  return ghosts;
}

async function reconciledProjects() {
  const projects = await loadProjects();
  const state = await loadState();
  const stateBefore = JSON.stringify(state);
  const listeners = scanListeners();
  const portCounts = preferredPortCounts(projects);
  const claimedListeners = new Set();

  for (const record of Object.values(state)) {
    const listener = listenerForPort(Number(record?.port || 0), listeners);
    if (listener) claimedListeners.add(listenerKey(listener));
  }

  const statuses = [];
  for (const project of projects) {
    const preferredPort = Number(project.preferredPort || projectPort(project));
    const status = await projectStatus(project, state, listeners, {
      claimedListeners,
      allowListenerOnly: portCounts.get(preferredPort) === 1,
    });
    if (status.running) {
      const listener = listenerForPort(status.port, listeners);
      if (listener) claimedListeners.add(listenerKey(listener));
    }
    statuses.push(status);
  }

  if (JSON.stringify(state) !== stateBefore) await saveJson(statePath, state);

  const reservedPorts = reservedProjectPorts(state, listeners);
  const displayStatuses = statuses.map((status) => {
    if (status.running) return status;
    const selectedPort = firstFreePort(status.preferredPort || projectPort(status), listeners, reservedPorts);
    const availableProject = runtimeProject(status, { port: selectedPort });
    return {
      ...availableProject,
      port: selectedPort,
      availablePort: selectedPort,
      preferredPort: status.preferredPort,
      running: false,
      healthy: false,
    };
  });

  return [...displayStatuses, ...ghostProjects(listeners, claimedListeners)];
}

async function writeLauncher(project) {
  await mkdir(generatedDir, { recursive: true });
  const launcher = join(generatedDir, `${project.id}.cmd`);
  const exitMarker = exitMarkerPath(project.id);
  await unlink(exitMarker).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  const lines = [
    "@echo off",
    `title rocketman - ${project.name}`,
    `cd /d ${cmdQuote(project.cwd)}`,
    "echo.",
    `echo rocketman launching ${project.name}`,
    `echo Working directory: ${project.cwd}`,
    project.condaEnv ? `echo Conda environment: ${project.condaEnv}` : null,
    `echo Command: ${project.command}`,
    "echo.",
    project.condaEnv ? `call ${cmdQuote(condaActivatePath)} ${cmdQuote(project.condaEnv)}` : null,
    project.condaEnv ? "if errorlevel 1 goto rocketman_failed" : null,
    project.command,
    "if errorlevel 1 goto rocketman_failed",
    "goto rocketman_done",
    ":rocketman_failed",
    "echo.",
    "echo rocketman detected a startup failure. Review the error above.",
    "goto rocketman_done",
    ":rocketman_done",
    "echo.",
    "echo Process exited. This window is staying open for log review.",
    `> ${cmdQuote(exitMarker)} echo exited`,
  ].filter(Boolean);
  await writeFile(launcher, `${lines.join("\r\n")}\r\n`, "utf8");
  return launcher;
}

async function startProject(project) {
  const state = await loadState();
  const listeners = scanListeners();
  const projects = await loadProjects();
  const preferredPort = Number(project.preferredPort || projectPort(project));
  const current = await projectStatus(project, state, listeners, {
    claimedListeners: new Set(Object.entries(state)
      .filter(([projectId]) => projectId !== project.id)
      .map(([, record]) => listenerKey(listenerForPort(Number(record?.port || 0), listeners)))
      .filter(Boolean)),
    allowListenerOnly: preferredPortCounts(projects).get(preferredPort) === 1,
  });
  if (current.running) {
    await saveJson(statePath, state);
    return current;
  }

  const reservedPorts = reservedProjectPorts(state, listeners, project.id);
  const selectedPort = firstFreePort(project.preferredPort || projectPort(project), listeners, reservedPorts);
  const activeProject = runtimeProject(project, { port: selectedPort });
  const launcher = await writeLauncher(activeProject);
  const wt = windowsTerminalPath();
  const child = wt
    ? spawn(wt, ["-w", "0", "new-tab", "--title", `rocketman - ${project.name}`, "cmd.exe", "/d", "/k", "call", launcher], {
        cwd: project.cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
    : spawn("cmd.exe", ["/c", "start", "", "cmd.exe", "/d", "/k", "call", launcher], {
        cwd: project.cwd,
        detached: false,
        stdio: "ignore",
        windowsHide: false,
      });
  child.unref?.();

  state[project.id] = { pid: child.pid, port: selectedPort, startedAt: new Date().toISOString() };
  await saveJson(statePath, state);
  return projectStatus(project, state);
}

async function stopProject(project) {
  const state = await loadState();
  const record = state[project.id] || {};
  const activeProject = runtimeProject(project, record);
  const listener = listenerForPort(activeProject.selectedPort);
  const launcherPid = Number(record.pid || 0);
  const pids = [listener?.pid, launcherPid].filter((pid, index, values) => (
    record.port && pid && values.indexOf(pid) === index && pid !== process.pid && pid !== 4
  ));
  for (const pid of pids) {
    if (!processExists(pid)) continue;
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
  }
  delete state[project.id];
  await saveJson(statePath, state);
  return projectStatus(project, state);
}

function openUrl(url) {
  if (!url) return { ok: false, error: "No URL configured." };
  const chrome = chromePath();
  if (!chrome) {
    return { ok: false, error: "Chrome was not found. Set ROCKETMAN_CHROME to chrome.exe or install Chrome." };
  }
  spawn(chrome, [url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  return { ok: true, browser: chrome };
}

function csvCells(line) {
  return [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

function processNameMap() {
  const result = spawnSync("tasklist.exe", ["/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const names = new Map();
  for (const line of result.stdout.trim().split(/\r?\n/)) {
    const cells = csvCells(line);
    if (cells.length >= 2) names.set(Number(cells[1]), cells[0]);
  }
  return names;
}

function scanListeners() {
  const result = spawnSync("netstat.exe", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const rows = [];
  const seen = new Set();
  const names = processNameMap();
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("TCP") || !trimmed.includes("LISTENING")) continue;
    const parts = trimmed.split(/\s+/);
    const local = parts[1] || "";
    const pid = Number(parts[4] || 0);
    const match = local.match(/^(.*):(\d+)$/);
    if (!match || !pid) continue;
    const address = match[1].replace(/^\[|\]$/g, "");
    const listenerPort = Number(match[2]);
    const key = `${address}:${listenerPort}:${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = names.get(pid) || "";
    const lowerName = name.toLowerCase();
    const killableNames = new Set(["node.exe", "python.exe", "pythonw.exe", "uvicorn.exe"]);
    const protectedProcess = (
      pid === process.pid
      || pid === 4
      || listenerPort <= 1024
      || !killableNames.has(lowerName)
    );
    const urlHost = ["0.0.0.0", "127.0.0.1", "::", "::1"].includes(address)
      ? "localhost"
      : address.includes(":") ? `[${address}]` : address;
    rows.push({
      address,
      port: listenerPort,
      pid,
      processName: name,
      url: `http://${urlHost}:${listenerPort}`,
      protected: protectedProcess,
      reason: protectedProcess ? "Protected process" : "",
    });
  }
  return rows.sort((a, b) => a.port - b.port || a.pid - b.pid);
}

function listenerForPort(listenerPort, listeners = scanListeners()) {
  if (!listenerPort) return null;
  return listeners.find((listener) => (
    listener.port === listenerPort
    && (listener.address === "127.0.0.1" || listener.address === "0.0.0.0" || listener.address === "::" || listener.address === "::1")
  )) || null;
}

function killPid(pid) {
  if (!pid || pid === process.pid || pid === 4) {
    throw new Error("Refusing to kill a protected process.");
  }
  const listeners = scanListeners().filter((listener) => listener.pid === pid);
  if (!listeners.length || listeners.every((listener) => listener.protected)) {
    throw new Error("Refusing to kill a protected or unknown server process.");
  }
  const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `taskkill failed for PID ${pid}`);
  }
  return { ok: true };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ bootId })}\n\n`);
    liveReloadClients.add(res);
    req.on("close", () => liveReloadClients.delete(res));
    return true;
  }

  if (req.method === "GET" && pathname === "/api/projects") {
    sendJson(res, 200, await reconciledProjects());
    return true;
  }

  if (req.method === "POST" && pathname === "/api/projects") {
    const project = await addProject(await readBody(req));
    sendJson(res, 201, project);
    return true;
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/projects/")) {
    const id = decodeURIComponent(pathname.slice("/api/projects/".length));
    sendJson(res, 200, await deleteProject(id));
    return true;
  }

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, name: "rocketman" });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/listeners") {
    sendJson(res, 200, scanListeners());
    return true;
  }

  if (req.method === "POST" && pathname === "/api/kill-listener") {
    const body = await readBody(req);
    sendJson(res, 200, killPid(Number(body.pid || 0)));
    return true;
  }

  if (req.method === "POST" && pathname === "/api/open-listener") {
    const body = await readBody(req);
    const listener = scanListeners().find((item) => (
      item.pid === Number(body.pid) && item.port === Number(body.port)
    ));
    if (!listener || listener.protected) {
      sendJson(res, 404, { error: "The discovered server is no longer available." });
      return true;
    }
    const opened = openUrl(listener.url);
    sendJson(res, opened.ok ? 200 : 500, opened);
    return true;
  }

  if (req.method === "POST" && ["/api/start", "/api/stop", "/api/open"].includes(pathname)) {
    const body = await readBody(req);
    const project = (await loadProjects()).find((item) => item.id === body.id);
    if (!project) {
      sendJson(res, 404, { error: "Unknown project id." });
      return true;
    }
    if (pathname === "/api/start") sendJson(res, 200, await queueLifecycle(() => startProject(project)));
    if (pathname === "/api/stop") sendJson(res, 200, await queueLifecycle(() => stopProject(project)));
    if (pathname === "/api/open") {
      const state = await loadState();
      const opened = openUrl(runtimeProject(project, state[project.id] || {}).url);
      sendJson(res, opened.ok ? 200 : 500, opened);
    }
    return true;
  }

  return false;
}

async function serveStatic(res, pathname) {
  const isThreeModule = pathname.startsWith("/vendor/three/");
  const root = isThreeModule ? threeDir : publicDir;
  const relative = isThreeModule
    ? pathname.slice("/vendor/three".length)
    : pathname === "/" ? "/index.html" : pathname;
  const resolvedRoot = resolve(root);
  const target = resolve(root, `.${decodeURIComponent(relative)}`);
  if (!target.startsWith(resolvedRoot) || !existsSync(target)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const body = await readFile(target);
  res.writeHead(200, {
    "content-type": contentTypes[extname(target)] || "application/octet-stream",
    "cache-control": "no-cache",
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${host}:${port}`);
    if (pathname.startsWith("/api/") && await handleApi(req, res, pathname)) return;
    if (req.method === "GET") {
      await serveStatic(res, pathname);
      return;
    }
    sendJson(res, 405, { error: "Method not allowed." });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

let serverStarted = false;

export async function startRocketmanServer({ openBrowser = true } = {}) {
  if (serverStarted) return { server, url: `http://${host}:${port}` };

  await mkdir(dataDir, { recursive: true });

  return new Promise((resolveStart, rejectStart) => {
    const handleError = (error) => {
      server.off("listening", handleListening);
      rejectStart(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      serverStarted = true;
      startLiveReloadWatcher();
      const url = `http://${host}:${port}`;
      console.log(`rocketman dashboard: ${url}`);
      if (openBrowser) {
        const opened = openUrl(url);
        if (!opened.ok) console.log(opened.error);
      }
      resolveStart({ server, url });
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port, host);
  });
}

export async function stopRocketmanServer() {
  if (!serverStarted) return;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  serverStarted = false;
}

const launchedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (launchedDirectly) {
  startRocketmanServer().catch((error) => {
    if (error.code === "EADDRINUSE") {
      console.log(`Rocketman is already running at http://${host}:${port}`);
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
}
