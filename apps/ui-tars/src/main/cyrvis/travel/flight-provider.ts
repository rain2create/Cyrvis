/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { FlightOffer, FlightSearchInput } from './travel-flight';

export interface LiveFlightSearchResult {
  offers: FlightOffer[];
  source: 'google_flights';
  searchUrl: string;
}

interface WorkerOffer {
  id?: string;
  price?: number;
  currency?: string;
  airlineCode?: string;
  airlineName?: string;
  from?: string;
  to?: string;
  date?: string;
  departure?: string;
  arrival?: string;
  durationMinutes?: number;
  stops?: number;
}

interface WorkerResponse {
  ok?: boolean;
  error?: string;
  detail?: string;
  searchUrl?: string;
  offers?: WorkerOffer[];
}

const CITY_TO_IATA: Record<string, string> = {
  北京: 'BJS',
  上海: 'SHA',
  广州: 'CAN',
  深圳: 'SZX',
  成都: 'CTU',
  重庆: 'CKG',
  杭州: 'HGH',
  南京: 'NKG',
  西安: 'XIY',
  昆明: 'KMG',
  三亚: 'SYX',
  海口: 'HAK',
  厦门: 'XMN',
  鼓浪屿: 'XMN',
  厦门鼓浪屿: 'XMN',
  青岛: 'TAO',
  大连: 'DLC',
  天津: 'TSN',
  长沙: 'CSX',
  武汉: 'WUH',
  郑州: 'CGO',
  济南: 'TNA',
  福州: 'FOC',
  南宁: 'NNG',
  贵阳: 'KWE',
  哈尔滨: 'HRB',
  沈阳: 'SHE',
  长春: 'CGQ',
  乌鲁木齐: 'URC',
  兰州: 'LHW',
  银川: 'INC',
  西宁: 'XNN',
  拉萨: 'LXA',
  丽江: 'LJG',
  大理: 'DLU',
  桂林: 'KWL',
  张家界: 'DYG',
  香港: 'HKG',
  澳门: 'MFM',
  台北: 'TPE',
  东京: 'TYO',
  大阪: 'OSA',
  首尔: 'SEL',
  釜山: 'PUS',
  曼谷: 'BKK',
  清迈: 'CNX',
  普吉: 'HKT',
  新加坡: 'SIN',
  吉隆坡: 'KUL',
  巴厘岛: 'DPS',
  马尔代夫: 'MLE',
  巴黎: 'PAR',
  尼斯: 'NCE',
  伦敦: 'LON',
  罗马: 'ROM',
  米兰: 'MIL',
  巴塞罗那: 'BCN',
  马德里: 'MAD',
  里斯本: 'LIS',
  雅典: 'ATH',
  伊斯坦布尔: 'IST',
  迪拜: 'DXB',
  纽约: 'NYC',
  洛杉矶: 'LAX',
  旧金山: 'SFO',
  西雅图: 'SEA',
  温哥华: 'YVR',
  悉尼: 'SYD',
  墨尔本: 'MEL',
  奥克兰: 'AKL',
};

const cleanCity = (value: string): string =>
  value
    .trim()
    .replace(/(?:市|省|自治区|特别行政区)$/u, '')
    .replace(/\s+/g, '');

/**
 * Resolve a spoken city name to the metro IATA code Google Flights accepts.
 * Metro codes (BJS, SHA, PAR, LON, NYC, TYO) cover all airports in the city.
 */
export const resolveCityIata = (city: string): string | undefined => {
  const cleaned = cleanCity(city);
  if (/^[A-Z]{3}$/.test(cleaned)) return cleaned;
  return CITY_TO_IATA[cleaned];
};

const addDaysIso = (iso: string, days: number): string => {
  const date = new Date(`${iso}T12:00:00`);
  date.setDate(date.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}`;
};

const returnDateFor = (input: FlightSearchInput): string | undefined =>
  input.durationDays && input.durationDays > 0
    ? addDaysIso(input.departDate, input.durationDays)
    : undefined;

export const buildGoogleFlightsUrl = (input: FlightSearchInput): string => {
  const origin = resolveCityIata(input.origin);
  const destination = resolveCityIata(input.destination);
  if (!origin || !destination) {
    throw new Error(`暂不支持这个城市：${input.origin} → ${input.destination}`);
  }
  let queryText = `Flights from ${origin} to ${destination} on ${input.departDate}`;
  const returnDate = returnDateFor(input);
  if (returnDate) queryText += ` returning ${returnDate}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(
    queryText,
  )}&curr=CNY&hl=zh-CN`;
};

const WORKER_CANDIDATES = (): string[] => [
  ...(process.env.CYRVIS_FLIGHT_WORKER
    ? [process.env.CYRVIS_FLIGHT_WORKER]
    : []),
  path.resolve(process.cwd(), 'resources', 'cyrvis', 'flight-worker.py'),
  path.resolve(
    process.cwd(),
    '..',
    '..',
    'resources',
    'cyrvis',
    'flight-worker.py',
  ),
  ...(process.resourcesPath
    ? [path.join(process.resourcesPath, 'cyrvis', 'flight-worker.py')]
    : []),
];

const findWorker = (): string | null =>
  WORKER_CANDIDATES().find((candidate) => fs.existsSync(candidate)) ?? null;

const runWorker = (
  python: string,
  worker: string,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(python, [worker], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        try {
          child.kill();
        } catch {
          // already exited
        }
        reject(error);
      } else {
        resolve(value || '');
      }
    };
    const timer = setTimeout(
      () => finish(new Error('flight_worker_timeout')),
      timeoutMs,
    );

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(
          new Error(
            `flight_worker_exit_${code}:${stderr.trim().slice(0, 500)}`,
          ),
        );
        return;
      }
      finish(null, stdout);
    });
    child.stdin.end(JSON.stringify(request));
  });

export const mapWorkerOffers = (
  input: FlightSearchInput,
  offers: WorkerOffer[],
  searchUrl: string,
): FlightOffer[] =>
  offers
    .filter(
      (offer) =>
        typeof offer.price === 'number' &&
        Number.isFinite(offer.price) &&
        offer.price > 0,
    )
    .map((offer, index) => {
      const stops =
        typeof offer.stops === 'number' && offer.stops >= 0 ? offer.stops : 0;
      const airlineName = offer.airlineName || offer.airlineCode || '航班';
      const price = Number(offer.price);
      return {
        id: offer.id || `${offer.airlineCode || 'flight'}-${index}-${price}`,
        providerId: offer.airlineCode || 'google_flights',
        provider: airlineName,
        title: `${airlineName} ${offer.from || input.origin} → ${
          offer.to || input.destination
        }`,
        totalPrice: Math.round(price),
        currency: offer.currency || 'CNY',
        url: searchUrl,
        conditions: {
          direct: stops === 0,
          transferCount: stops,
          baggageKg: 0,
          refundable: false,
          departureTime: offer.departure,
          arrivalTime: offer.arrival,
          durationMinutes: offer.durationMinutes,
        },
        departTime: offer.departure || '',
        metadata: {
          live: true,
          source: 'google_flights',
          airlineCode: offer.airlineCode,
          durationMinutes: offer.durationMinutes,
          stops,
          searchUrl,
          demo: false,
        },
      };
    });

/**
 * Search real one-way fares through Google Flights.
 *
 * fast-flights is a free, keyless scraper. It returns Google Flights prices,
 * not OTA-brand prices; the caller must not describe them as Qunar/Ctrip
 * quotes. Unknown cities or missing Python dependencies reject so the brain
 * can give the user an honest failure instead of falling back to fake data.
 */
export const searchLiveFlights = async (
  input: FlightSearchInput,
): Promise<LiveFlightSearchResult> => {
  const origin = resolveCityIata(input.origin);
  const destination = resolveCityIata(input.destination);
  if (!origin || !destination) {
    throw new Error(`暂不支持这个城市：${input.origin} → ${input.destination}`);
  }
  const worker = findWorker();
  if (!worker) {
    throw new Error('flight_worker_not_found');
  }
  const python = process.env.CYRVIS_FLIGHT_PYTHON?.trim() || 'python';
  const stdout = await runWorker(
    python,
    worker,
    {
      origin,
      destination,
      date: input.departDate,
      returnDate: returnDateFor(input),
      currency: 'CNY',
      language: 'zh-CN',
      adults: input.passengers || 1,
    },
    45_000,
  );
  let response: WorkerResponse;
  try {
    response = JSON.parse(stdout) as WorkerResponse;
  } catch {
    throw new Error('flight_worker_invalid_json');
  }
  if (!response.ok) {
    throw new Error(
      `flight_worker_error:${response.error || 'unknown'}${
        response.detail ? `:${response.detail}` : ''
      }`,
    );
  }
  const searchUrl = response.searchUrl || buildGoogleFlightsUrl(input);
  const offers = mapWorkerOffers(input, response.offers || [], searchUrl);
  if (!offers.length) {
    throw new Error('flight_worker_no_priced_flights');
  }
  return { offers, source: 'google_flights', searchUrl };
};
