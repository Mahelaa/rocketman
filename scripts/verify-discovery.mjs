const dashboard = "http://localhost:7777";

async function getJson(path) {
  const response = await fetch(`${dashboard}${path}`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || `${path} failed with ${response.status}`);
  return payload;
}

const [projects, listeners] = await Promise.all([
  getJson("/api/projects"),
  getJson("/api/listeners"),
]);

const configured = projects.filter((project) => !project.ghost);
const ghosts = projects.filter((project) => project.ghost);
const localListeners = listeners.filter((listener) => (
  listener.address === "127.0.0.1" || listener.address === "0.0.0.0" || listener.address === "::"
));
const listenerKeys = new Set(localListeners.map((listener) => `${listener.port}:${listener.pid}`));
const claimedKeys = new Set(configured
  .filter((project) => project.running && project.pid)
  .map((project) => `${project.port}:${project.pid}`));
const claimedPids = new Set(configured.filter((project) => project.running && project.pid).map((project) => project.pid));

for (const project of configured.filter((item) => item.running && item.pid)) {
  if (!listenerKeys.has(`${project.port}:${project.pid}`)) {
    throw new Error(`${project.name} is marked running without a matching listener.`);
  }
}

const occupiedPorts = new Set(localListeners.map((listener) => listener.port));
for (const project of configured.filter((item) => !item.running)) {
  if (occupiedPorts.has(project.port)) {
    throw new Error(`${project.name} previews occupied port ${project.port}.`);
  }
}

for (const ghost of ghosts) {
  const key = `${ghost.port}:${ghost.pid}`;
  if (!listenerKeys.has(key)) throw new Error(`Ghost ${ghost.id} has no live listener.`);
  if (claimedKeys.has(key)) throw new Error(`Claimed listener ${key} was also emitted as a ghost.`);
  if (claimedPids.has(ghost.pid)) throw new Error(`Auxiliary listener for claimed PID ${ghost.pid} was emitted as a ghost.`);
}

const hrProject = configured.find((project) => project.id === "hr-evaluation");
const port3000 = localListeners.find((listener) => listener.port === 3000);
if (hrProject && port3000 && (!hrProject.running || hrProject.port !== 3000 || hrProject.pid !== port3000.pid)) {
  throw new Error(`SL HR Evaluation was not reconciled to port 3000: ${JSON.stringify(hrProject)}`);
}

console.log(JSON.stringify({
  configured: configured.map((project) => ({ id: project.id, running: project.running, port: project.port })),
  ghosts: ghosts.map((ghost) => ({ pid: ghost.pid, port: ghost.port, processName: ghost.processName })),
}));
