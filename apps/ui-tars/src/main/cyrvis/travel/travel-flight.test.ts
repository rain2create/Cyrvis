/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import {
  compareFlights,
  compareLiveFlights,
  formatFlightComparison,
  formatLiveFlightComparison,
  isTravelFlightIntent,
  parseTravelDate,
  parseTravelDestination,
  parseTravelDurationDays,
  parseTravelOrigin,
} from './travel-flight';

describe('travel flight slots', () => {
  it('parses destination, origin, date and duration from natural language', () => {
    expect(parseTravelDestination('我要买一张去三亚的机票')).toBe('三亚');
    expect(parseTravelDestination('帮我订张机票去三亚')).toBe('三亚');
    expect(parseTravelDestination('三亚机票怎么买')).toBe('三亚');
    expect(parseTravelDestination('我要买一张从北京去三亚的单程机票')).toBe(
      '三亚',
    );
    expect(parseTravelDestination('我要买一张从北京去三亚的往返机票')).toBe(
      '三亚',
    );
    expect(
      parseTravelDestination(
        '行，那我就想去三亚吧，从香港到三亚的这个机票信息告诉我。',
      ),
    ).toBe('三亚');
    expect(parseTravelDestination('就厦门吧', true)).toBe('厦门');
    expect(parseTravelOrigin('从北京出发')).toBe('北京');
    expect(parseTravelOrigin('北京', true)).toBe('北京');
    expect(
      parseTravelOrigin(
        '呃这样吧，呃帮我订一张香港到三亚的机票，11月27号单程的。',
      ),
    ).toBe('香港');
    expect(
      parseTravelDestination(
        '呃这样吧，呃帮我订一张香港到三亚的机票，11月27号单程的。',
      ),
    ).toBe('三亚');
    expect(parseTravelOrigin('帮我订一张香港到三亚的机票')).toBe('香港');

    const now = new Date('2026-11-20T10:00:00');
    expect(parseTravelDate('下周五', now)).toBe('2026-11-27');
    expect(parseTravelDate('11月27日', now)).toBe('2026-11-27');
    expect(parseTravelDate('明天', now)).toBe('2026-11-21');
    // A bare day means the current month unless it has already passed.
    expect(parseTravelDate('23号', now)).toBe('2026-11-23');
    expect(parseTravelDate('15号', now)).toBe('2026-12-15');
    expect(parseTravelDurationDays('待五天')).toBe(5);
    expect(parseTravelDurationDays('3天两晚')).toBe(3);
    expect(parseTravelDurationDays('一周')).toBe(7);
    expect(parseTravelDurationDays('单程')).toBe(0);
  });

  it('distinguishes a concrete flight purchase from a generic search', () => {
    expect(isTravelFlightIntent('我要买一张去三亚的机票')).toBe(true);
    expect(isTravelFlightIntent('三亚机票多少钱')).toBe(true);
    expect(isTravelFlightIntent('我要去巴黎的机票')).toBe(false);
  });
});

describe('flight comparison', () => {
  const input = {
    origin: '北京',
    destination: '三亚',
    departDate: '2026-11-27',
    durationDays: 5,
  };

  it('returns five deterministic offers with a best choice', () => {
    const first = compareFlights(input);
    const second = compareFlights(input);

    expect(first.offers).toHaveLength(5);
    expect(first.best).not.toBeNull();
    expect(second.best?.provider).toBe(first.best?.provider);
    expect(second.best?.totalPrice).toBe(first.best?.totalPrice);
    expect(first.returnDate).toBe('2026-12-02');
    expect(first.best?.url).toMatch(/^https?:\/\//);
    expect(first.ranked[0].score).toBeGreaterThanOrEqual(first.ranked[1].score);
  });

  it('speaks the platform count, top three and the recommendation', () => {
    const comparison = compareFlights(input);
    const speech = formatFlightComparison(comparison);

    expect(speech).toContain('我比了 5 个平台');
    expect(speech).toContain(comparison.best!.provider);
    expect(speech).toContain('我建议选');
    expect(speech).toContain('往返5天');
  });

  it('treats duration 0 as a one-way trip', () => {
    const comparison = compareFlights({ ...input, durationDays: 0 });
    const speech = formatFlightComparison(comparison);

    expect(comparison.returnDate).toBeNull();
    expect(speech).toContain('单程');
    expect(speech).not.toContain('往返');
  });

  it('speaks live Google Flights results without claiming five OTAs', () => {
    const searchUrl = 'https://www.google.com/travel/flights?q=BJS-SYX';
    const comparison = compareLiveFlights(
      input,
      [
        {
          id: 'ZH-2340',
          providerId: 'ZH',
          provider: '深航',
          title: '深航 BJS → SYX',
          totalPrice: 2340,
          currency: 'CNY',
          url: searchUrl,
          conditions: {
            direct: false,
            transferCount: 1,
            baggageKg: 0,
            refundable: false,
            departureTime: '21:15',
          },
          departTime: '21:15',
        },
        {
          id: 'CZ-4230',
          providerId: 'CZ',
          provider: '南航',
          title: '南航 BJS → SYX',
          totalPrice: 4230,
          currency: 'CNY',
          url: searchUrl,
          conditions: {
            direct: true,
            transferCount: 0,
            baggageKg: 0,
            refundable: false,
            departureTime: '07:25',
          },
          departTime: '07:25',
        },
      ],
      searchUrl,
    );
    const speech = formatLiveFlightComparison(comparison);

    expect(comparison.source).toBe('google_flights');
    expect(speech).toContain('Google Flights 的实时结果');
    expect(speech).toContain('深航');
    expect(speech).toContain('价格会实时变化');
    expect(speech).not.toContain('5 个平台');
  });
});
