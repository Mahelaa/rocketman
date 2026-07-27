import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourcePath = path.join(root, "public", "logo.png");
const outputPaths = [
  path.join(root, "public", "rocketman-logo.png"),
  path.join(root, "public", "favicon.png"),
  path.join(root, "build", "icon.png"),
];
const chromePath = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Logo source not found: ${sourcePath}`);
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
await page.goto(`file://${sourcePath.replaceAll("\\", "/")}`);

const png = await page.evaluate(async () => {
  const image = document.querySelector("img");
  if (!image) throw new Error("Unable to load logo image");
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const source = canvas.getContext("2d");
  source.drawImage(image, 0, 0);
  const pixels = source.getImageData(0, 0, canvas.width, canvas.height);
  let left = canvas.width;
  let top = canvas.height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const i = (y * canvas.width + x) * 4;
      const dark = pixels.data[i] < 242 || pixels.data[i + 1] < 242 || pixels.data[i + 2] < 242;
      if (dark) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }

  const padding = Math.round(Math.max(right - left + 1, bottom - top + 1) * 0.08);
  left = Math.max(0, left - padding);
  top = Math.max(0, top - padding);
  right = Math.min(canvas.width - 1, right + padding);
  bottom = Math.min(canvas.height - 1, bottom + padding);
  const size = Math.max(right - left + 1, bottom - top + 1);
  const crop = document.createElement("canvas");
  crop.width = size;
  crop.height = size;
  const cropContext = crop.getContext("2d");
  cropContext.drawImage(canvas, left, top, right - left + 1, bottom - top + 1, 0, 0, size, size);

  const output = cropContext.getImageData(0, 0, size, size);
  for (let i = 0; i < output.data.length; i += 4) {
    if (output.data[i] > 246 && output.data[i + 1] > 246 && output.data[i + 2] > 246) output.data[i + 3] = 0;
  }
  cropContext.putImageData(output, 0, 0);

  const finalCanvas = document.createElement("canvas");
  finalCanvas.width = 512;
  finalCanvas.height = 512;
  finalCanvas.getContext("2d").drawImage(crop, 0, 0, 512, 512);
  return finalCanvas.toDataURL("image/png").split(",")[1];
});

await browser.close();
const buffer = Buffer.from(png, "base64");
for (const outputPath of outputPaths) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
}
console.log(`Generated ${outputPaths.length} logo assets from public/logo.png`);
