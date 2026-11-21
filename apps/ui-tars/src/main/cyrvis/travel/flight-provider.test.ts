/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import {
  buildGoogleFlightsUrl,
  mapWorkerOffers,
  resolveCityIata,
} from './flight-provider';

describe('live flight provider', () => {
  it('maps spoken Chinese cities to Google Flights metro codes', () => {
    expect(resolveCityIata('北京')).toBe('BJS');
    expect(resolveCityIata('三亚市')).toBe('SYX');
    expect(resolveCityIata('上海')).toBe('SHA');
    expect(resolveCityIata('鼓浪屿')).toBe('XMN');
    expect(resolveCityIata('厦门鼓浪屿')).toBe('XMN');
    expect(resolveCityIata('NCE')).toBe('NCE');
    expect(resolveCityIata('不存在的城市')).toBeUndefined();
  });

  it('builds a Google Flights search URL', () => {
    expect(
      buildGoogleFlightsUrl({
        origin: '北京',
        destination: '三亚',
        departDate: '2026-11-27',
      }),
    ).toContain('google.com/travel/flights');
  });

  it('maps worker offers without inventing baggage or refund data', () => {
    const offers = mapWorkerOffers(
      {
        origin: '北京',
        destination: '三亚',
        departDate: '2026-11-27',
      },
      [
        {
          id: 'ZH-9171-21:15-2340',
          price: 2340,
          currency: 'CNY',
          airlineCode: 'ZH',
          airlineName: '深航',
          from: 'BJS',
          to: 'SYX',
          departure: '21:15',
          arrival: '21:50',
          durationMinutes: 1475,
          stops: 1,
        },
        {
          id: 'bad-price',
          price: 0,
          airlineName: '坏数据',
        },
      ],
      'https://www.google.com/travel/flights?q=BJS-SYX',
    );

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      provider: '深航',
      providerId: 'ZH',
      totalPrice: 2340,
      currency: 'CNY',
      conditions: {
        direct: false,
        transferCount: 1,
        baggageKg: 0,
        refundable: false,
        departureTime: '21:15',
      },
    });
    expect(offers[0].metadata).toMatchObject({
      live: true,
      source: 'google_flights',
      stops: 1,
    });
  });
});
