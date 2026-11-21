/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, beforeEach } from 'vitest';

import {
  TravelPlanner,
  isExplicitTravelGuiRequest,
  isTravelPlanningText,
} from './travel-planner';
import { buildDayPlanFromCatalog } from './travel-catalog';
import { formatTravelPlanHtml } from './travel-memo';
import { buildSeasonContext, inferTravelMonth } from './travel-season';

describe('TravelPlanner', () => {
  let planner: TravelPlanner;

  beforeEach(() => {
    planner = new TravelPlanner();
  });

  it('detects travel planning vs explicit GUI booking', () => {
    expect(isTravelPlanningText('给我看看去巴黎的机票')).toBe(true);
    expect(isTravelPlanningText('帮我预订滑雪场的票')).toBe(true);
    expect(isExplicitTravelGuiRequest('给我看看去巴黎的机票')).toBe(false);
    expect(isExplicitTravelGuiRequest('帮我预订滑雪场的票')).toBe(false);
    expect(isExplicitTravelGuiRequest('打开携程帮我下单')).toBe(true);
  });

  it('collects framework then enters preference probing', () => {
    const first = planner.updateFramework({
      userText: '给我看看去巴黎的旅行攻略',
    });
    expect(first.phase).toBe('collecting_framework');
    expect(first.framework.destination).toBe('巴黎');

    const second = planner.updateFramework({
      origin: '上海',
      startDate: '下周五',
      endDate: '下下周日',
      companions: '两个人',
      budget: '3000元以内',
    });
    expect(second.phase).toBe('probing_preferences');
    expect(second.speakHint).toMatch(/travel_probe_highlights|亮点|偏好/);
  });

  it('sets preference and returns a concrete day plan immediately', () => {
    planner.updateFramework({
      destination: '北京',
      origin: '深圳',
      startDate: '下周一',
      endDate: '下下周一',
    });

    planner.setHighlights([
      { interest: 'food', title: '簋街小龙虾' },
      { interest: 'checkin', title: '三里屯太古里' },
      { interest: 'landmark', title: '故宫博物院' },
      { interest: 'experience', title: '什刹海酒吧街' },
    ]);

    const preferred = planner.setPreference('网红打卡');
    expect(preferred.primaryInterest).toBe('checkin');
    expect(preferred.speakHint).toMatch(/三里屯|南锣|故宫|798|什刹海/);
    expect(preferred.speakHint).not.toMatch(
      /约束卡片|我帮你整理|十一月网红打卡/,
    );
    expect(preferred.speakHint).not.toMatch(/https?:\/\//);
    expect(
      preferred.aspects.some((item) => item.aspect === 'daily_itinerary'),
    ).toBe(true);

    const constrained = planner.setConstraints({
      userText: '不能走太多，不早起，排队还可以',
    });
    expect(constrained.constraints.okWithWalking).toBe(false);
    expect(constrained.constraints.okWithEarlyStart).toBe(false);
    expect(constrained.constraints.okWithQueues).toBe(true);
    expect(constrained.speakHint).toMatch(
      /三里屯|南锣|故宫|798|什刹海|餐厅|打卡/,
    );
  });

  it('does not re-ask preference when user already chose and asks for lodging', () => {
    planner.updateFramework({
      destination: '巴黎',
      origin: '上海',
      startDate: '12月20日',
      endDate: '12月27日',
      userText: '我想去巴黎玩，主打美食',
    });
    planner.syncFromConversation([
      '我想去巴黎玩，主打美食',
      '嗯，看一下住宿吧。',
    ]);
    expect(planner.getSnapshot().primaryInterest).toBe('food');

    const expanded = planner.expandAspect(
      '住宿',
      undefined,
      ['拉丁区步行可达的精品酒店', '圣日耳曼夜生活方便的公寓'],
      '嗯，看一下住宿吧。',
    );
    expect(expanded.speakHint).not.toMatch(/还没选定旅行偏好/);
    expect(expanded.speakHint).toMatch(/可执行选项/);
    expect(expanded.speakHint).toMatch(/拉丁区|圣日耳曼/);
    expect(expanded.phase).toBe('awaiting_expand_choice');
  });

  it('idle follow-up stops repeating preference probe after one ask', () => {
    planner.updateFramework({
      destination: '巴黎',
      origin: '上海',
      startDate: '12月20日',
      endDate: '12月27日',
    });
    planner.setHighlights([
      { interest: 'food', title: '法式小酒馆' },
      { interest: 'landmark', title: '卢浮宫' },
    ]);
    const first = planner.buildIdleSuggestion(['基础框架好了']);
    expect(first).toMatch(/想主打哪一类|美食|打卡/);
    const second = planner.buildIdleSuggestion(['十点吧。']);
    expect(second).not.toMatch(/还没选定旅行偏好/);
    expect(second).toMatch(/经典必去|可落地|具体/);
    const third = planner.buildIdleSuggestion(['嗯，看一下住宿吧。']);
    expect(third).toMatch(/住宿|具体推荐/);
    expect(third).not.toMatch(/旅行偏好/);
  });

  it('infers month and festival hints for seasonal search', () => {
    expect(inferTravelMonth('12月20日')).toBe(12);
    const season = buildSeasonContext('12月20日', '12月27日');
    expect(season.monthLabel).toBe('十二月');
    expect(season.festivalHints.join('')).toMatch(/圣诞|跨年/);
    expect(season.queryExtra).toMatch(/十二月|圣诞/);
  });

  it('uses catalog for Paris lodging and day plans without search', () => {
    planner.updateFramework({
      destination: '巴黎',
      origin: '上海',
      startDate: '12月20日',
      endDate: '12月22日',
      userText: '去巴黎玩，主打美食，不早起',
    });
    planner.syncFromConversation(['主打美食', '不早起', '看一下行程']);
    const itinerary = planner.expandAspect('每日行程', undefined, [], '看行程');
    expect(itinerary.speakHint).toMatch(/Day1/);
    expect(itinerary.speakHint).toMatch(
      /卢浮宫|圣心|塞纳|Comptoir|马莱|拉丁|圣日耳曼/,
    );
    expect(itinerary.speakHint).not.toMatch(/主预约点|当地简餐|备份点/);
  });

  it('ticket-first ski intent expands from catalog without preference loop', () => {
    const framed = planner.updateFramework({
      origin: '北京',
      startDate: '周六',
      userText: '帮我预订滑雪场的票',
    });
    expect(framed.framework.destination).toBe('崇礼');
    expect(framed.speakHint).toMatch(/travel_expand_aspect|tickets|订票/);
    expect(framed.speakHint).toMatch(
      /不要再跑 travel_probe_highlights|with_search=false/,
    );
    expect(framed.phase).toBe('awaiting_expand_choice');

    const tickets = planner.expandAspect(
      'tickets',
      undefined,
      [],
      '帮我预订滑雪场的票',
    );
    expect(tickets.speakHint).toMatch(/可执行选项/);
    expect(tickets.speakHint).toMatch(/雪票|太舞|云顶/);
    // Options first — no booking URL until the user picks one.
    expect(tickets.speakHint).not.toMatch(/https?:\/\//);
    expect(tickets.speakHint).toMatch(/选定后.*链接|先定一个/);
    expect(tickets.speakHint).not.toMatch(/还没选定旅行偏好/);

    const confirmed = planner.expandAspect(
      'tickets',
      '选1',
      [],
      '帮我预订滑雪场的票',
    );
    expect(confirmed.speakHint).toMatch(/https?:\/\//);
    expect(confirmed.speakHint).toMatch(/选定了|预订链接/);
    expect(confirmed.confirmedBookings.length).toBeGreaterThan(0);
  });

  it('flight wording from Beijing to Sanya goes ticket-first, not highlights', () => {
    const framed = planner.updateFramework({
      destination: '三亚',
      origin: '北京',
      startDate: '2026-11-27',
      transport: '机票',
      userText: '我从北京去三亚，11月27号出发，一个人，给我订张机票',
    });
    expect(framed.missingFramework).toEqual([]);
    expect(framed.speakHint).toMatch(/travel_expand_aspect|tickets/);
    expect(framed.speakHint).not.toMatch(/请先调用 travel_probe_highlights/);
    expect(framed.phase).toBe('awaiting_expand_choice');
  });

  it('any destination reservation gets options first, link only after pick', () => {
    planner.updateFramework({
      destination: '东京',
      origin: '上海',
      startDate: '5月1日',
      userText: '帮我预约东京的博物馆门票',
    });
    const tickets = planner.expandAspect(
      'tickets',
      undefined,
      [],
      '预约博物馆门票',
    );
    expect(tickets.speakHint).toMatch(/可执行选项/);
    expect(tickets.speakHint).toMatch(/东京/);
    expect(tickets.speakHint).not.toMatch(/https?:\/\//);
    expect(tickets.speakHint).not.toMatch(/巴黎|太舞|卢浮宫/);

    const confirmed = planner.expandAspect(
      'tickets',
      '选第一个',
      [],
      '预约博物馆门票',
    );
    expect(confirmed.speakHint).toMatch(/https?:\/\//);
    expect(confirmed.speakHint).toMatch(/trip\.com|ctrip\.com|damai\.cn/);
    expect(confirmed.speakHint).not.toMatch(/bing\.com/);
  });

  it('hotels list options first; link only after the user confirms', () => {
    planner.updateFramework({
      destination: '大阪',
      origin: '上海',
      startDate: '6月1日',
      userText: '帮我订大阪的酒店',
    });
    const stays = planner.expandAspect('住宿', undefined, [], '看一下住宿');
    expect(stays.speakHint).toMatch(/可执行选项/);
    expect(stays.speakHint).toMatch(/大阪/);
    expect(stays.speakHint).not.toMatch(/https?:\/\//);
    expect(stays.speakHint).not.toMatch(/巴黎|太舞/);

    const confirmed = planner.expandAspect('住宿', '选2', [], '看一下住宿');
    expect(confirmed.speakHint).toMatch(/https?:\/\//);
    expect(confirmed.speakHint).toMatch(/booking\.com|trip\.com|ctrip\.com/);
    expect(confirmed.speakHint).not.toMatch(/bing\.com/);
  });

  it('asks preference before dumping ticket options when none chosen', () => {
    planner.updateFramework({
      destination: '佛山',
      origin: '广州',
      startDate: '下周',
      userText: '我想去佛山旅行',
    });
    const blocked = planner.expandAspect('门票', undefined, [], '看看门票');
    expect(blocked.phase).toBe('probing_preferences');
    expect(blocked.speakHint).toMatch(/主打哪一类|美食|打卡/);
    expect(blocked.speakHint).not.toMatch(/https?:\/\//);
  });

  it('does not lock preference from assistant highlight menus', () => {
    planner.updateFramework({
      destination: '巴黎',
      origin: '上海',
      startDate: '12月20日',
    });
    planner.setHighlights([
      { interest: 'food', title: '法式小酒馆' },
      { interest: 'landmark', title: '卢浮宫' },
    ]);
    // Simulate wrongly passing assistant text — API now expects user-only turns.
    planner.syncFromConversation([
      '想主打哪一类？美食、网红打卡、经典必去，或当地体验',
    ]);
    // Without a real user preference utterance, do not treat the menu as a choice.
    // (If caller only syncs user turns, this string would not be passed at all.)
    expect(planner.getSnapshot().primaryInterest).toBeNull();
  });

  it('releases idle travel nudges after finalize', () => {
    planner.updateFramework({
      destination: '巴黎',
      origin: '上海',
      startDate: '12月20日',
      userText: '去巴黎玩，主打美食',
    });
    planner.expandAspect('住宿', undefined, [], '看住宿');
    const finalized = planner.markFinalized(
      'C:\\Users\\demo\\Desktop\\CYRVIS旅行计划-巴黎.html',
    );
    expect(finalized.speakHint).toMatch(/桌面|网页|文件名/);
    expect(planner.getSnapshot().phase).toBe('idle');
    expect(planner.buildIdleSuggestion(['打开记事本写会议纪要'])).toBeNull();
  });

  it('builds resume overview with destination and preference details', () => {
    planner.updateFramework({
      destination: '北京',
      origin: '上海',
      startDate: '五一',
      userText: '去北京玩，主打美食',
    });
    planner.setPreference('food');
    const overview = planner.buildResumeOverview();
    expect(overview).not.toBeNull();
    expect(overview?.headline).toMatch(/去北京的旅行计划/);
    expect(overview?.details.join('')).toMatch(/美食|框架|上海|五一/);
  });

  it('clears previous trip progress when destination changes', () => {
    planner.updateFramework({
      destination: '巴黎',
      origin: '上海',
      startDate: '12月20日',
      userText: '去巴黎玩，主打美食',
    });
    planner.setPreference('food');
    expect(planner.getSnapshot().aspects.length).toBeGreaterThan(0);

    planner.updateFramework({
      destination: '北京',
      origin: '深圳',
      startDate: '下周一',
      userText: '改去北京',
    });
    const next = planner.getSnapshot();
    expect(next.framework.destination).toBe('北京');
    expect(next.aspects).toHaveLength(0);
    expect(next.confirmedBookings).toHaveLength(0);
    expect(next.primaryInterest).toBeNull();
  });

  it('does not treat expand requests as option confirmations across aspects', () => {
    planner.updateFramework({
      destination: '东京',
      origin: '上海',
      startDate: '5月1日',
      userText: '帮我预约东京的博物馆门票',
    });
    const listed = planner.expandAspect(
      'tickets',
      undefined,
      [],
      '预约博物馆门票',
    );
    expect(listed.speakHint).not.toMatch(/https?:\/\//);

    // Stale userText “选1” without notes must NOT confirm hotels.
    const hotelList = planner.expandAspect('住宿', undefined, [], '选1');
    expect(hotelList.speakHint).not.toMatch(/https?:\/\//);
    expect(hotelList.speakHint).toMatch(/可执行选项/);

    const confirmed = planner.expandAspect('住宿', '选1', [], '看一下住宿');
    expect(confirmed.speakHint).toMatch(/https?:\/\//);
    expect(confirmed.speakHint).toMatch(/选定了|预订链接/);

    const again = planner.expandAspect(
      'tickets',
      undefined,
      [],
      '帮我再看看门票',
    );
    expect(again.speakHint).not.toMatch(/https?:\/\//);
  });

  it('builds distinct Foshan day slots and skips process-memo dump in HTML', () => {
    const planText = buildDayPlanFromCatalog({
      destination: '佛山',
      interest: 'food',
      preferLateStart: true,
      dayCount: 2,
    });
    expect(planText).toMatch(/Day1/);
    expect(planText).toMatch(/Day2/);
    expect(planText).not.toMatch(/主预约点|结合约束/);
    const day1 = planText.match(/Day1[^D]*/)?.[0] || '';
    const day2 = planText.match(/Day2.*/)?.[0] || '';
    expect(day1).not.toEqual(day2);
    expect(day1).toMatch(/上午去(.+?)，/);
    const morning1 = day1.match(/上午去(.+?)，/)?.[1];
    const afternoon1 = day1.match(/下午去(.+?)[。？]/)?.[1];
    expect(morning1).toBeTruthy();
    expect(afternoon1).toBeTruthy();
    expect(morning1).not.toEqual(afternoon1);

    planner.updateFramework({
      destination: '佛山',
      origin: '深圳',
      startDate: '下周一',
      userText: '深圳出发去佛山，不早起少走路',
    });
    planner.setPreference('food');
    planner.setConstraints({
      okWithWalking: false,
      okWithEarlyStart: false,
      okWithQueues: false,
    });
    const snap = planner.expandAspect('每日行程', undefined, [], '看行程');
    const html = formatTravelPlanHtml(snap, [
      {
        id: 'memo-junk',
        createdAt: Date.now(),
        kind: 'aspect',
        title: 'daily_itinerary',
        body: '结合约束（步行尽量避免），废话',
      },
    ]);
    expect(html).not.toMatch(/过程要点|结合约束|daily_itinerary/);
    expect(snap.speakHint).not.toMatch(/结合约束/);
  });
});
