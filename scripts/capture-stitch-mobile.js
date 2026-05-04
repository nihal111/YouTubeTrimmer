#!/usr/bin/env node

const path = require('path');
const { chromium, devices } = require('playwright');

const outputPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(process.cwd(), 'tmp-mobile-transition.png');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ...devices['iPhone 13'] });

  await context.addInitScript(() => {
    localStorage.setItem('stitcher_clips', JSON.stringify([
      {
        id: 'clip-a',
        type: 'youtube',
        youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
        videoId: 'dQw4w9WgXcQ',
        title: 'Clip One',
        duration: 12,
        trimStart: 1,
        trimEnd: 6
      },
      {
        id: 'clip-b',
        type: 'youtube',
        youtubeUrl: 'https://youtu.be/9bZkp7q19f0',
        videoId: '9bZkp7q19f0',
        title: 'Clip Two',
        duration: 15,
        trimStart: 2,
        trimEnd: 9
      }
    ]));

    localStorage.setItem('stitcher_transitions', JSON.stringify([
      { type: 'crossfade', duration: 0.5 }
    ]));
  });

  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto('http://127.0.0.1:5173/stitch', { waitUntil: 'load', timeout: 10000 });
  await page.waitForTimeout(1500);

  const control = page.locator('.transition-control-row').first();
  await control.scrollIntoViewIfNeeded();
  await page.screenshot({ path: outputPath, fullPage: true });

  console.log(outputPath);
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
