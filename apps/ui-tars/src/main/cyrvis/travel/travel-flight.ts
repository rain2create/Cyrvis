/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { IntakeSlotSpec } from '../intake/types';
import { rankOffers } from '../offers/compare';
import type { Offer, RankedOffer, RankWeights } from '../offers/types';

export const TRAVEL_FLIGHT_DOMAIN = 'travel_flight';

export interface FlightSearchInput {
  origin: string;
  destination: string;
  departDate: string;
  durationDays?: number;
  passengers?: number;
}

export interface FlightOffer extends Offer {
  providerId: string;
  departTime: string;
  returnTime?: string;
}

export interface FlightComparison {
  input: FlightSearchInput;
  offers: FlightOffer[];
  ranked: RankedOffer[];
  best: RankedOffer | null;
  reasons: string[];
  returnDate: string | null;
  source?: 'demo' | 'google_flights';
  searchUrl?: string;
}

/** Live offers have no baggage/refund metadata, so only price/route count. */
export const LIVE_RANK_WEIGHTS: RankWeights = {
  price: 0.45,
  direct: 0.2,
  baggage: 0,
  refundable: 0,
  convenience: 0.05,
  duration: 0.3,
};

const CHINESE_NUMBERS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const WEEKDAYS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
};

const pad = (value: number): string => String(value).padStart(2, '0');

const formatIso = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const atLocalDate = (year: number, month: number, day: number) =>
  new Date(year, month - 1, day, 12, 0, 0, 0);

const addDays = (date: Date, days: number): Date => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const chineseNumber = (value: string): number => {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === '十') return 10;
  if (value.length === 1) return CHINESE_NUMBERS[value] || 0;
  const tens = CHINESE_NUMBERS[value[0]] || 0;
  const ones = CHINESE_NUMBERS[value[1]] || 0;
  return tens * 10 + ones;
};

const cleanCity = (value: string): string =>
  value
    .replace(/^(?:一趟|一张|一个|去|到|往|飞往|飞)/, '')
    .replace(/(?:的)?(?:单程|往返|来回)$/u, '')
    .replace(/(?:的|市|吧|呀|啊|呢|了)+$/u, '')
    .trim();

const looksLikeQuestion = (value: string): boolean =>
  /(?:怎么|什么|哪里|哪儿|多少|为什么|能不能|可不可以|吗|呢|？|\?)/.test(value);

export const parseTravelDestination = (
  text: string,
  expected = false,
): string | undefined => {
  const raw = text.trim();
  if (!raw) return undefined;
  const patterns = [
    /(?:买|订|查|比价)?(?:一张)?(?:去|到|飞往)([一-龥]{2,10}?)(?:的)?(?:单程|往返|来回)?(?:机票|航班|飞机票)/,
    /(?:去|到|飞往)([一-龥]{2,10}?)(?:的)?(?:单程|往返|来回)?(?:玩|旅游|旅行|度假|的机票)/,
    // "去三亚吧" / "到三亚的这个机票" / "到三亚的" — the suffix may be a
    // discourse particle or "这个" instead of a direct 机票 token.
    /(?:去|到|飞往)([一-龥]{2,8}?)(?:吧|了|呀|的|这个|那个|，|。|$)/,
    /(?:去|到|飞往)([一-龥]{2,10})$/,
    /([一-龥]{2,8})(?:的)?(?:机票|航班|飞机票)/,
    /(?:就|选|定|要)([一-龥]{2,8})(?:吧|了|呀)?$/,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      const city = cleanCity(match[1]);
      if (
        city &&
        !/(?:这|这里|那里|哪里|哪儿|哪个|什么|一张|机票|航班|比价|帮|我|想|要|去|到|飞|买|订|查)/.test(
          city,
        )
      ) {
        return city;
      }
    }
  }
  if (
    expected &&
    raw.length <= 10 &&
    /^[一-龥]{2,10}$/.test(raw) &&
    !looksLikeQuestion(raw) &&
    !/(?:周|天|号|月|点|明天|今天|后天|待|玩|预算|机票|航班)/.test(raw)
  ) {
    return cleanCity(raw) || undefined;
  }
  return undefined;
};

export const parseTravelOrigin = (
  text: string,
  expected = false,
): string | undefined => {
  const raw = text.trim();
  if (!raw) return undefined;
  const match =
    raw.match(/从([一-龥]{2,10}?)(?:出发|飞|走|到|去)/) ||
    raw.match(/([一-龥]{2,10}?)出发/);
  if (match?.[1]) return cleanCity(match[1]);

  // "香港到三亚的机票" / "香港去三亚" without "从". Capture the text before
  // the route separator, then strip request fillers ("帮我订一张").
  const route = raw.match(
    /([一-龥]{2,16}?)(?:到|去|飞往)([一-龥]{2,10}?)(?:的)?(?:单程|往返|来回)?(?:机票|航班|飞机票|玩|旅游|旅行|度假)?/,
  );
  if (route?.[1]) {
    const candidate = route[1].replace(
      /^(?:呃|啊|哦|嗯|诶|这样吧|好吧|那|就|帮我|给我|我要|我想|想要|订|买|查|一张|一趟|的|要)+/g,
      '',
    );
    if (
      candidate.length >= 2 &&
      candidate.length <= 10 &&
      !looksLikeQuestion(candidate) &&
      !/(?:帮|我|订|买|一张|机票|航班|单程|往返)/.test(candidate)
    ) {
      return cleanCity(candidate);
    }
  }

  if (expected) {
    const first = raw.split(/[，,、\s]/)[0] || '';
    if (
      first.length >= 2 &&
      first.length <= 10 &&
      /^[一-龥]{2,10}$/.test(first) &&
      !looksLikeQuestion(first) &&
      !/(?:周|天|号|月|点|明天|今天|后天|待|玩|预算|机票|航班)/.test(first)
    ) {
      return cleanCity(first) || undefined;
    }
  }
  return undefined;
};

export const parseTravelDate = (
  text: string,
  now = new Date(),
): string | undefined => {
  const raw = text.trim();
  if (!raw) return undefined;

  const iso = raw.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (iso) {
    return formatIso(
      atLocalDate(Number(iso[1]), Number(iso[2]), Number(iso[3])),
    );
  }

  const md = raw.match(/(\d{1,2})月(\d{1,2})[日号]?/);
  if (md) {
    let date = atLocalDate(now.getFullYear(), Number(md[1]), Number(md[2]));
    if (date.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
      date = atLocalDate(now.getFullYear() + 1, Number(md[1]), Number(md[2]));
    }
    return formatIso(date);
  }

  const slash = raw.match(/(?<!\d)(\d{1,2})[/-](\d{1,2})(?!\d)/);
  if (slash) {
    let date = atLocalDate(
      now.getFullYear(),
      Number(slash[1]),
      Number(slash[2]),
    );
    if (date.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
      date = atLocalDate(
        now.getFullYear() + 1,
        Number(slash[1]),
        Number(slash[2]),
      );
    }
    return formatIso(date);
  }

  if (/今天/.test(raw)) return formatIso(now);
  if (/明天/.test(raw)) return formatIso(addDays(now, 1));
  if (/后天/.test(raw)) return formatIso(addDays(now, 2));

  const nextMonth = raw.match(/下个?月(\d{1,2})[日号]?/);
  if (nextMonth) {
    const month = now.getMonth() + 2;
    const year = month > 12 ? now.getFullYear() + 1 : now.getFullYear();
    return formatIso(
      atLocalDate(year, month > 12 ? month - 12 : month, Number(nextMonth[1])),
    );
  }

  // "23号" / "23日": assume the current month unless that day has already
  // passed, in which case the user means next month. Asking "which month?"
  // for a day in the current month was a common, avoidable follow-up.
  const dayOnly = raw.match(/(?<!\d)(\d{1,2})[日号](?!\d)/);
  if (dayOnly) {
    const day = Number(dayOnly[1]);
    if (day >= 1 && day <= 31) {
      let date = atLocalDate(now.getFullYear(), now.getMonth() + 1, day);
      const todayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      ).getTime();
      if (date.getTime() < todayStart) {
        date = atLocalDate(now.getFullYear(), now.getMonth() + 2, day);
      }
      return formatIso(date);
    }
  }

  const week = raw.match(
    /(下周|下星期|本周|这周|这星期|周|星期)([一二三四五六日天])/,
  );
  if (week) {
    const target = WEEKDAYS[week[2]];
    if (!target) return undefined;
    const current = now.getDay() === 0 ? 7 : now.getDay();
    let delta = target - current;
    if (/下周|下星期/.test(week[1])) {
      delta += 7;
    } else if (delta < 0) {
      delta += 7;
    }
    return formatIso(addDays(now, delta));
  }

  return undefined;
};

export const parseTravelDurationDays = (text: string): number | undefined => {
  const raw = text.trim();
  if (!raw) return undefined;
  // One-way has no stay duration; compareFlights treats 0 as a single trip.
  if (/(?:单程|去程|one.?way)/i.test(raw)) return 0;
  if (/(?:半个月|两周|两个星期)/.test(raw)) return 15;
  if (/(?:一周|一个星期|7天)/.test(raw)) return 7;
  const match = raw.match(
    /(?:待|住|玩|停留)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:天|日|晚)/,
  );
  if (!match) return undefined;
  const days = chineseNumber(match[1]);
  return days >= 1 && days <= 60 ? days : undefined;
};

const hash = (value: string): number => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
};

const providerUrl = (providerId: string, input: FlightSearchInput): string => {
  const origin = encodeURIComponent(input.origin);
  const destination = encodeURIComponent(input.destination);
  switch (providerId) {
    case 'qunar':
      return `https://flight.qunar.com/site/oneway_list.htm?searchDepartureAirport=${origin}&searchArrivalAirport=${destination}&searchDepartureTime=${input.departDate}&startSearch=true`;
    case 'ctrip':
      return `https://flights.ctrip.com/online/list/oneway-${origin}-${destination}?depdate=${input.departDate}`;
    case 'fliggy':
      return `https://www.fliggy.com/flight/?_output_charset=utf-8&from=${origin}&to=${destination}&depDate=${input.departDate}`;
    case 'tongcheng':
      return `https://www.ly.com/flights/?from=${origin}&to=${destination}&date=${input.departDate}`;
    case 'trip':
      return `https://www.trip.com/flights/showfarefirst?dcity=${origin}&acity=${destination}&ddate=${input.departDate}&triptype=ow&class=y&quantity=1&locale=zh-CN&curr=CNY`;
    default:
      return 'https://www.trip.com/flights/';
  }
};

const PROVIDERS = [
  { id: 'qunar', name: '去哪儿', priceBias: -70 },
  { id: 'fliggy', name: '飞猪', priceBias: -20 },
  { id: 'ctrip', name: '携程', priceBias: 40 },
  { id: 'tongcheng', name: '同程旅行', priceBias: 15 },
  { id: 'trip', name: 'Trip.com', priceBias: 95 },
];

const buildFlightOffers = (input: FlightSearchInput): FlightOffer[] => {
  const duration = input.durationDays || 0;
  return PROVIDERS.map((provider, index) => {
    const seed = hash(
      `${input.origin}|${input.destination}|${input.departDate}|${duration}|${provider.id}`,
    );
    const base = 760 + (seed % 680);
    const roundTrip =
      duration > 0 ? Math.round(base * 1.86 + (seed % 90)) : base;
    const price = Math.max(320, roundTrip + provider.priceBias);
    const direct = seed % 100 > (index === 4 ? 12 : 28);
    const baggageKg = direct ? [20, 23, 20, 20, 23][seed % 5] : 0;
    const refundable = seed % 100 > 52;
    const departHour = 6 + (seed % 13);
    const departMinute = (seed % 4) * 15;
    const departTime = `${pad(departHour)}:${pad(departMinute)}`;
    const returnTime = duration > 0 ? `${pad(10 + (seed % 9))}:00` : undefined;
    return {
      id: `${provider.id}-${input.departDate}-${seed}`,
      providerId: provider.id,
      provider: provider.name,
      title: `${input.origin} → ${input.destination}${duration > 0 ? ` · ${duration}天往返` : ''}`,
      totalPrice: price,
      currency: 'CNY',
      url: providerUrl(provider.id, input),
      conditions: {
        direct,
        transferCount: direct ? 0 : 1,
        baggageKg,
        refundable,
        departureTime: departTime,
        arrivalTime: returnTime ? `返程 ${returnTime}` : undefined,
      },
      departTime,
      returnTime,
      metadata: { demo: true },
    };
  });
};

export const compareFlights = (input: FlightSearchInput): FlightComparison => {
  const offers = buildFlightOffers(input);
  const result = rankOffers(offers);
  const returnDate =
    input.durationDays && input.durationDays > 0
      ? formatIso(
          addDays(new Date(`${input.departDate}T12:00:00`), input.durationDays),
        )
      : null;
  return {
    input,
    offers,
    ranked: result.ranked,
    best: result.best,
    reasons: result.reasons,
    returnDate,
    source: 'demo',
  };
};

/**
 * Rank real offers returned by a live provider (currently Google Flights).
 * Do not reuse the demo formatter: live data has no baggage/refund fields and
 * must never be described as five OTA quotes.
 */
export const compareLiveFlights = (
  input: FlightSearchInput,
  offers: FlightOffer[],
  searchUrl?: string,
): FlightComparison => {
  const result = rankOffers(offers, LIVE_RANK_WEIGHTS);
  return {
    input,
    offers,
    ranked: result.ranked,
    best: result.best,
    reasons: result.reasons,
    returnDate: null,
    source: 'google_flights',
    searchUrl,
  };
};

export const formatFlightComparison = (
  comparison: FlightComparison,
): string => {
  const best = comparison.best;
  if (!best) return '没有查到可用航班，请换个日期再试。';
  const top = comparison.ranked
    .slice(0, 3)
    .map((offer) => `${offer.provider}${offer.totalPrice}元`)
    .join('、');
  const direct = best.conditions.direct ? '直飞' : '中转 1 次';
  const baggage = best.conditions.baggageKg
    ? `含${best.conditions.baggageKg}kg行李`
    : '无免费托运行李';
  const refund = best.conditions.refundable ? '可退改' : '特价不可退改';
  const savings = comparison.reasons.find((reason) =>
    reason.startsWith('比第二名'),
  );
  const tripLabel =
    comparison.input.durationDays && comparison.returnDate
      ? `往返${comparison.input.durationDays}天`
      : '单程';
  return `我比了 ${comparison.ranked.length} 个平台。前三名：${top}。最低是${best.provider} ${best.totalPrice} 元，${tripLabel}，${direct}${baggage}、${refund}。${savings ? `${savings}，` : ''}我建议选${best.provider}。`;
};

const formatDuration = (minutes?: number): string => {
  if (!minutes || minutes <= 0) return '';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours ? `${hours}小时` : ''}${rest ? `${rest}分` : ''}`;
};

export const formatLiveFlightComparison = (
  comparison: FlightComparison,
): string => {
  const best = comparison.best;
  if (!best) {
    return '实时航班暂时没有查到有价格的选项，我打开搜索页给你看。';
  }
  const sourceOf = (offer: { metadata?: Record<string, unknown> }): string =>
    String(offer.metadata?.sourceLabel || 'Google Flights');
  const sourceLabels = [
    ...new Set(comparison.offers.map((offer) => sourceOf(offer))),
  ];
  const sourceText =
    sourceLabels.length > 1
      ? `我查了 ${sourceLabels.join('、')} 的实时结果`
      : `我查了 ${sourceLabels[0] || 'Google Flights'} 的实时结果`;
  const detail = (offer: RankedOffer): string => {
    const transfer = offer.conditions.direct
      ? '直飞'
      : `中转${offer.conditions.transferCount || 1}次`;
    const time = offer.conditions.departureTime
      ? `，${offer.conditions.departureTime}出发`
      : '';
    const duration = formatDuration(offer.conditions.durationMinutes);
    return `${sourceOf(offer)} · ${offer.provider} ${offer.totalPrice} 元${time}，${transfer}${
      duration ? `，约${duration}` : ''
    }`;
  };
  const groups: Array<{
    sourceLabel: string;
    provider: string;
    price: number;
    times: string[];
  }> = [];
  const byPrice = [...comparison.ranked].sort(
    (a, b) => a.totalPrice - b.totalPrice || a.score - b.score,
  );
  for (const offer of byPrice) {
    let group = groups.find(
      (item) =>
        item.sourceLabel === sourceOf(offer) &&
        item.provider === offer.provider &&
        item.price === offer.totalPrice,
    );
    if (!group) {
      if (groups.length >= 3) continue;
      group = {
        sourceLabel: sourceOf(offer),
        provider: offer.provider,
        price: offer.totalPrice,
        times: [],
      };
      groups.push(group);
    }
    const time = offer.conditions.departureTime;
    if (time && !group.times.includes(time) && group.times.length < 2) {
      group.times.push(time);
    }
  }
  const top = groups
    .map(
      (group) =>
        `${group.sourceLabel} · ${group.provider}${group.price}元${
          group.times.length ? `（${group.times.join('、')}）` : ''
        }`,
    )
    .join('、');
  const cheapest = [...comparison.ranked].sort(
    (a, b) => a.totalPrice - b.totalPrice || a.score - b.score,
  )[0];
  const tripLabel =
    comparison.input.durationDays && comparison.input.durationDays > 0
      ? `往返${comparison.input.durationDays}天`
      : '单程';
  if (cheapest.id === best.id) {
    return `${sourceText}，找到 ${comparison.offers.length} 个有价格的${tripLabel}航班。前三名：${top}。最低价和综合最优都是${detail(best)}。我建议选它。价格会实时变化，具体以页面为准。`;
  }
  return `${sourceText}，找到 ${comparison.offers.length} 个有价格的${tripLabel}航班。前三名：${top}。最便宜的是${detail(cheapest)}；综合价格和时间，我建议选${detail(best)}。价格会实时变化，具体以页面为准。`;
};

export const TRAVEL_FLIGHT_SLOTS: IntakeSlotSpec[] = [
  {
    key: 'destination',
    label: '目的地',
    question: '去哪个城市？',
    kind: 'text',
    priority: 1,
    parse: (text, context) => parseTravelDestination(text, context.expected),
  },
  {
    key: 'origin',
    label: '出发地',
    question: '从哪个城市出发？',
    kind: 'text',
    priority: 2,
    parse: (text, context) => parseTravelOrigin(text, context.expected),
  },
  {
    key: 'departDate',
    label: '出发日期',
    question: '大概哪天出发？',
    kind: 'date',
    priority: 3,
    parse: (text) => parseTravelDate(text),
  },
  {
    key: 'durationDays',
    label: '待几天',
    question: '打算待几天？',
    kind: 'duration',
    priority: 4,
    // Optional: do not force the user to say "单程". If they volunteer
    // "待五天"/"往返", the parser still fills it; otherwise default to a
    // one-way comparison so all three sources can be queried.
    required: false,
    ask: false,
    defaultValue: '0',
    parse: (text, context) => {
      // ASR commonly hears "单程" as "单纯" at the end of a sentence.
      if (context.expected && /单纯/.test(text)) return 0;
      return parseTravelDurationDays(text);
    },
  },
];

export const isTravelFlightIntent = (text: string): boolean =>
  /(?:机票|航班|飞机票|飞过去)/.test(text) &&
  /(?:买|订|查|比价|比较|对比|价格|多少钱|要一张|看看)/.test(text);
