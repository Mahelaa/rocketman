import { chromium } from "playwright-core";

const chromePath = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let running = false;
let startedAt = null;

const project = () => ({
  id: "transition-test",
  name: "Transition Test",
  description: "Lifecycle animation regression fixture.",
  tags: ["Test"],
  preferredPort: 4567,
  port: 4567,
  pid: running ? 45670 : null,
  launcherPid: running ? 45670 : null,
  running,
  listening: running,
  healthy: false,
  startedAt,
  url: "http://localhost:4567",
});

await page.route("**/api/projects", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify([project()]),
}));
await page.route("**/api/start", async (route) => {
  setTimeout(() => {
    running = true;
    startedAt = new Date().toISOString();
  }, 900);
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
});
await page.route("**/api/stop", async (route) => {
  setTimeout(() => {
    running = false;
    startedAt = null;
  }, 650);
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
});

const waitForState = (value, timeout = 7000) => page.waitForFunction(
  (expected) => document.querySelector(".ascii-viewport")?.dataset.asciiState === expected,
  value,
  { timeout },
);

async function sceneFrame() {
  return page.locator(".ascii-viewport").evaluate((viewport) => {
    const text = (name) => viewport.querySelector(`.ascii-${name}-layer`)?.textContent || "";
    const glyphs = (name) => text(name).replace(/\s/g, "").length;
    return {
      state: viewport.dataset.asciiState,
      rocket: text("rocket"),
      environment: glyphs("environment"),
      stars: glyphs("stars"),
      smoke: glyphs("smoke"),
      facility: glyphs("facility"),
      pad: glyphs("pad"),
      flame: glyphs("flame"),
    };
  });
}

function frameDifference(left, right) {
  const length = Math.max(left.length, right.length);
  let changed = 0;
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) changed += 1;
  }
  return changed;
}

async function runCycle(cycle) {
  await page.locator('[data-action="start"]').click();
  await waitForState("launching");
  await page.waitForTimeout(260);
  const ignition = await sceneFrame();
  await page.waitForTimeout(650);
  const atmosphere = await sceneFrame();
  await page.waitForTimeout(770);
  const orbitInsertion = await sceneFrame();
  await waitForState("running");
  const cruise = await sceneFrame();

  await page.locator('[data-action="stop"]').click();
  await waitForState("landing");
  await page.waitForTimeout(320);
  const reentry = await sceneFrame();
  await page.waitForTimeout(1350);
  const approach = await sceneFrame();
  await page.waitForTimeout(940);
  const touchdown = await sceneFrame();
  await waitForState("stopped");
  const landed = await sceneFrame();

  const failures = [];
  if (ignition.pad < 10 || ignition.facility < 10 || ignition.flame < 2) failures.push("ignition complex");
  if (atmosphere.environment < 10 || atmosphere.stars < 8 || atmosphere.flame < 8) failures.push("atmospheric ascent");
  if (orbitInsertion.pad !== 0 || orbitInsertion.stars < 12 || orbitInsertion.flame < 8) failures.push("orbit insertion");
  if (cruise.stars < 12 || cruise.flame < 8) failures.push("cruise");
  if (reentry.stars < 8 || reentry.flame < 8) failures.push("re-entry");
  if (approach.environment < 10 || approach.pad < 10) failures.push("landing approach");
  if (touchdown.pad < 10 || touchdown.facility < 10) failures.push("touchdown");
  if (landed.pad < 10 || landed.facility < 10 || landed.flame !== 0) failures.push("landed");
  const launchHandoffDifference = frameDifference(orbitInsertion.rocket, cruise.rocket);
  const landingHandoffDifference = frameDifference(touchdown.rocket, landed.rocket);
  if (launchHandoffDifference > 12) failures.push(`launch handoff continuity (${launchHandoffDifference} cells)`);
  if (landingHandoffDifference > 12) failures.push(`landing handoff continuity (${landingHandoffDifference} cells)`);
  if (failures.length) throw new Error(`Cycle ${cycle} lost animation stages: ${failures.join(", ")}`);

  return { ignition, atmosphere, orbitInsertion, cruise, reentry, approach, touchdown, landed, launchHandoffDifference, landingHandoffDifference };
}

try {
  await page.goto("http://localhost:7777", { waitUntil: "domcontentloaded" });
  await waitForState("stopped");
  const first = await runCycle(1);
  const second = await runCycle(2);
  const stageNames = ["ignition", "atmosphere", "orbitInsertion", "cruise", "reentry", "approach", "touchdown", "landed"];
  console.log(JSON.stringify({
    cycles: 2,
    finalState: second.landed.state,
    handoffDifferences: {
      first: [first.launchHandoffDifference, first.landingHandoffDifference],
      second: [second.launchHandoffDifference, second.landingHandoffDifference],
    },
    firstStageGlyphs: Object.fromEntries(stageNames.map((name) => [name, first[name].rocket.replace(/\s/g, "").length])),
    secondStageGlyphs: Object.fromEntries(stageNames.map((name) => [name, second[name].rocket.replace(/\s/g, "").length])),
  }));
} finally {
  await browser.close();
}
