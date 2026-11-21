/*
 * Open the winning OTA flight and leave the browser on its fare/checkout page.
 *
 * This runs detached from the Electron main process. It reuses the same
 * persistent profile that was used for the manual Ctrip/Trip.com login, so the
 * checkout URL keeps its session. It never returns prices; its only job is to
 * put the user in front of the exact flight the assistant recommended.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const profile =
  process.env.CYRVIS_OTA_PROFILE ||
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'CYRVIS', 'ota-profile')
    : 'C:/Users/Administrator/AppData/Local/CYRVIS/ota-profile');
const chrome = [
  process.env.CYRVIS_OTA_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean).find((name) => fs.existsSync(name));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = async (locator) =>
  (await locator.innerText().catch(() => '')).trim();

const ctripUrl = (origin, destination, date) =>
  `https://flights.ctrip.com/online/list/oneway-${origin.toLowerCase()}-${destination.toLowerCase()}?depdate=${date}&cabin=y&adult=1`;

const tripUrl = (origin, destination, date) =>
  `https://www.trip.com/flights/showfarefirst?dcity=${origin}&acity=${destination}&ddate=${date}&triptype=ow&class=y&quantity=1&locale=zh-CN&curr=CNY`;

async function focusCtrip(context, page, request) {
  await page.goto('https://flights.ctrip.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const names = new Set((await context.cookies()).map((cookie) => cookie.name));
    if (names.has('_bfa') && names.has('FVP')) break;
    await sleep(250);
  }
  await page.goto(ctripUrl(request.origin, request.destination, request.date), {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.waitForSelector('div.flight-item.domestic', { timeout: 25000 });
  const items = page.locator('div.flight-item.domestic');
  const count = await items.count();
  let target = null;
  for (let i = 0; i < count; i += 1) {
    const item = items.nth(i);
    const all = await text(item);
    const matchesFlight =
      request.flightNo && all.includes(request.flightNo);
    const matchesPrice =
      request.price && all.replace(/,/g, '').includes(String(request.price));
    const matchesAirline =
      request.airline && all.includes(request.airline);
    if (matchesFlight || (matchesPrice && matchesAirline)) {
      target = item;
      break;
    }
  }
  if (!target) throw new Error('ctrip_winning_flight_not_found');
  await target.locator('button.btn-book').first().click();
  await sleep(2200);
  const book = target
    .locator('button.btn-book')
    .filter({ hasText: '预订' })
    .first();
  if (!(await book.count())) throw new Error('ctrip_fare_button_not_found');
  await book.click();
  await page
    .waitForURL(/itinerary\/checkout/i, { timeout: 15000 })
    .catch(() => undefined);
  await page.bringToFront().catch(() => undefined);
}

async function focusTrip(context, page, request) {
  await page.goto(tripUrl(request.origin, request.destination, request.date), {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.waitForSelector('div.result-item.J_FlightItem', {
    timeout: 25000,
  });
  const cards = page.locator('div.result-item.J_FlightItem');
  const count = await cards.count();
  let target = null;
  for (let i = 0; i < count; i += 1) {
    const card = cards.nth(i);
    const all = await text(card);
    if (
      (request.price && all.replace(/,/g, '').includes(String(request.price))) ||
      (request.airline && all.includes(request.airline))
    ) {
      target = card;
      break;
    }
  }
  if (!target) throw new Error('trip_winning_flight_not_found');
  await target.locator('button').first().click();
  await page.waitForTimeout(5000);
  await page.bringToFront().catch(() => undefined);
}

async function main() {
  const request = JSON.parse(process.argv[2] || '{}');
  if (!chrome) throw new Error('chrome_not_found');
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: chrome,
    args: ['--disable-blink-features=AutomationControlled'],
    locale: 'zh-CN',
    viewport: { width: 1400, height: 1000 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  try {
    if (request.source === 'ctrip') {
      await focusCtrip(context, page, request);
    } else if (request.source === 'trip') {
      await focusTrip(context, page, request);
    } else {
      throw new Error('unknown_source');
    }
    console.log('FOCUS_READY', page.url());
  } catch (error) {
    console.log('FOCUS_FAILED', error.message);
    await page.bringToFront().catch(() => undefined);
  }

  // Keep the visible browser open for the user. It closes when the user closes
  // the window (or after 30 minutes as a safety valve).
  const closed = new Promise((resolve) => context.on('close', resolve));
  await Promise.race([closed, sleep(30 * 60 * 1000)]);
  await context.close().catch(() => undefined);
}

main().catch((error) => {
  console.log('FOCUS_FAILED', error && error.message ? error.message : error);
  process.exitCode = 1;
});
