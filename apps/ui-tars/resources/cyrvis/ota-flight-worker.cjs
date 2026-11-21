/*
 * Best-effort one-way OTA scraper for the CYRVIS demo.
 *
 * Ctrip and Trip.com block headless automation, so this worker deliberately
 * launches a visible Chrome window. It makes ONE attempt per site and never
 * retries automatically: a slow/blocked site is reported as unavailable and
 * the brain falls back to Google Flights only.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const CHROME_CANDIDATES = [
  process.env.CYRVIS_OTA_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const text = async (locator) =>
  (await locator.innerText().catch(() => '')).trim();

const parseNumber = (value) => {
  const match = String(value || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
};

const ctripUrl = (origin, destination, date) =>
  `https://flights.ctrip.com/online/list/oneway-${origin.toLowerCase()}-${destination.toLowerCase()}?depdate=${date}&cabin=y&adult=1`;

const tripUrl = (origin, destination, date) =>
  `https://www.trip.com/flights/showfarefirst?dcity=${origin}&acity=${destination}&ddate=${date}&triptype=ow&class=y&quantity=1&locale=zh-CN&curr=CNY`;

async function waitForCtripSession(context, page, timeoutMs = 20000) {
  if (context['__ctripSessionReady']) return;
  await page.goto('https://flights.ctrip.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = new Set((await context.cookies()).map((c) => c.name));
    if (names.has('_bfa') && names.has('FVP')) {
      context['__ctripSessionReady'] = true;
      return;
    }
    await sleep(250);
  }
  throw new Error('ctrip_session_cookies_missing:_bfa/FVP');
}

async function scrapeCtrip(page, context, url) {
  // Ctrip's batchSearch only returns the full itinerary list after the
  // homepage has generated the _bfa/FVP session cookies. Listen to the
  // response; do NOT route/fulfill it (that breaks the signature context).
  await waitForCtripSession(context, page);
  const captured = { json: null, error: null };
  const onResponse = (resp) => {
    if (!/batchsearch/i.test(resp.url()) || captured.json || captured.error) {
      return;
    }
    resp
      .json()
      .then((json) => {
        captured.json = json;
      })
      .catch((error) => {
        captured.error = String(error?.message || error);
      });
  };
  page.on('response', onResponse);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const deadline = Date.now() + 25000;
    while (!captured.json && !captured.error && Date.now() < deadline) {
      await sleep(250);
    }
  } finally {
    page.removeListener('response', onResponse);
  }
  if (!captured.json) {
    throw new Error(
      `ctrip_batchsearch_not_captured:${captured.error || 'timeout'}`,
    );
  }
  const body = captured.json;
  if (body.status !== 0 || body.msg !== 'success') {
    throw new Error(
      `ctrip_api_error:status=${body.status},msg=${body.msg}`,
    );
  }
  const itineraries = body.data?.flightItineraryList || [];
  const needLogin = body.data?.needUserLogin === true;
  if (!itineraries.length) {
    throw new Error(
      `ctrip_empty_itinerary_list:needUserLogin=${needLogin}`,
    );
  }

  const offers = [];
  for (const itinerary of itineraries.slice(0, 40)) {
    const segment = itinerary.flightSegments?.[0];
    const flights = segment?.flightList || [];
    if (!segment || !flights.length) continue;
    const first = flights[0];
    const last = flights[flights.length - 1];
    const priceList = (itinerary.priceList || []).filter(
      (price) =>
        !(price.servicePackage && Number(price.servicePackage.price) > 0),
    );
    if (!priceList.length) continue;
    // Ctrip's adultPrice is the base fare; adultTax carries airport/fuel
    // charges. Comparing base fares alone surfaced a 66 CNY HK Express fare
    // while Trip.com showed 537 CNY for the same flight.
    const totalOf = (entry) =>
      Number(entry.adultPrice || 0) + Number(entry.adultTax || 0);
    const bestPrice = priceList.reduce((best, current) =>
      totalOf(current) < totalOf(best) ? current : best,
    );
    const price = totalOf(bestPrice);
    if (!price) continue;
    const flightNo = flights
      .map((flight) => flight.flightNo || '')
      .filter(Boolean)
      .join('-');
    const airline =
      first.marketAirlineName || first.operateAirlineName || '航班';
    const departure = (first.departureDateTime || '').slice(11, 16);
    const arrival = (last.arrivalDateTime || '').slice(11, 16);
    const stops = Number(segment.transferCount || 0);
    offers.push({
      id: `ctrip-${itinerary.itineraryId || flightNo}-${price}`,
      source: 'ctrip',
      sourceLabel: '携程',
      airline,
      flightNo,
      price,
      currency: 'CNY',
      departure,
      arrival,
      durationMinutes: Number(segment.duration) || undefined,
      stops,
      direct: stops === 0,
      url,
      ...(process.env.CYRVIS_OTA_DEBUG === '1'
        ? { debugPrice: bestPrice }
        : {}),
    });
  }
  return offers;
}

async function scrapeTrip(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('div.result-item.J_FlightItem', { timeout: 25000 });
  const cards = page.locator('div.result-item.J_FlightItem');
  const count = await cards.count();
  const offers = [];
  for (let i = 0; i < Math.min(count, 20); i += 1) {
    const card = cards.nth(i);
    const airline = await text(card.locator('.flights-name').first());
    const info = await card
      .locator('.flight-info.is-v2')
      .first()
      .getAttribute('aria-label')
      .catch(() => '');
    const label = info || '';
    const price = parseNumber(label.match(/price:\s*[A-Z]{3}\s*([\d,]+)/i)?.[1]);
    const dep =
      label.match(/at\s+\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2}):\d{2}/)?.[1] || '';
    const arr =
      label.match(/arriving at[\s\S]*?at\s+\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2}):\d{2}/)?.[1] ||
      '';
    const durationMatch = label.match(/duration of\s+(\d+)h(?:\s*(\d+)m)?/i);
    const durationMinutes = durationMatch
      ? Number(durationMatch[1]) * 60 + Number(durationMatch[2] || 0)
      : undefined;
    const stops = /nonstop/i.test(label)
      ? 0
      : Number(label.match(/(\d+)\s+stop/i)?.[1] || 1);
    if (!airline || !price) continue;
    offers.push({
      id: `trip-${airline}-${dep}-${price}`,
      source: 'trip',
      sourceLabel: 'Trip.com',
      airline,
      flightNo: '',
      price,
      currency: 'CNY',
      departure: dep,
      arrival: arr,
      durationMinutes,
      stops,
      direct: stops === 0,
      url,
    });
  }
  return offers;
}

async function main() {
  let request;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    request = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: `bad_request:${error}` }),
    );
    return;
  }

  const origin = String(request.origin || '').toUpperCase();
  const destination = String(request.destination || '').toUpperCase();
  const date = String(request.date || '');
  if (!origin || !destination || !date) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: 'origin_destination_date_required' }),
    );
    return;
  }
  if (!chromePath) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: 'chrome_not_found' }),
    );
    return;
  }

  const sources = {
    ctrip: { ok: false, count: 0, error: null },
    trip: { ok: false, count: 0, error: null },
  };
  const offers = [];
  // Price scraping must not share the persistent profile used by the focus
  // worker: that worker intentionally leaves Chrome open on the winning fare
  // page, which keeps a SingletonLock and prevents the next comparison from
  // launching. A fresh temporary profile per search avoids the lock; Ctrip's
  // homepage still sets the _bfa/FVP cookies needed by batchSearch.
  const ephemeralProfile = !process.env.CYRVIS_OTA_SEARCH_PROFILE;
  const profileDir =
    process.env.CYRVIS_OTA_SEARCH_PROFILE ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'cyrvis-ota-search-'));
  fs.mkdirSync(profileDir, { recursive: true });
  const cleanupProfile = () => {
    if (!ephemeralProfile) return;
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // Best effort: the OS temp cleaner will remove leftovers.
    }
  };
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: process.env.CYRVIS_OTA_HEADLESS === '1',
      executablePath: chromePath,
      args: ['--disable-blink-features=AutomationControlled'],
      locale: 'zh-CN',
      viewport: { width: 1400, height: 1000 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    });

    for (const source of ['ctrip', 'trip']) {
      const page = await context.newPage();
      const url =
        source === 'ctrip'
          ? ctripUrl(origin, destination, date)
          : tripUrl(origin, destination, date);
      try {
        const scraped =
          source === 'ctrip'
            ? await scrapeCtrip(page, context, url)
            : await scrapeTrip(page, url);
        sources[source].ok = scraped.length > 0;
        sources[source].count = scraped.length;
        offers.push(...scraped);
      } catch (error) {
        sources[source].error = String(error && error.message ? error.message : error);
      } finally {
        await page.close().catch(() => undefined);
      }
      // Be polite between sites; one attempt only.
      await sleep(800);
    }
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: `browser_failed:${error && error.message ? error.message : error}`,
        sources,
      }),
    );
    if (context) await context.close().catch(() => undefined);
    cleanupProfile();
    return;
  }
  await context.close().catch(() => undefined);
  cleanupProfile();

  offers.sort((a, b) => a.price - b.price || a.stops - b.stops);
  process.stdout.write(
    JSON.stringify({
      ok: offers.length > 0,
      source: 'ota',
      sources,
      offers: offers.slice(0, 30),
    }),
  );
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: `worker_failed:${error && error.message ? error.message : error}`,
    }),
  );
});
