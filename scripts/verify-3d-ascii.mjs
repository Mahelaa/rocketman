import { chromium } from "playwright-core";
import { resolve } from "node:path";

const chrome = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const dashboard = "http://localhost:7777";
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});

const errors = [];
let listenerRequests = 0;
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (new URL(request.url()).pathname === "/api/listeners") listenerRequests += 1;
});

try {
  await page.goto(dashboard, { waitUntil: "domcontentloaded" });
  const configuredProjects = await page.evaluate(async () => {
    const response = await fetch("/api/projects", { cache: "no-store" });
    return (await response.json()).length;
  });
  try {
    await page.waitForFunction(() => {
      const outputs = [...document.querySelectorAll(".ascii-rocket-layer")];
      return outputs.length > 0 && outputs.every((output) => output.textContent.replace(/\s/g, "").length > 35);
    }, null, { timeout: 15000 });
    const renderedProjects = await page.locator(".project").count();
    if (renderedProjects !== configuredProjects) {
      throw new Error(`Expected ${configuredProjects} project cards, rendered ${renderedProjects}.`);
    }
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      cards: document.querySelectorAll(".project").length,
      effects: document.querySelectorAll(".ascii-rocket-layer").length,
      fallbacks: [...document.querySelectorAll(".ascii-fallback")].map((item) => item.textContent),
      glyphs: [...document.querySelectorAll(".ascii-rocket-layer")].map((item) => item.textContent.replace(/\s/g, "").length),
    }));
    throw new Error(`${error.message}; diagnostics=${JSON.stringify(diagnostics)}; console=${errors.join(" | ")}`);
  }
  if (listenerRequests !== 0) throw new Error("Network scan ran before the Network tab was opened.");

  await page.locator("#add-project").click();
  await page.locator("#project-dialog").waitFor({ state: "visible" });
  const formFields = await page.locator("#project-form input").count();
  if (formFields < 8) throw new Error(`Project form is incomplete: ${formFields} fields found.`);
  await page.screenshot({ path: resolve("data", "project-dialog-desktop.png"), fullPage: false });
  await page.locator("[data-close-dialog]").last().click();

  const ghostAdoptButton = page.locator("[data-adopt-port]").first();
  if (await ghostAdoptButton.count()) {
    const discoveredPort = await ghostAdoptButton.getAttribute("data-adopt-port");
    await ghostAdoptButton.click();
    await page.locator("#project-dialog").waitFor({ state: "visible" });
    const adoptedPort = await page.locator('#project-form input[name="preferredPort"]').inputValue();
    const adoptedName = await page.locator('#project-form input[name="name"]').inputValue();
    if (adoptedPort !== discoveredPort || !adoptedName.trim()) {
      throw new Error(`Ghost adoption form was not prefilled correctly: ${adoptedName}, ${adoptedPort}`);
    }
    await page.locator("[data-close-dialog]").last().click();
  }

  const desktopStats = await page.locator(".ascii-viewport").evaluateAll((viewports) => viewports.map((viewport) => ({
    glyphs: viewport.querySelector(".ascii-rocket-layer")?.textContent.replace(/\s/g, "").length || 0,
    width: Math.round(viewport.getBoundingClientRect().width),
    height: Math.round(viewport.getBoundingClientRect().height),
  })));
  await page.screenshot({ path: resolve("data", "3d-ascii-desktop.png"), fullPage: true });

  await page.locator(".ascii-viewport").evaluateAll((viewports) => {
    const states = ["launching", "running", "landing", "stopped"];
    viewports.slice(0, states.length).forEach((viewport, index) => {
      viewport.dataset.asciiState = states[index];
    });
  });
  await page.waitForTimeout(350);
  const motionBefore = await page.locator(".ascii-viewport").evaluateAll((viewports) => viewports.slice(0, 4).map((viewport) => ({
    rocket: viewport.querySelector(".ascii-rocket-layer")?.textContent || "",
    accent: viewport.querySelector(".ascii-accent-layer")?.textContent || "",
    pad: viewport.querySelector(".ascii-pad-layer")?.textContent || "",
    stars: viewport.querySelector(".ascii-stars-layer")?.textContent || "",
    flame: viewport.querySelector(".ascii-flame-layer")?.textContent || "",
  })));
  const stateStats = await page.locator(".ascii-viewport").evaluateAll((viewports) => viewports.slice(0, 3).map((viewport) => ({
    state: viewport.dataset.asciiState,
    environment: viewport.querySelector(".ascii-environment-layer")?.textContent.replace(/\s/g, "").length || 0,
    pad: viewport.querySelector(".ascii-pad-layer")?.textContent.replace(/\s/g, "").length || 0,
    stars: viewport.querySelector(".ascii-stars-layer")?.textContent.replace(/\s/g, "").length || 0,
    flame: viewport.querySelector(".ascii-flame-layer")?.textContent.replace(/\s/g, "").length || 0,
  })));
  if (stateStats[0].pad < 10 || stateStats[0].flame < 2) throw new Error(`Invalid pre-flight state: ${JSON.stringify(stateStats[0])}`);
  if (stateStats[1].pad !== 0 || stateStats[1].stars < 12 || stateStats[1].flame < 8) throw new Error(`Invalid running state: ${JSON.stringify(stateStats[1])}`);
  if (stateStats[2].stars < 8 || stateStats[2].flame < 2) throw new Error(`Invalid re-entry state: ${JSON.stringify(stateStats[2])}`);

  const runningGeometry = await page.locator(".ascii-viewport").nth(1).evaluate((viewport) => {
    const bounds = (selector) => {
      const lines = (viewport.querySelector(selector)?.textContent || "").split("\n");
      const points = [];
      lines.forEach((line, row) => [...line].forEach((char, column) => {
        if (char !== " ") points.push({ row, column });
      }));
      return {
        minRow: Math.min(...points.map((point) => point.row)),
        maxRow: Math.max(...points.map((point) => point.row)),
      };
    };
    return { rocket: bounds(".ascii-rocket-layer"), flame: bounds(".ascii-flame-layer") };
  });
  if (runningGeometry.flame.maxRow <= runningGeometry.rocket.maxRow) {
    throw new Error(`Running exhaust does not trail behind the rocket: ${JSON.stringify(runningGeometry)}`);
  }

  const scanlineContent = await page.locator(".ascii-viewport").first().evaluate((viewport) => ({
    before: getComputedStyle(viewport, "::before").content,
    after: getComputedStyle(viewport, "::after").content,
  }));
  if (!["none", "normal"].includes(scanlineContent.before) || !["none", "normal"].includes(scanlineContent.after)) {
    throw new Error(`Scanline overlays are still present: ${JSON.stringify(scanlineContent)}`);
  }
  await page.waitForTimeout(600);
  const motionAfter = await page.locator(".ascii-viewport").evaluateAll((viewports) => viewports.slice(0, 4).map((viewport) => ({
    rocket: viewport.querySelector(".ascii-rocket-layer")?.textContent || "",
    accent: viewport.querySelector(".ascii-accent-layer")?.textContent || "",
    pad: viewport.querySelector(".ascii-pad-layer")?.textContent || "",
    stars: viewport.querySelector(".ascii-stars-layer")?.textContent || "",
    flame: viewport.querySelector(".ascii-flame-layer")?.textContent || "",
  })));
  const motionChanges = motionBefore.map((frame, index) => ({
    rocket: frame.rocket !== motionAfter[index].rocket,
    model: frame.rocket !== motionAfter[index].rocket || frame.accent !== motionAfter[index].accent || frame.pad !== motionAfter[index].pad,
    stars: frame.stars !== motionAfter[index].stars,
    flame: frame.flame !== motionAfter[index].flame,
  }));
  if (!motionChanges[0].rocket || !motionChanges[0].flame) throw new Error(`Launch animation is static: ${JSON.stringify(motionChanges[0])}`);
  if (!motionChanges[1].rocket || !motionChanges[1].stars || !motionChanges[1].flame) throw new Error(`Running animation is static: ${JSON.stringify(motionChanges[1])}`);
  if (!motionChanges[2].rocket || !motionChanges[2].stars) throw new Error(`Re-entry animation is static: ${JSON.stringify(motionChanges[2])}`);
  if (motionChanges[3].model || motionChanges[3].stars || motionChanges[3].flame) {
    throw new Error(`Stopped rocket must remain static: ${JSON.stringify(motionChanges[3])}`);
  }
  await page.screenshot({ path: resolve("data", "3d-ascii-states.png"), fullPage: false });

  const listenerResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/listeners");
  await page.locator("#network-tab").click();
  await listenerResponse;
  await page.locator("#network-view").waitFor({ state: "visible" });
  if (listenerRequests !== 1) throw new Error(`Expected one lazy network scan, received ${listenerRequests}.`);
  await page.screenshot({ path: resolve("data", "network-tab-desktop.png"), fullPage: false });
  await page.locator("#projects-tab").click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  await page.screenshot({ path: resolve("data", "3d-ascii-mobile.png"), fullPage: true });

  if (errors.length) throw new Error(`Browser errors: ${errors.join(" | ")}`);
  if (mobileOverflow) throw new Error("The 3D ASCII dashboard overflows horizontally on mobile.");
  console.log(JSON.stringify({ desktopStats, stateStats, motionChanges, ghostAdoption: await ghostAdoptButton.count() > 0, mobileOverflow, browserErrors: errors.length }));
} finally {
  await browser.close();
}
