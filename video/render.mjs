// Renders launch.html to an MP4: every frame is a pure function of time, screenshotted at 1920x1080 and piped to ffmpeg.
// Usage: node video/render.mjs stills 2 6 12   |   node video/render.mjs video [out.mp4] [audio.m4a]
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const [,, mode = "stills", ...rest] = process.argv;
const FPS = 30, SECONDS = 30, W = Number(process.env.W) || 1920, H = Number(process.env.H) || 1080;
const exe = process.env.CHROME_PATH || `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.goto("file://" + path.join(here, process.env.PAGE || "launch.html"));
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
if (mode === "stills") {
  for (const t of rest.map(Number)) { await page.evaluate((x) => window.render(x), t); await page.screenshot({ path: path.join(process.env.OUT || here, `still-${String(t).replace(".", "_")}.png`) }); }
} else {
  const out = rest[0] || path.join(here, "otto-launch.mp4"), audio = rest[1];
  const args = ["-y", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-", ...(audio ? ["-i", audio] : []),
    "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart",
    ...(audio ? ["-c:a", "aac", "-b:a", "192k", "-shortest"] : []), "-t", String(SECONDS), out];
  const ff = spawn("/opt/homebrew/bin/ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });
  const n = FPS * SECONDS;
  for (let i = 0; i < n; i++) {
    await page.evaluate((x) => window.render(x), i / FPS);
    const png = await page.screenshot({ type: "png" });
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % 90 === 0) console.log(`frame ${i}/${n}`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  console.log("wrote", out);
}
await browser.close();
