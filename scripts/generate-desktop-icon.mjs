import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const chromePath = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const svg = await readFile(new URL("../public/rocketman-logo.svg", import.meta.url), "utf8");
await mkdir(new URL("../build/", import.meta.url), { recursive: true });

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:256px;height:256px}</style>${svg}`);
await page.locator("svg").screenshot({
  path: new URL("../build/icon.png", import.meta.url).pathname.slice(1),
  omitBackground: true,
});
await browser.close();
