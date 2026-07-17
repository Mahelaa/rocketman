import * as THREE from "three";

const projectsEl = document.querySelector("#projects");
const serversEl = document.querySelector("#servers");
const runningCountEl = document.querySelector("#running-count");
const refreshBtn = document.querySelector("#refresh");
const tabButtons = [...document.querySelectorAll("[data-tab]")];
const tabPanels = [...document.querySelectorAll(".tab-panel")];
const addProjectBtn = document.querySelector("#add-project");
const projectDialog = document.querySelector("#project-dialog");
const projectForm = document.querySelector("#project-form");
const projectFormError = document.querySelector("#project-form-error");
const saveProjectBtn = document.querySelector("#save-project");

let busy = new Set();
let serverBusy = new Set();
let activeTab = "projects";
let networkLoaded = false;
let serversLoading = false;
const transitions = new Map();
const bootStorageKey = "rocketman.bootId";
const asciiScenes = new Map();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let lastProjectsMarkup = "";
let asciiAnimationFrame = null;
let lastAsciiFrame = 0;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function statusText(project) {
  const transition = transitions.get(project.id)?.state;
  if (transition === "launching") return "Launching";
  if (transition === "landing") return "Returning";
  if (busy.has(project.id)) return "Working";
  if (project.running && project.healthy) return "Running";
  if (project.running && project.pid) return "Running";
  if (project.running) return "Starting";
  return "Stopped";
}

function projectCard(project) {
  if (project.ghost) return ghostProjectCard(project);
  const status = statusText(project);
  const transitionRecord = transitions.get(project.id);
  const transition = transitionRecord?.state;
  const statusClass = transition || (status === "Running" ? "running" : status === "Starting" || status === "Working" ? "starting" : "stopped");
  const started = project.startedAt ? new Date(project.startedAt).toLocaleString() : project.detected ? "Detected externally" : "Not running";
  const projectTags = project.detected ? ["Auto-detected", ...(project.tags || [])] : (project.tags || []);
  const tags = projectTags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join("");
  const disabled = busy.has(project.id) ? "disabled" : "";
  const removeDisabled = project.running || busy.has(project.id) ? "disabled" : "";
  const portLabel = project.port ? `:${project.port}` : "-";
  return `
    <article class="project ${statusClass}">
      <div class="project-head">
        <div>
          <h2>${esc(project.name)}</h2>
          <p>${esc(project.description)}</p>
        </div>
        <span class="status"><span class="dot"></span>${esc(status)}</span>
      </div>
      <div class="flight-status" aria-hidden="true">
        <div class="ascii-viewport" data-ascii-id="${esc(project.id)}" data-ascii-state="${esc(statusClass)}" data-ascii-started="${transitionRecord?.startedAt || ""}"></div>
        <span class="flight-label">${esc(status)}</span>
        <span class="ascii-telemetry">${transition === "launching" ? "ASCENT // ORBIT INSERTION" : transition === "landing" ? "RE-ENTRY // LANDING" : project.running ? "DEEP SPACE // CRUISE" : "PAD // PRE-FLIGHT"}</span>
      </div>
      <div class="tags">${tags}</div>
      <div class="meta">
        <span>Port: <code>${esc(portLabel)}</code></span>
        <span>PID: <code>${project.pid ? esc(project.pid) : "-"}</code></span>
        <span>Started: <code>${esc(started)}</code></span>
        <span>URL: <code>${esc(project.url)}</code></span>
      </div>
      <div class="actions">
        <button class="primary" type="button" data-action="start" data-id="${esc(project.id)}" ${disabled}>Start</button>
        <button class="danger" type="button" data-action="stop" data-id="${esc(project.id)}" ${disabled}>Stop</button>
        <button type="button" data-action="open" data-id="${esc(project.id)}" ${disabled}>Open App</button>
        <button class="remove-project" type="button" data-delete-id="${esc(project.id)}" data-delete-name="${esc(project.name)}" ${removeDisabled}>Remove</button>
      </div>
    </article>
  `;
}

function ghostProjectCard(project) {
  return `
    <article class="project ghost-project">
      <div class="project-head">
        <div>
          <p class="ghost-eyebrow">Untracked server</p>
          <h2>${esc(project.processName || "Unknown process")}</h2>
          <p>Listening locally but not configured in Rocketman.</p>
        </div>
        <span class="status ghost-status"><span class="dot"></span>Discovered</span>
      </div>
      <div class="ghost-console" aria-hidden="true">
        <span>LIVE LISTENER</span>
        <strong>:${esc(project.port)}</strong>
        <code>${esc(project.address)} // PID ${esc(project.pid)}</code>
      </div>
      <div class="tags">
        <span class="tag">Discovered</span>
        <span class="tag">${esc(project.processName || "Server")}</span>
      </div>
      <div class="meta">
        <span>Port: <code>:${esc(project.port)}</code></span>
        <span>PID: <code>${esc(project.pid)}</code></span>
        <span>URL: <code>${esc(project.url)}</code></span>
      </div>
      <div class="actions ghost-actions">
        <button class="primary" type="button" data-adopt-port="${esc(project.port)}" data-adopt-pid="${esc(project.pid)}" data-adopt-process="${esc(project.processName || "Server")}" data-adopt-url="${esc(project.url)}">Add to Rocketman</button>
        <button type="button" data-open-ghost-port="${esc(project.port)}" data-open-ghost-pid="${esc(project.pid)}">Open Server</button>
      </div>
    </article>
  `;
}

const vector = (x, y, z) => new THREE.Vector3(x, y, z);

function surfacePoint(position, normal) {
  return { position, normal: normal.clone().normalize() };
}

function cylinderSurface(yBottom, yTop, radius, verticalSteps = 20, radialSteps = 48) {
  const points = [];
  for (let row = 0; row <= verticalSteps; row += 1) {
    const y = THREE.MathUtils.lerp(yBottom, yTop, row / verticalSteps);
    for (let column = 0; column < radialSteps; column += 1) {
      const angle = column / radialSteps * Math.PI * 2;
      const normal = vector(Math.sin(angle), 0, Math.cos(angle));
      points.push(surfacePoint(vector(normal.x * radius, y, normal.z * radius), normal));
    }
  }
  return points;
}

function frustumSurface(yBottom, yTop, bottomRadius, topRadius, verticalSteps = 20, radialSteps = 48) {
  const points = [];
  const slope = (bottomRadius - topRadius) / (yTop - yBottom);
  for (let row = 0; row <= verticalSteps; row += 1) {
    const progress = row / verticalSteps;
    const y = THREE.MathUtils.lerp(yBottom, yTop, progress);
    const radius = THREE.MathUtils.lerp(bottomRadius, topRadius, progress);
    for (let column = 0; column < radialSteps; column += 1) {
      const angle = column / radialSteps * Math.PI * 2;
      const normal = vector(Math.sin(angle), slope, Math.cos(angle));
      points.push(surfacePoint(vector(Math.sin(angle) * radius, y, Math.cos(angle) * radius), normal));
    }
  }
  return points;
}

function coneSurface(yBottom, yTop, baseRadius, verticalSteps = 16, radialSteps = 48) {
  const points = [];
  const slope = baseRadius / (yTop - yBottom);
  for (let row = 0; row <= verticalSteps; row += 1) {
    const progress = row / verticalSteps;
    const y = THREE.MathUtils.lerp(yBottom, yTop, progress);
    const radius = baseRadius * (1 - progress);
    for (let column = 0; column < radialSteps; column += 1) {
      const angle = column / radialSteps * Math.PI * 2;
      const normal = vector(Math.sin(angle), slope, Math.cos(angle));
      points.push(surfacePoint(vector(Math.sin(angle) * radius, y, Math.cos(angle) * radius), normal));
    }
  }
  return points;
}

function discSurface(y, radius, radialSteps = 12, angularSteps = 48, normalY = 1) {
  const points = [];
  for (let ring = 0; ring <= radialSteps; ring += 1) {
    const ringRadius = radius * ring / radialSteps;
    const count = Math.max(8, Math.round(angularSteps * Math.max(ring / radialSteps, 0.2)));
    for (let index = 0; index < count; index += 1) {
      const angle = index / count * Math.PI * 2;
      points.push(surfacePoint(vector(Math.sin(angle) * ringRadius, y, Math.cos(angle) * ringRadius), vector(0, normalY, 0)));
    }
  }
  return points;
}

function finSurface(side) {
  const points = [];
  for (let row = 0; row <= 14; row += 1) {
    const progress = row / 14;
    const y = THREE.MathUtils.lerp(-1.2, -0.42, progress);
    const outer = THREE.MathUtils.lerp(1.15, 0.56, progress);
    for (let column = 0; column <= 10; column += 1) {
      const x = side * THREE.MathUtils.lerp(0.5, outer, column / 10);
      for (const z of [-0.06, 0.06]) points.push(surfacePoint(vector(x, y, z), vector(0, 0, Math.sign(z))));
    }
  }
  return points;
}

function windowSurface() {
  const points = [];
  for (let ring = 0; ring <= 7; ring += 1) {
    const radius = 0.22 * ring / 7;
    const count = Math.max(8, ring * 6);
    for (let index = 0; index < count; index += 1) {
      const angle = index / count * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const y = 0.45 + Math.sin(angle) * radius;
      const z = Math.sqrt(Math.max(0, 0.5 ** 2 - x ** 2)) + 0.018;
      points.push(surfacePoint(vector(x, y, z), vector(x, 0, z)));
    }
  }
  return points;
}

function translatedSurface(points, x, y = 0, z = 0) {
  return points.map((point) => surfacePoint(point.position.clone().add(vector(x, y, z)), point.normal));
}

function exhaustSurface(length = 0.82, baseRadius = 0.28) {
  const points = [];
  for (let row = 0; row <= 14; row += 1) {
    const progress = row / 14;
    const y = -length * progress;
    const radius = baseRadius * (1 - progress) * (0.9 + Math.sin(progress * Math.PI * 5) * 0.1);
    for (let column = 0; column < 36; column += 1) {
      const angle = column / 36 * Math.PI * 2;
      const normal = vector(Math.sin(angle), -0.35, Math.cos(angle));
      points.push(surfacePoint(vector(Math.sin(angle) * radius, y, Math.cos(angle) * radius), normal));
    }
  }
  return points;
}

const sideBoosters = [-1, 1].flatMap((side) => [
  ...translatedSurface(frustumSurface(-1.12, 0.18, 0.18, 0.15, 14, 32), side * 0.85),
  ...translatedSurface(coneSurface(0.18, 0.62, 0.15, 8, 32), side * 0.85),
  ...translatedSurface(cylinderSurface(-1.28, -1.12, 0.12, 3, 28), side * 0.85),
]);

const rocketModel = {
  body: [
    ...frustumSurface(-1.02, 1.08, 0.5, 0.42, 24, 52),
    ...cylinderSurface(-1.34, -1.02, 0.3, 5, 36),
    ...coneSurface(1.08, 2.32, 0.42, 18, 52),
    ...sideBoosters,
  ],
  accent: [
    ...windowSurface(),
    ...cylinderSurface(0.78, 0.87, 0.435, 2, 52),
    ...cylinderSurface(-0.72, -0.62, 0.515, 2, 52),
  ],
  flame: [
    ...exhaustSurface(1.28, 0.24),
    ...translatedSurface(exhaustSurface(0.9, 0.11), -0.85),
    ...translatedSurface(exhaustSurface(0.9, 0.11), 0.85),
  ],
};

const padModel = [
  ...discSurface(-1.5, 1.45, 12, 56),
  ...cylinderSurface(-1.76, -1.5, 1.45, 5, 56),
];

function emptyGrid(columns, rows) {
  return Array.from({ length: rows }, () => Array(columns).fill(" "));
}

function emptyDepthBuffer(columns, rows) {
  return Array.from({ length: rows }, () => Array(columns).fill(Infinity));
}

function writeGrid(grid) {
  return grid.map((row) => row.join("")).join("\n");
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function smoothStep(value) {
  const progress = clamp01(value);
  return progress * progress * (3 - 2 * progress);
}

function writeText(grid, column, row, text) {
  for (let index = 0; index < text.length; index += 1) {
    const targetColumn = column + index;
    if (grid[row]?.[targetColumn] === " ") grid[row][targetColumn] = text[index];
  }
}

function drawEarthHorizon(grid, horizonRow) {
  const center = (grid[0]?.length || 0) / 2;
  for (let column = 0; column < (grid[0]?.length || 0); column += 1) {
    const normalized = (column - center) / Math.max(center, 1);
    const row = Math.round(horizonRow + normalized * normalized * 3.4);
    if (grid[row]?.[column] === " ") grid[row][column] = Math.abs(normalized) < 0.65 ? "=" : "-";
    if (grid[row + 1]?.[column] === " " && column % 2 === 0) grid[row + 1][column] = ".";
  }
}

function drawStarField(context, grid, seconds, speedMultiplier = 1, direction = 1) {
  for (const star of context.stars) {
    const travel = seconds * star.speed * speedMultiplier * direction;
    const rawRow = star.y + travel;
    const row = ((Math.floor(rawRow) % context.rows) + context.rows) % context.rows;
    const column = Math.max(0, Math.min(context.columns - 1, Math.round(star.x / 64 * context.columns)));
    const twinkle = Math.sin(seconds * star.twinkle + star.phase);
    const character = twinkle > 0.62 ? "+" : twinkle < -0.5 ? "." : star.char;
    if (grid[row]?.[column] === " ") grid[row][column] = character;

    const trailLength = Math.max(0, Math.min(3, Math.floor(Math.abs(speedMultiplier) * star.trail)));
    for (let trail = 1; trail <= trailLength; trail += 1) {
      const trailRow = row - trail * direction;
      if (grid[trailRow]?.[column] === " ") grid[trailRow][column] = trail === 1 ? ":" : ".";
    }
  }
}

const easterEggs = [
  [" .-.", "<|o|>"],
  ["o-[42]-o"],
  ["*~~~~"],
];

function drawRareEasterEgg(context, grid, now) {
  if (!context.easterEgg && now >= context.nextEasterEggAt) {
    const pattern = easterEggs[Math.floor(context.random() * easterEggs.length)];
    context.easterEgg = {
      pattern,
      startedAt: now,
      duration: 2400 + context.random() * 1200,
      row: 3 + Math.floor(context.random() * 12),
    };
  }
  if (!context.easterEgg) return;

  const progress = (now - context.easterEgg.startedAt) / context.easterEgg.duration;
  if (progress >= 1) {
    context.easterEgg = null;
    context.nextEasterEggAt = now + 45000 + context.random() * 60000;
    return;
  }

  const width = Math.max(...context.easterEgg.pattern.map((line) => line.length));
  const column = Math.round(context.columns + width - progress * (context.columns + width * 2));
  context.easterEgg.pattern.forEach((line, index) => writeText(grid, column, context.easterEgg.row + index, line));
}

function drawPointCloud(grid, depthBuffer, points, matrix, context, characterRamp) {
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const light = vector(0.35, 0.65, 1).normalize();
  for (const point of points) {
    const world = point.position.clone().applyMatrix4(matrix);
    const projected = world.clone().project(context.camera);
    if (projected.z < -1 || projected.z > 1) continue;
    const column = Math.round((projected.x * 0.5 + 0.5) * (context.columns - 1));
    const row = Math.round((-projected.y * 0.5 + 0.5) * (context.rows - 1));
    if (!grid[row]?.[column] || projected.z >= depthBuffer[row][column]) continue;
    const normal = point.normal.clone().applyMatrix3(normalMatrix).normalize();
    const brightness = 0.16 + Math.max(0, normal.dot(light)) * 0.84;
    const character = characterRamp[Math.min(characterRamp.length - 1, Math.round(brightness * (characterRamp.length - 1)))];
    grid[row][column] = character;
    depthBuffer[row][column] = projected.z;
  }
}

function buildRocketScene(mount) {
  const width = Math.max(280, Math.round(mount.clientWidth || 320));
  const camera = new THREE.PerspectiveCamera(37, width / 188, 0.1, 100);
  camera.position.set(3.6, 1.1, 7.6);
  camera.lookAt(0, 0.05, 0);
  camera.updateMatrixWorld();

  const layers = {};
  for (const name of ["environment", "stars", "pad", "rocket", "accent", "flame"]) {
    const layer = document.createElement("pre");
    layer.className = `ascii-layer ascii-${name}-layer`;
    mount.appendChild(layer);
    layers[name] = layer;
  }

  const seed = [...mount.dataset.asciiId].reduce((value, character) => value + character.charCodeAt(0), 0);
  let randomSeed = seed;
  const random = () => {
    randomSeed = (randomSeed * 1664525 + 1013904223) >>> 0;
    return randomSeed / 4294967296;
  };
  const stars = Array.from({ length: 34 }, (_, index) => ({
    x: random() * 64,
    y: random() * 22,
    speed: 0.55 + random() * 1.2,
    twinkle: 1.2 + random() * 2.4,
    trail: 0.7 + random() * 1.2,
    phase: random() * Math.PI * 2,
    char: index % 5 === 0 ? "+" : index % 3 === 0 ? "." : "*",
  }));

  const context = {
    mount,
    camera,
    layers,
    stars,
    random,
    easterEgg: null,
    nextEasterEggAt: performance.now() + 25000 + random() * 45000,
    columns: Math.max(56, Math.min(64, Math.floor(width / 5.05))),
    rows: 22,
    phase: (seed % 17) / 17 * Math.PI * 2,
    state: mount.dataset.asciiState,
    stateStarted: Number(mount.dataset.asciiStarted) || performance.now(),
  };

  const resizeObserver = new ResizeObserver(([entry]) => {
    const nextWidth = Math.max(280, Math.round(entry.contentRect.width));
    context.columns = Math.max(56, Math.min(64, Math.floor(nextWidth / 5.05)));
    context.camera.aspect = nextWidth / 188;
    context.camera.updateProjectionMatrix();
  });
  resizeObserver.observe(mount);
  context.resizeObserver = resizeObserver;
  return context;
}

function renderAsciiScene(context, now) {
  const nextState = context.mount.dataset.asciiState;
  if (context.state !== nextState) {
    context.state = nextState;
    context.stateStarted = Number(context.mount.dataset.asciiStarted) || now;
    if (nextState !== "running") context.easterEgg = null;
  }

  const grids = {
    environment: emptyGrid(context.columns, context.rows),
    stars: emptyGrid(context.columns, context.rows),
    pad: emptyGrid(context.columns, context.rows),
    rocket: emptyGrid(context.columns, context.rows),
    accent: emptyGrid(context.columns, context.rows),
    flame: emptyGrid(context.columns, context.rows),
  };
  const rocketDepth = emptyDepthBuffer(context.columns, context.rows);
  const padDepth = emptyDepthBuffer(context.columns, context.rows);
  const flameDepth = emptyDepthBuffer(context.columns, context.rows);
  const seconds = now / 1000;
  const moving = !reducedMotion.matches;
  const elapsed = now - context.stateStarted;
  const position = new THREE.Vector3(0, 0, 0);
  const rotation = new THREE.Euler(0, 0.52, 0);
  const padRotation = 0.52;
  let flameScale = 0;
  let showPad = true;
  let showStars = false;
  let showFlame = false;
  let starSpeed = 0;
  let starDirection = 1;

  if (context.state === "launching" || context.state === "starting") {
    const progress = reducedMotion.matches ? 1 : clamp01(elapsed / 3600);
    const ignition = smoothStep(progress / 0.17);
    const lift = smoothStep((progress - 0.14) / 0.44);
    const cameraTrack = smoothStep((progress - 0.55) / 0.3);
    const liftedY = THREE.MathUtils.lerp(0, 1.12, lift);
    position.y = THREE.MathUtils.lerp(liftedY, 0.18, cameraTrack);
    position.x = moving ? Math.sin(seconds * 42) * 0.025 * (1 - lift) : 0;
    rotation.z = moving ? Math.sin(seconds * 2.2) * 0.018 * lift : 0;
    flameScale = 0.35 + ignition * 1.1 + (moving ? Math.sin(seconds * 19) * 0.12 : 0);
    showPad = progress < 0.68;
    showStars = progress > 0.46;
    showFlame = true;
    starSpeed = THREE.MathUtils.lerp(0.6, 4.4, smoothStep((progress - 0.46) / 0.4));
    if (progress > 0.25 && progress < 0.88) drawEarthHorizon(grids.environment, 13 + progress * 13);
  } else if (context.state === "running") {
    showPad = false;
    showStars = true;
    showFlame = true;
    position.x = moving ? Math.sin(seconds * 0.72 + context.phase) * 0.055 : 0;
    position.y = moving ? 0.18 + Math.sin(seconds * 1.05 + context.phase) * 0.045 : 0.18;
    rotation.x = moving ? Math.sin(seconds * 0.42 + context.phase) * 0.018 : 0;
    rotation.z = moving ? Math.sin(seconds * 0.68 + context.phase) * 0.025 : 0;
    flameScale = moving ? 1.16 + Math.sin(seconds * 17) * 0.15 + Math.sin(seconds * 7.3) * 0.08 : 1.16;
    starSpeed = 3.4;
    if (moving) drawRareEasterEgg(context, grids.stars, now);
  } else if (context.state === "landing") {
    const progress = reducedMotion.matches ? 1 : clamp01(elapsed / 3200);
    const reentry = smoothStep((progress - 0.12) / 0.34);
    const descent = smoothStep((progress - 0.56) / 0.4);
    const trackedY = THREE.MathUtils.lerp(0.18, 0.94, reentry);
    position.y = THREE.MathUtils.lerp(trackedY, 0, descent);
    position.x = moving ? Math.sin(seconds * 1.8) * 0.04 * (1 - descent) : 0;
    rotation.z = moving ? Math.sin(seconds * 1.35) * 0.045 * (1 - descent) : 0;
    flameScale = Math.max(0.28, 1.04 - descent * 0.7) + (moving ? Math.sin(seconds * 15) * 0.09 : 0);
    showPad = progress > 0.5;
    showStars = progress < 0.64;
    showFlame = progress < 0.94;
    starSpeed = THREE.MathUtils.lerp(3.2, 0.5, reentry);
    starDirection = -1;
    if (progress > 0.3 && progress < 0.88) drawEarthHorizon(grids.environment, 25 - progress * 13);
  }

  if (showStars) {
    drawStarField(context, grids.stars, moving ? seconds : 0, starSpeed, starDirection);
  }

  const quaternion = new THREE.Quaternion().setFromEuler(rotation);
  const rocketMatrix = new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1));
  const flameMatrix = rocketMatrix.clone()
    .multiply(new THREE.Matrix4().makeTranslation(0, -1.34, 0))
    .multiply(new THREE.Matrix4().makeScale(1, flameScale, 1));
  const padQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, padRotation, 0));
  const padMatrix = new THREE.Matrix4().compose(new THREE.Vector3(), padQuaternion, new THREE.Vector3(1, 1, 1));
  drawPointCloud(grids.rocket, rocketDepth, rocketModel.body, rocketMatrix, context, ".:-=+*#%@");
  drawPointCloud(grids.accent, rocketDepth, rocketModel.accent, rocketMatrix, context, "+*#%@");
  if (showFlame) drawPointCloud(grids.flame, flameDepth, rocketModel.flame, flameMatrix, context, ".~^*#@");
  if (showPad) drawPointCloud(grids.pad, padDepth, padModel, padMatrix, context, ".:~=+*#");

  for (const [name, grid] of Object.entries(grids)) context.layers[name].textContent = writeGrid(grid);
}

function animateAsciiScenes(now) {
  asciiAnimationFrame = requestAnimationFrame(animateAsciiScenes);
  if (now - lastAsciiFrame < 50) return;
  lastAsciiFrame = now;
  for (const context of asciiScenes.values()) renderAsciiScene(context, now);
}

function disposeAsciiScenes() {
  for (const context of asciiScenes.values()) {
    context.resizeObserver.disconnect();
  }
  asciiScenes.clear();
}

function initializeAsciiScenes() {
  for (const mount of projectsEl.querySelectorAll(".ascii-viewport")) {
    try {
      asciiScenes.set(mount.dataset.asciiId, buildRocketScene(mount));
    } catch (error) {
      mount.innerHTML = `<span class="ascii-fallback">3D ASCII unavailable</span>`;
      console.error(error);
    }
  }
  if (!asciiAnimationFrame) asciiAnimationFrame = requestAnimationFrame(animateAsciiScenes);
}

async function loadProjects() {
  try {
    const response = await fetch("/api/projects", { cache: "no-store" });
    const projects = await response.json();
    if (!response.ok || projects.error) {
      throw new Error(projects.error || `Request failed with ${response.status}`);
    }
    const running = projects.filter((project) => project.running).length;
    runningCountEl.textContent = `${running} running`;
    const markup = projects.length ? projects.map(projectCard).join("") : `<div class="empty">No projects configured.</div>`;
    if (markup !== lastProjectsMarkup) {
      disposeAsciiScenes();
      projectsEl.innerHTML = markup;
      lastProjectsMarkup = markup;
      initializeAsciiScenes();
    }
  } catch (error) {
    disposeAsciiScenes();
    lastProjectsMarkup = "";
    projectsEl.innerHTML = `<div class="error">Unable to load projects: ${esc(error.message)}</div>`;
  }
}

function serverRows(servers) {
  if (!servers.length) {
    return `<div class="empty">No listening TCP servers found.</div>`;
  }
  return `
    <table>
      <thead>
        <tr>
          <th>Port</th>
          <th>Address</th>
          <th>Process</th>
          <th>PID</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${servers.map((server) => {
          const key = `${server.pid}:${server.port}`;
          const disabled = server.protected || serverBusy.has(key) ? "disabled" : "";
          const label = server.protected ? "Protected" : serverBusy.has(key) ? "Killing" : "Kill";
          return `
            <tr>
              <td><a href="${esc(server.url)}" target="_blank" rel="noreferrer">${esc(server.port)}</a></td>
              <td><code>${esc(server.address)}</code></td>
              <td>${esc(server.processName || "unknown")}</td>
              <td><code>${esc(server.pid)}</code></td>
              <td><button class="danger compact" type="button" data-kill-pid="${esc(server.pid)}" data-kill-key="${esc(key)}" ${disabled}>${esc(label)}</button></td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

async function loadServers() {
  if (serversLoading) return;
  serversLoading = true;
  try {
    if (!networkLoaded) serversEl.innerHTML = `<div class="empty scan-progress">Scanning local TCP listeners...</div>`;
    const response = await fetch("/api/listeners", { cache: "no-store" });
    const servers = await response.json();
    if (!response.ok || servers.error) {
      throw new Error(servers.error || `Request failed with ${response.status}`);
    }
    serversEl.innerHTML = serverRows(servers);
    networkLoaded = true;
  } catch (error) {
    serversEl.innerHTML = `<div class="error">Unable to scan servers: ${esc(error.message)}</div>`;
  } finally {
    serversLoading = false;
  }
}

async function deleteConfiguredProject(id, name) {
  if (!confirm(`Remove ${name} from Rocketman? This does not delete the project files.`)) return;
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || `Request failed with ${response.status}`);
    lastProjectsMarkup = "";
    await loadProjects();
  } catch (error) {
    alert(error.message);
  }
}

function selectTab(name) {
  activeTab = name;
  for (const button of tabButtons) {
    const selected = button.dataset.tab === name;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const panel of tabPanels) panel.hidden = panel.id !== `${name}-view`;
  refreshBtn.textContent = name === "projects" ? "Refresh" : "Scan now";
  if (name === "network" && !networkLoaded) loadServers();
}

function openProjectDialog(seed = null) {
  projectForm.reset();
  projectForm.elements.name.value = seed?.name || "";
  projectForm.elements.description.value = seed?.description || "";
  projectForm.elements.preferredPort.value = seed?.preferredPort || "3000";
  projectForm.elements.urlTemplate.value = seed?.urlTemplate || "http://localhost:{port}";
  projectForm.elements.healthTemplate.value = seed?.healthTemplate || "http://localhost:{port}";
  projectForm.elements.tags.value = seed?.tags || "";
  projectFormError.hidden = true;
  projectDialog.showModal();
}

function closeProjectDialog() {
  if (!saveProjectBtn.disabled) projectDialog.close();
}

async function submitProject(event) {
  event.preventDefault();
  projectFormError.hidden = true;
  saveProjectBtn.disabled = true;
  saveProjectBtn.textContent = "Adding...";
  const formData = new FormData(projectForm);
  const payload = Object.fromEntries(formData.entries());
  payload.preferredPort = Number(payload.preferredPort);
  payload.tags = String(payload.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);
  try {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || `Request failed with ${response.status}`);
    projectDialog.close();
    lastProjectsMarkup = "";
    await loadProjects();
  } catch (error) {
    projectFormError.textContent = error.message;
    projectFormError.hidden = false;
  } finally {
    saveProjectBtn.disabled = false;
    saveProjectBtn.textContent = "Add project";
  }
}

async function postAction(action, id) {
  const transition = action === "start" ? "launching" : action === "stop" ? "landing" : null;
  if (transition) transitions.set(id, { state: transition, startedAt: performance.now() });
  busy.add(id);
  await loadProjects();
  try {
    const request = fetch(`/api/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const transitionDuration = action === "start" ? 3600 : action === "stop" ? 3200 : 0;
    const [response] = await Promise.all([request, transition ? wait(transitionDuration) : Promise.resolve()]);
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(payload.error || `Request failed with ${response.status}`);
    }
  } catch (error) {
    alert(error.message);
  } finally {
    busy.delete(id);
    transitions.delete(id);
    await loadProjects();
  }
}

async function killServer(pid, key) {
  if (!confirm(`Kill server process PID ${pid}?`)) return;
  serverBusy.add(key);
  await loadServers();
  try {
    const response = await fetch("/api/kill-listener", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(payload.error || `Request failed with ${response.status}`);
    }
  } catch (error) {
    alert(error.message);
  } finally {
    serverBusy.delete(key);
    await Promise.all([loadProjects(), loadServers()]);
  }
}

async function openGhostServer(pid, port) {
  try {
    const response = await fetch("/api/open-listener", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid, port }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || `Request failed with ${response.status}`);
  } catch (error) {
    alert(error.message);
  }
}

projectsEl.addEventListener("click", (event) => {
  const adoptButton = event.target.closest("button[data-adopt-port]");
  if (adoptButton) {
    const processLabel = adoptButton.dataset.adoptProcess.replace(/\.exe$/i, "");
    const port = Number(adoptButton.dataset.adoptPort);
    openProjectDialog({
      name: `${processLabel} server`,
      description: `Adopted live server on port ${port}.`,
      preferredPort: port,
      urlTemplate: "http://localhost:{port}",
      healthTemplate: "http://localhost:{port}",
      tags: `Adopted, ${adoptButton.dataset.adoptProcess}`,
    });
    return;
  }
  const openGhostButton = event.target.closest("button[data-open-ghost-port]");
  if (openGhostButton) {
    openGhostServer(Number(openGhostButton.dataset.openGhostPid), Number(openGhostButton.dataset.openGhostPort));
    return;
  }
  const deleteButton = event.target.closest("button[data-delete-id]");
  if (deleteButton) {
    deleteConfiguredProject(deleteButton.dataset.deleteId, deleteButton.dataset.deleteName);
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  postAction(button.dataset.action, button.dataset.id);
});

serversEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-kill-pid]");
  if (!button) return;
  killServer(Number(button.dataset.killPid), button.dataset.killKey);
});

refreshBtn.addEventListener("click", () => activeTab === "projects" ? loadProjects() : loadServers());
addProjectBtn.addEventListener("click", () => openProjectDialog());
projectForm.addEventListener("submit", submitProject);
for (const button of document.querySelectorAll("[data-close-dialog]")) button.addEventListener("click", closeProjectDialog);
for (const button of tabButtons) button.addEventListener("click", () => selectTab(button.dataset.tab));
projectDialog.addEventListener("click", (event) => {
  if (event.target === projectDialog) closeProjectDialog();
});

await loadProjects();
setInterval(loadProjects, 3000);
setInterval(() => {
  if (activeTab === "network") loadServers();
}, 5000);

function connectLiveReload() {
  if (!window.EventSource) return;
  const events = new EventSource("/api/events");
  events.addEventListener("hello", (event) => {
    const { bootId } = JSON.parse(event.data);
    const previous = sessionStorage.getItem(bootStorageKey);
    sessionStorage.setItem(bootStorageKey, bootId);
    if (previous && previous !== bootId) window.location.reload();
  });
  events.addEventListener("reload", () => {
    window.location.reload();
  });
}

connectLiveReload();
