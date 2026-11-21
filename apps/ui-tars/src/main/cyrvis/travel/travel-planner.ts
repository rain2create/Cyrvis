/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  buildDayPlanFromCatalog,
  formatCatalogOption,
  isSkiOriented,
  matchSelectedCatalogPlace,
  resolveBookableOptions,
  type CatalogPlace,
} from './travel-catalog';

export type TravelPhase =
  | 'idle'
  | 'collecting_framework'
  | 'probing_preferences'
  | 'collecting_constraints'
  | 'skeleton_ready'
  | 'awaiting_expand_choice'
  | 'expanding'
  | 'done';

export interface TravelConstraints {
  /** null/undefined = not answered yet */
  okWithWalking?: boolean | null;
  okWithEarlyStart?: boolean | null;
  okWithQueues?: boolean | null;
  notes?: string;
}

export type TravelAspect =
  | 'accommodation'
  | 'daily_itinerary'
  | 'tickets'
  | 'budget_booking'
  | 'emergency';

/** Coarse interest buckets used after the basic framework is set. */
export type TravelInterest = 'food' | 'checkin' | 'landmark' | 'experience';

export interface TravelFramework {
  destination?: string;
  origin?: string;
  startDate?: string;
  endDate?: string;
  companions?: string;
  budget?: string;
  purpose?: string;
  transport?: string;
}

export interface TravelHighlight {
  interest: TravelInterest;
  title: string;
  detail?: string;
}

export interface TravelAspectDraft {
  aspect: TravelAspect;
  summary: string;
  updatedAt: number;
}

export interface TravelPlanSnapshot {
  phase: TravelPhase;
  framework: TravelFramework;
  missingFramework: Array<keyof TravelFramework>;
  nextQuestion: string | null;
  skeleton: string | null;
  expandMenu: string | null;
  highlights: TravelHighlight[];
  primaryInterest: TravelInterest | null;
  interestLabel: string | null;
  constraints: TravelConstraints;
  constraintCardPrompt: string | null;
  completedAspects: TravelAspect[];
  remainingAspects: TravelAspect[];
  preferredNextAspect: TravelAspect | null;
  currentAspect: TravelAspect | null;
  aspects: TravelAspectDraft[];
  lastSearchQuery: string | null;
  softBridge: string;
  speakHint: string;
  /** Booking links only for options the user has explicitly confirmed. */
  confirmedBookings: Array<{ name: string; url: string; blurb: string }>;
}

export interface TravelUpdateInput {
  destination?: string;
  origin?: string;
  startDate?: string;
  endDate?: string;
  companions?: string;
  budget?: string;
  purpose?: string;
  transport?: string;
  userText?: string;
}

const ASPECT_ORDER: TravelAspect[] = [
  'accommodation',
  'daily_itinerary',
  'tickets',
  'budget_booking',
  'emergency',
];

const ASPECT_LABEL: Record<TravelAspect, string> = {
  accommodation: '住宿安排',
  daily_itinerary: '每日行程',
  tickets: '门票与预约',
  budget_booking: '花费与订票',
  emergency: '应急与备用',
};

export const INTEREST_LABEL: Record<TravelInterest, string> = {
  food: '美食',
  checkin: '网红打卡',
  landmark: '经典必去',
  experience: '当地特色体验',
};

export const INTEREST_ORDER: TravelInterest[] = [
  'food',
  'checkin',
  'landmark',
  'experience',
];

const FRAMEWORK_FIELDS: Array<keyof TravelFramework> = [
  'destination',
  'origin',
  'startDate',
  'endDate',
  'companions',
  'budget',
  'purpose',
  'transport',
];

/** Must-have before preference probing / skeleton. */
const REQUIRED_FRAMEWORK: Array<keyof TravelFramework> = [
  'destination',
  'origin',
  'startDate',
];

const clean = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text || undefined;
};

export const isTravelPlanningText = (text: string): boolean => {
  const raw = text.trim();
  if (!raw) return false;
  return /(旅行|旅游|出行|攻略|行程|机票|酒店|签证|度假|滑雪|雪场|雪票|缆车|索道|门票|预约|买票|订票|预订|去.+玩|飞.+去|帮我(安排|规划|预订|订).*(旅|行|票|酒店|滑雪))/.test(
    raw,
  );
};

/** Any reservation / ticketing intent that should skip preference probing. */
export const isTicketFirstIntent = (text: string): boolean =>
  /(机票|航班|比价|门票|买票|订票|预订|预约|订座|订位|雪票|缆车票|索道|展览票|演出票|乐园票|门票预约|帮我订|tickets?|reservations?)/i.test(
    text.trim(),
  );

/** True when the user clearly wants desktop GUI booking, not planning chat. */
export const isExplicitTravelGuiRequest = (text: string): boolean =>
  /(打开|启动|进入).*(携程|飞猪|去哪儿|同程|booking|expedia|浏览器|chrome|edge)/i.test(
    text,
  ) || /(帮我(点|下单|付款|支付)|在电脑上(打开|操作))/.test(text);

export const aspectLabel = (aspect: TravelAspect): string =>
  ASPECT_LABEL[aspect];

export const interestLabel = (interest: TravelInterest): string =>
  INTEREST_LABEL[interest];

const SOFT_BRIDGES: Record<'hold' | 'next' | 'done' | 'memo', string[]> = {
  hold: [
    '好，这一块我们先记到这里；你要是又想起来，我们再加上。',
    '先这样定一版，后面想到细节随时补就行。',
    '这部分先落到计划里；有新想法我们再改，不着急一次说完。',
  ],
  next: [
    '那我们顺着往下看一点可执行的推荐。',
    '接下来我直接给你几个能落地的选项。',
    '我们往下走，先给你具体建议，你再挑。',
  ],
  done: [
    '好，那我们先考虑到这里。之后你要是又想起来，我们再往计划上加。',
    '先停在这版也完全可以，后面想到什么再说。',
    '今天先这样收一收；你随时还能让我继续补。',
  ],
  memo: [
    '我已经把说定的内容整理进备忘了，敲定后也会在桌面生成摘要。',
    '这些结论会记进旅行备忘，方便你直接看结果。',
  ],
};

let softBridgeCursor = 0;

/** Soft handoff lines so section boundaries do not feel abrupt. */
export const softBridgePhrase = (
  kind: 'hold' | 'next' | 'done' | 'memo' = 'hold',
): string => {
  const pool = SOFT_BRIDGES[kind];
  const phrase = pool[softBridgeCursor % pool.length];
  softBridgeCursor += 1;
  return phrase;
};

export const CONSTRAINT_CARD_PROMPT =
  '先快速过一下约束卡片就行：走很多路可以吗？愿不愿意早起赶景点？热门项目排队能接受吗？你可以直接说“都能接受”或指出想避开哪一项。';

export const parseTravelInterest = (raw: string): TravelInterest | null => {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (/(美食|吃饭|餐厅|料理|米其林|甜品|吃的|food|cuisine)/.test(text)) {
    return 'food';
  }
  if (/(网红|打卡|拍照|出片|ins|instagram|check.?in)/.test(text)) {
    return 'checkin';
  }
  if (/(经典|必去|名胜|博物馆|地标|landmark|景点)/.test(text)) {
    return 'landmark';
  }
  if (
    /(体验|特色|市集|workshop|演出|夜游|滑雪|雪场|experience|local)/.test(text)
  ) {
    return 'experience';
  }
  return null;
};

/** User chose a preference — ignore multi-option probe menus. */
export const parseUserTravelInterest = (raw: string): TravelInterest | null => {
  const text = raw.trim();
  if (!text) return null;
  // Assistant-style menus listing several categories are not a choice.
  if (
    /(想主打哪一类|哪一类|美食[、,，].*(打卡|经典|体验)|打卡[、,，].*(经典|体验|美食))/.test(
      text,
    )
  ) {
    return null;
  }
  // Prefer explicit choice phrasing when present.
  if (/(更?喜欢|主打|选定?|要|选).{0,8}(美食|吃饭|餐厅)/.test(text)) {
    return 'food';
  }
  if (/(更?喜欢|主打|选定?|要|选).{0,8}(网红|打卡|拍照|出片)/.test(text)) {
    return 'checkin';
  }
  if (/(更?喜欢|主打|选定?|要|选).{0,8}(经典|必去|地标|博物馆)/.test(text)) {
    return 'landmark';
  }
  if (/(更?喜欢|主打|选定?|要|选).{0,8}(体验|特色|滑雪|雪场)/.test(text)) {
    return 'experience';
  }
  return parseTravelInterest(text);
};

/** Preferred expansion order once an interest is known. */
export const preferredAspectOrder = (
  interest: TravelInterest | null,
): TravelAspect[] => {
  if (interest === 'food') {
    return [
      'daily_itinerary',
      'accommodation',
      'tickets',
      'budget_booking',
      'emergency',
    ];
  }
  if (interest === 'checkin' || interest === 'landmark') {
    return [
      'daily_itinerary',
      'tickets',
      'accommodation',
      'budget_booking',
      'emergency',
    ];
  }
  if (interest === 'experience') {
    return [
      'daily_itinerary',
      'tickets',
      'budget_booking',
      'accommodation',
      'emergency',
    ];
  }
  return [...ASPECT_ORDER];
};

export class TravelPlanner {
  private phase: TravelPhase = 'idle';
  private framework: TravelFramework = {};
  private aspects: TravelAspectDraft[] = [];
  private highlights: TravelHighlight[] = [];
  private primaryInterest: TravelInterest | null = null;
  private constraints: TravelConstraints = {};
  private currentAspect: TravelAspect | null = null;
  private lastSearchQuery: string | null = null;
  private lastIdleSuggestion = '';
  private preferenceAsked = false;
  private confirmedBookings: Array<{
    name: string;
    url: string;
    blurb: string;
  }> = [];

  reset(): void {
    this.phase = 'idle';
    this.framework = {};
    this.aspects = [];
    this.highlights = [];
    this.primaryInterest = null;
    this.constraints = {};
    this.currentAspect = null;
    this.lastSearchQuery = null;
    this.lastIdleSuggestion = '';
    this.preferenceAsked = false;
    this.confirmedBookings = [];
  }

  /** Clear plan progress but keep the current framework shell. */
  clearPlanProgress(): void {
    this.aspects = [];
    this.highlights = [];
    this.primaryInterest = null;
    this.constraints = {};
    this.currentAspect = null;
    this.lastSearchQuery = null;
    this.lastIdleSuggestion = '';
    this.preferenceAsked = false;
    this.confirmedBookings = [];
    if (this.phase !== 'idle') this.phase = 'collecting_framework';
  }

  getSnapshot(speakHint?: string): TravelPlanSnapshot {
    const missingFramework = this.getMissingFramework();
    const order = preferredAspectOrder(this.primaryInterest);
    const completedAspects = this.aspects.map((item) => item.aspect);
    const remainingAspects = order.filter(
      (aspect) => !completedAspects.includes(aspect),
    );
    return {
      phase: this.phase,
      framework: { ...this.framework },
      missingFramework,
      nextQuestion: this.buildNextQuestion(missingFramework),
      skeleton:
        this.phase === 'idle' || this.phase === 'collecting_framework'
          ? null
          : this.buildSkeleton(),
      expandMenu:
        this.phase === 'awaiting_expand_choice' ||
        this.phase === 'skeleton_ready'
          ? this.buildExpandMenu(remainingAspects)
          : null,
      highlights: this.highlights.map((item) => ({ ...item })),
      primaryInterest: this.primaryInterest,
      interestLabel: this.primaryInterest
        ? interestLabel(this.primaryInterest)
        : null,
      constraints: { ...this.constraints },
      constraintCardPrompt:
        this.phase === 'collecting_constraints' ? CONSTRAINT_CARD_PROMPT : null,
      completedAspects,
      remainingAspects,
      preferredNextAspect: remainingAspects[0] || null,
      currentAspect: this.currentAspect,
      aspects: this.aspects.map((item) => ({ ...item })),
      lastSearchQuery: this.lastSearchQuery,
      softBridge: softBridgePhrase(
        this.phase === 'done'
          ? 'done'
          : remainingAspects.length
            ? 'hold'
            : 'done',
      ),
      speakHint:
        speakHint || this.defaultSpeakHint(missingFramework, remainingAspects),
      confirmedBookings: this.confirmedBookings.map((item) => ({ ...item })),
    };
  }

  updateFramework(input: TravelUpdateInput): TravelPlanSnapshot {
    if (this.phase === 'idle' || this.phase === 'done') {
      this.phase = 'collecting_framework';
    }

    const previousDest = this.framework.destination;
    for (const key of FRAMEWORK_FIELDS) {
      const value = clean(input[key]);
      if (value) this.framework[key] = value;
    }

    this.inferFromUserText(clean(input.userText));

    const ticketFirstIntent =
      /机票|航班|比价/.test(clean(this.framework.transport) || '') ||
      isTicketFirstIntent(clean(input.userText) || '');

    const nextDest = this.framework.destination;
    const userBlob = clean(input.userText) || '';
    const wantsFreshTrip =
      /(重新规划|换个目的地|换目的地|换成|换去|换到|改成|改为|另外去|改去|不[去到]了|新的旅行)/.test(
        userBlob,
      );
    if (
      wantsFreshTrip ||
      (previousDest &&
        nextDest &&
        previousDest.replace(/\s+/g, '').toLowerCase() !==
          nextDest.replace(/\s+/g, '').toLowerCase())
    ) {
      // Keep the newly inferred framework; drop old aspects/bookings/preference.
      const kept = { ...this.framework };
      this.clearPlanProgress();
      this.framework = kept;
      this.phase = 'collecting_framework';
    }

    // If user already states a strong interest while filling slots, remember it.
    const earlyInterest = parseTravelInterest(clean(input.userText) || '');
    if (earlyInterest && !this.primaryInterest) {
      this.primaryInterest = earlyInterest;
      if (!this.framework.purpose) {
        this.framework.purpose = interestLabel(earlyInterest);
      }
    }
    if (!this.primaryInterest && ticketFirstIntent) {
      const raw = clean(input.userText) || '';
      this.primaryInterest = isSkiOriented(raw) ? 'experience' : 'landmark';
      this.framework.purpose ||= isSkiOriented(raw)
        ? '滑雪'
        : /(酒店|住宿|民宿|住哪)/.test(raw)
          ? '住宿预订'
          : '预约订票';
    }

    const missing = this.getMissingFramework();
    if (missing.length === 0) {
      if (
        this.phase === 'collecting_framework' ||
        this.phase === 'skeleton_ready'
      ) {
        if (ticketFirstIntent) {
          this.ensureReadyToExpand(clean(input.userText));
          return this.getSnapshot(
            `${this.buildSkeleton()}。你这次更像是先订票。请直接调用 travel_expand_aspect（aspect=tickets，with_search=false），用候选库给出 2～3 个可执行票务选项，不要开浏览器找链接，也不要再跑 travel_probe_highlights。`,
          );
        }
        this.phase = 'probing_preferences';
      }
      return this.getSnapshot(
        `${this.buildSkeleton()}。目的地和时间有了。下一步按这个行程，每个大类只提一个亮点（美食、网红打卡、经典必去、当地体验）供你挑；请先调用 travel_probe_highlights 检索后再问用户更偏向哪一类。`,
      );
    }

    this.phase = 'collecting_framework';
    return this.getSnapshot();
  }

  /**
   * After framework is ready: store one highlight per major category and ask
   * which direction the user cares about most.
   */
  setHighlights(highlights: TravelHighlight[]): TravelPlanSnapshot {
    const missing = this.getMissingFramework();
    if (missing.length > 0) {
      this.phase = 'collecting_framework';
      return this.getSnapshot(
        `还缺${this.describeMissing(missing)}，先把时间和地点对一下，再聊偏好。`,
      );
    }

    const byInterest = new Map<TravelInterest, TravelHighlight>();
    for (const item of highlights) {
      if (!item?.interest || !clean(item.title)) continue;
      if (!byInterest.has(item.interest)) {
        byInterest.set(item.interest, {
          interest: item.interest,
          title: clean(item.title)!,
          detail: clean(item.detail),
        });
      }
    }
    // Keep stable category order; one item each.
    this.highlights = INTEREST_ORDER.map(
      (interest) => byInterest.get(interest) || null,
    ).filter((item): item is TravelHighlight => Boolean(item));

    this.phase = 'probing_preferences';
    // If preference was already chosen earlier in the chat, do not re-ask.
    if (this.primaryInterest) {
      this.ensureReadyToExpand();
      return this.expandAspect(
        preferredAspectOrder(this.primaryInterest)[0] || 'daily_itinerary',
        undefined,
        [],
        interestLabel(this.primaryInterest),
      );
    }

    const lines =
      this.highlights.length > 0
        ? this.highlights
            .map(
              (item) =>
                `${interestLabel(item.interest)}可以走「${item.title}」这条`,
            )
            .join('；')
        : '美食、打卡、经典景点、当地体验四类都行';

    this.preferenceAsked = true;
    return this.getSnapshot(
      `这边有几条具体线：${lines}。你更想主打哪一类？选定后我直接给你按天可执行的安排（点位名会说清楚）。`,
    );
  }

  setPreference(interestRaw: string, notes?: string): TravelPlanSnapshot {
    const missing = this.getMissingFramework();
    if (missing.length > 0) {
      this.phase = 'collecting_framework';
      return this.getSnapshot(
        `还有几项没对上（缺${this.describeMissing(missing)}），先补这些。`,
      );
    }

    const interest =
      parseTravelInterest(interestRaw) ||
      (INTEREST_ORDER.includes(interestRaw as TravelInterest)
        ? (interestRaw as TravelInterest)
        : null);
    if (!interest) {
      this.phase = 'probing_preferences';
      return this.getSnapshot(
        '没听清偏好。你可以选：美食、网红打卡、经典必去，或当地特色体验。',
      );
    }

    this.primaryInterest = interest;
    this.framework.purpose = interestLabel(interest);
    const noteText = clean(notes);
    // Soft defaults — don't make the constraint card the main reply.
    this.constraints = {
      okWithWalking: this.constraints.okWithWalking ?? true,
      okWithEarlyStart: this.constraints.okWithEarlyStart ?? false,
      okWithQueues: this.constraints.okWithQueues ?? true,
      notes:
        this.constraints.notes ||
        noteText ||
        '节奏备注：偏轻松、不赶早（可随时改）',
    };
    // Jump straight to a concrete day plan — scheme first, meta in notes.
    this.ensureReadyToExpand(noteText || interestLabel(interest));
    return this.expandAspect(
      'daily_itinerary',
      noteText,
      [],
      noteText || interestLabel(interest),
    );
  }

  setConstraints(input: {
    okWithWalking?: boolean | null;
    okWithEarlyStart?: boolean | null;
    okWithQueues?: boolean | null;
    notes?: string;
    userText?: string;
  }): TravelPlanSnapshot {
    if (!this.primaryInterest) {
      this.phase = 'probing_preferences';
      return this.getSnapshot(
        '还没选定偏好。先挑美食/打卡/经典/体验一类，再过约束卡片。',
      );
    }

    const inferred = this.inferConstraintsFromText(clean(input.userText));
    this.constraints = {
      okWithWalking:
        input.okWithWalking ??
        inferred.okWithWalking ??
        this.constraints.okWithWalking,
      okWithEarlyStart:
        input.okWithEarlyStart ??
        inferred.okWithEarlyStart ??
        this.constraints.okWithEarlyStart,
      okWithQueues:
        input.okWithQueues ??
        inferred.okWithQueues ??
        this.constraints.okWithQueues,
      notes: clean(input.notes) || inferred.notes || this.constraints.notes,
    };

    // If user says "都能接受", fill remaining unknowns as true.
    if (
      /(都能接受|都可以|没问题|都行|随意)/.test(clean(input.userText) || '')
    ) {
      this.constraints.okWithWalking ??= true;
      this.constraints.okWithEarlyStart ??= true;
      this.constraints.okWithQueues ??= true;
    }

    this.ensureReadyToExpand(clean(input.userText));
    // Constraints are notes — immediately return an executable plan as the body.
    return this.expandAspect(
      preferredAspectOrder(this.primaryInterest)[0] || 'daily_itinerary',
      clean(input.notes) || clean(input.userText),
      [],
      clean(input.userText),
    );
  }

  confirmSkeleton(): TravelPlanSnapshot {
    const missing = this.getMissingFramework();
    if (missing.length > 0) {
      this.phase = 'collecting_framework';
      return this.getSnapshot(
        `还缺${this.describeMissing(missing)}，先补这些再展开。${this.buildNextQuestion(missing)}`,
      );
    }
    if (!this.primaryInterest) {
      this.phase = 'probing_preferences';
      return this.getSnapshot(
        `${this.buildSkeleton()}。先试探偏好：请调用 travel_probe_highlights，用大类亮点问用户更感兴趣哪一类。`,
      );
    }
    if (!this.hasConstraintAnswers()) {
      this.phase = 'collecting_constraints';
      return this.getSnapshot(
        `${this.buildSkeleton()}。偏好是${interestLabel(this.primaryInterest)}。${CONSTRAINT_CARD_PROMPT}`,
      );
    }
    this.phase = 'awaiting_expand_choice';
    const next = preferredAspectOrder(this.primaryInterest)[0];
    return this.getSnapshot(
      `${this.buildSkeleton()}。当前偏好是${interestLabel(this.primaryInterest)}。要不要先完善${aspectLabel(next)}？${softBridgePhrase('next')}`,
    );
  }

  /**
   * Short resume blurb for launch/activate greetings — headline + up to 2
   * concrete detail sentences. Returns null when there is nothing to resume.
   */
  buildResumeOverview(): { headline: string; details: string[] } | null {
    const destination = this.framework.destination;
    if (
      !destination &&
      this.phase === 'idle' &&
      !this.aspects.length &&
      !this.primaryInterest
    ) {
      return null;
    }
    const dest = destination || '目的地';
    const headline = `上次我们一起在做去${dest}的旅行计划`;
    const details: string[] = [];
    const skeleton = this.buildSkeleton();
    if (skeleton) {
      details.push(
        `当时定的框架是${skeleton.replace(/^骨架攻略：|^行程要点：/, '')}`,
      );
    } else if (destination) {
      const bits = [
        this.framework.origin ? `从${this.framework.origin}出发` : null,
        this.framework.startDate || this.framework.endDate
          ? [this.framework.startDate, this.framework.endDate]
              .filter(Boolean)
              .join('到')
          : null,
        this.framework.companions || null,
      ].filter(Boolean);
      if (bits.length) {
        details.push(`已经摸到的信息有：${bits.join('，')}`);
      }
    }
    if (this.primaryInterest) {
      const done = this.aspects
        .map((item) => aspectLabel(item.aspect))
        .slice(0, 2);
      const remaining = preferredAspectOrder(this.primaryInterest)
        .filter(
          (aspect) => !this.aspects.some((item) => item.aspect === aspect),
        )
        .slice(0, 2)
        .map((aspect) => aspectLabel(aspect));
      if (done.length) {
        details.push(
          `偏好按「${interestLabel(this.primaryInterest)}」走，已有${done.join('、')}${
            remaining.length ? `，还差${remaining.join('、')}` : ''
          }`,
        );
      } else {
        details.push(
          `偏好按「${interestLabel(this.primaryInterest)}」记着，住宿和行程还可以继续补`,
        );
      }
    } else if (
      this.phase === 'probing_preferences' ||
      this.phase === 'collecting_constraints' ||
      this.phase === 'skeleton_ready'
    ) {
      details.push('时间和地点有了，偏好和可执行推荐还没完全展开');
    } else if (this.phase === 'collecting_framework') {
      details.push('目的地和时间还在收齐，具体方案还没铺开');
    }
    return { headline, details: details.slice(0, 2) };
  }

  /**
   * Sync preference/constraints from recent USER chat only — never from the
   * assistant's highlight menus (e.g. “美食、网红打卡…”), which would falsely
   * lock preference before the user chooses.
   */
  syncFromConversation(recentUserTurns: string[] = []): void {
    const blob = recentUserTurns.join(' ');
    if (!this.primaryInterest) {
      const found =
        parseUserTravelInterest(blob) ||
        parseUserTravelInterest(this.framework.purpose || '');
      if (found) {
        this.primaryInterest = found;
        this.framework.purpose ||= interestLabel(found);
      }
    }
    const inferred = this.inferConstraintsFromText(blob);
    this.constraints = {
      ...this.constraints,
      ...Object.fromEntries(
        Object.entries(inferred).filter(([, value]) => value != null),
      ),
    };
    if (/(不赶早|轻松|晚一点|十点|10点|十点)/.test(blob)) {
      this.constraints.okWithEarlyStart ??= false;
    }
  }

  /** Soft-fill constraints; never silently invent a preference. */
  ensureReadyToExpand(userText?: string): void {
    this.syncFromConversation([userText || '', this.framework.purpose || '']);
    if (!this.primaryInterest) {
      const found =
        parseUserTravelInterest(userText || '') ||
        parseTravelInterest(userText || '');
      if (found) {
        this.primaryInterest = found;
        this.framework.purpose ||= interestLabel(found);
      }
    }
    if (!this.hasConstraintAnswers()) {
      this.constraints = {
        okWithWalking: this.constraints.okWithWalking ?? true,
        okWithEarlyStart: this.constraints.okWithEarlyStart ?? false,
        okWithQueues: this.constraints.okWithQueues ?? true,
        notes: this.constraints.notes || '节奏备注：偏轻松、不赶早（可随时改）',
      };
    }
    if (
      this.phase === 'collecting_framework' ||
      this.phase === 'probing_preferences' ||
      this.phase === 'collecting_constraints' ||
      this.phase === 'skeleton_ready'
    ) {
      this.phase = 'awaiting_expand_choice';
    }
  }

  expandAspect(
    aspectRaw: string,
    notes?: string,
    searchSnippets: string[] = [],
    userText?: string,
  ): TravelPlanSnapshot {
    const missing = this.getMissingFramework();
    if (missing.length > 0) {
      this.phase = 'collecting_framework';
      return this.getSnapshot(
        `还有几项没对上（缺${this.describeMissing(missing)}），先补这些再展开。`,
      );
    }

    const aspect =
      this.parseAspect(aspectRaw) || this.parseAspect(userText || '');
    const expandContext = `${userText || ''} ${aspectRaw} ${notes || ''}`;
    const bookableAspect =
      aspect === 'tickets' ||
      aspect === 'accommodation' ||
      aspect === 'budget_booking' ||
      aspect === 'daily_itinerary';

    // Preference first — do not dump restaurant/ticket options before the user chooses a direction.
    if (
      bookableAspect &&
      !this.primaryInterest &&
      !parseUserTravelInterest(expandContext)
    ) {
      this.phase = 'probing_preferences';
      this.preferenceAsked = true;
      return this.getSnapshot(
        '想先主打哪一类？美食、网红打卡、经典必去，或当地体验——你定一个方向后，我再给你具体选项；选定某一项后才会发预订链接。',
      );
    }

    // User already asked for a concrete section: never bounce back to preference.
    this.ensureReadyToExpand(expandContext);

    if (!aspect) {
      this.phase = 'awaiting_expand_choice';
      return this.getSnapshot(
        `你可以选一块我直接给具体方案：住宿、每日行程、门票预约、花费订票、应急备用。`,
      );
    }

    this.phase = 'expanding';
    this.currentAspect = aspect;
    const summary = this.buildAspectSummary(
      aspect,
      notes,
      searchSnippets,
      userText,
    );
    const existing = this.aspects.findIndex((item) => item.aspect === aspect);
    const draft: TravelAspectDraft = {
      aspect,
      summary,
      updatedAt: Date.now(),
    };
    if (existing >= 0) this.aspects[existing] = draft;
    else this.aspects.push(draft);

    const remaining = preferredAspectOrder(this.primaryInterest).filter(
      (item) => !this.aspects.some((done) => done.aspect === item),
    );
    this.phase = remaining.length ? 'awaiting_expand_choice' : 'done';
    this.currentAspect = null;

    const next =
      remaining.length > 0
        ? `${softBridgePhrase('hold')}若还要继续，我再补${aspectLabel(remaining[0])}的具体点位；先这样也行。`
        : `${softBridgePhrase('done')}若要桌面摘要，说一声“生成计划文件”即可。`;

    return this.getSnapshot(`${summary} ${next}`);
  }

  declineFurther(): TravelPlanSnapshot {
    this.phase = 'done';
    this.currentAspect = null;
    return this.getSnapshot(
      this.buildSkeleton()
        ? `${this.buildSkeleton()}${this.primaryInterest ? `（偏好：${interestLabel(this.primaryInterest)}）` : ''}。${softBridgePhrase('done')}若要落成桌面摘要，可以说“帮我生成计划文件”或调用 travel_finalize_plan。`
        : softBridgePhrase('done'),
    );
  }

  markFinalized(desktopPath: string): TravelPlanSnapshot {
    this.phase = 'done';
    const fileName = desktopPath.split(/[/\\]/).pop() || desktopPath;
    const snapshot = this.getSnapshot(
      `旅行计划网页已做好，放在桌面上了，文件名是「${fileName}」，用浏览器打开就能看排版好的计划。`,
    );
    // Stop travel idle prompts from hijacking unrelated silence after finalize.
    this.phase = 'idle';
    return snapshot;
  }

  noteSearch(query: string): void {
    this.lastSearchQuery = query;
    if (this.phase === 'idle') this.phase = 'collecting_framework';
  }

  /**
   * @param recentUserTurns recent USER utterances only (not assistant lines).
   */
  buildIdleSuggestion(recentUserTurns: string[]): string | null {
    if (this.phase === 'idle') return null;
    this.syncFromConversation(recentUserTurns);
    const latestUser = [...recentUserTurns].reverse().find(Boolean) || '';

    if (this.phase === 'done') {
      // After soft pause: only keep nudging if user is still in travel chat.
      if (
        !isTravelPlanningText(latestUser) &&
        !/(计划文件|桌面|摘要|继续补|再加|行程|住宿)/.test(latestUser)
      ) {
        this.phase = 'idle';
        return null;
      }
      return this.dedupeIdle(
        '计划已经有一版了。要桌面网页摘要，还是再加一个吃饭/打卡点？',
      );
    }

    const askedAspect = this.parseAspect(latestUser);

    // If user already moved to a concrete section, never re-ask preference.
    if (askedAspect) {
      this.ensureReadyToExpand(latestUser);
      return this.dedupeIdle(
        `好，我按你说的直接给${aspectLabel(askedAspect)}的具体推荐：两到三个可执行选项，你挑一个就行。`,
      );
    }

    const missing = this.getMissingFramework();
    if (this.phase === 'collecting_framework' && missing.length) {
      return this.dedupeIdle(
        `旅行规划还差${this.describeMissing(missing)}。${this.buildNextQuestion(missing)}`,
      );
    }

    if (this.primaryInterest) {
      this.ensureReadyToExpand(latestUser);
      const remaining = preferredAspectOrder(this.primaryInterest).filter(
        (aspect) => !this.aspects.some((item) => item.aspect === aspect),
      );
      if (remaining.length) {
        return this.dedupeIdle(
          `偏好我按「${interestLabel(this.primaryInterest)}」记着。要不要我直接推荐${aspectLabel(remaining[0])}的具体方案？`,
        );
      }
      return this.dedupeIdle(
        '这版旅行计划已经有不少内容了，要不要我整理成桌面摘要，还是再补一个打卡点？',
      );
    }

    if (this.phase === 'probing_preferences') {
      if (this.preferenceAsked) {
        // Already asked once — offer a concrete default instead of repeating.
        this.ensureReadyToExpand(latestUser);
        return this.dedupeIdle(
          '我先按「经典必去」给你两三个能落地的点，你觉得不对再换成美食或打卡也行。',
        );
      }
      if (this.highlights.length) {
        this.preferenceAsked = true;
        return this.dedupeIdle(
          `想主打哪一类？美食、网红打卡、经典必去，或当地体验，选一个我就直接给具体行程。`,
        );
      }
      return this.dedupeIdle(
        '时间和地点有了。我可以先按经典必去给你一版可执行草案，你要换方向再说。',
      );
    }
    if (this.phase === 'collecting_constraints') {
      // Soft-skip repeated constraint nagging: default and move on.
      this.ensureReadyToExpand(latestUser);
      return this.dedupeIdle(
        '我先按轻松不赶早给你推荐具体点位；如果你有绝对不能接受的，再说一声就行。',
      );
    }
    if (
      this.phase === 'awaiting_expand_choice' ||
      this.phase === 'skeleton_ready'
    ) {
      const remaining = preferredAspectOrder(this.primaryInterest).filter(
        (aspect) => !this.aspects.some((item) => item.aspect === aspect),
      );
      if (remaining.length) {
        return this.dedupeIdle(
          `要不要我直接给${aspectLabel(remaining[0])}的具体推荐？说“好”我就开始。`,
        );
      }
    }
    if (this.phase === 'expanding' && this.currentAspect) {
      return this.dedupeIdle(
        `我继续把${aspectLabel(this.currentAspect)}补成可执行选项，还是先停在这版？`,
      );
    }
    return null;
  }

  private dedupeIdle(hint: string): string | null {
    const normalized = hint.replace(/\s+/g, '');
    if (
      this.lastIdleSuggestion &&
      normalized === this.lastIdleSuggestion.replace(/\s+/g, '')
    ) {
      return null;
    }
    // Also suppress near-duplicates that only append a tiny tail.
    if (
      this.lastIdleSuggestion &&
      (normalized.includes(
        this.lastIdleSuggestion.replace(/\s+/g, '').slice(0, 18),
      ) ||
        this.lastIdleSuggestion
          .replace(/\s+/g, '')
          .includes(normalized.slice(0, 18)))
    ) {
      return null;
    }
    this.lastIdleSuggestion = hint;
    return hint;
  }

  private getMissingFramework(): Array<keyof TravelFramework> {
    return REQUIRED_FRAMEWORK.filter((key) => !clean(this.framework[key]));
  }

  private describeMissing(missing: Array<keyof TravelFramework>): string {
    const labels: Record<keyof TravelFramework, string> = {
      destination: '目的地',
      origin: '出发地',
      startDate: '出发日期',
      endDate: '返程日期',
      companions: '同行人',
      budget: '预算',
      purpose: '出行目的',
      transport: '大交通方式',
    };
    return missing.map((key) => labels[key]).join('、');
  }

  private buildNextQuestion(
    missing: Array<keyof TravelFramework>,
  ): string | null {
    if (!missing.length) return null;
    const first = missing[0];
    switch (first) {
      case 'destination':
        return '这次想去哪里玩？';
      case 'origin':
        return `从哪个城市出发去${this.framework.destination || '目的地'}？`;
      case 'startDate':
        return '大概哪天出发？有确定日期最好。';
      default:
        return `还需要补充：${this.describeMissing(missing)}。`;
    }
  }

  private buildSkeleton(): string {
    const f = this.framework;
    const when = [f.startDate, f.endDate].filter(Boolean).join(' 到 ');
    const people = f.companions || '人数待定';
    const budget = f.budget || '预算待定';
    const transport = f.transport || '大交通待定';
    const purpose = f.purpose ? `，主题偏${f.purpose}` : '';
    return `行程要点：${f.origin || '出发地待定'}出发去${f.destination || '目的地待定'}，${when || '日期待定'}，${people}，${budget}，${transport}${purpose}`;
  }

  private buildExpandMenu(remaining: TravelAspect[]): string {
    if (!remaining.length) return '各板块都已展开。';
    const bias = this.primaryInterest
      ? `当前偏好${interestLabel(this.primaryInterest)}，建议先看${aspectLabel(remaining[0])}。`
      : '';
    return `${bias}可继续完善：${remaining.map(aspectLabel).join('、')}。一次选一个就好。`;
  }

  private defaultSpeakHint(
    missing: Array<keyof TravelFramework>,
    remaining: TravelAspect[],
  ): string {
    if (missing.length) {
      const question = this.buildNextQuestion(missing);
      const dest = this.framework.destination;
      if (dest) {
        const leads = [
          `去${dest}可以呀。`,
          `行，${dest}这边我先跟你对一下。`,
          `${dest}挺好的。`,
        ];
        return `${leads[softBridgeCursor % leads.length]}${question}`;
      }
      return question ?? '';
    }
    if (this.phase === 'probing_preferences') {
      if (this.highlights.length) {
        return `请用大类亮点试探偏好，一次问用户最感兴趣的一类。`;
      }
      return '请先 travel_probe_highlights，再问用户偏好。';
    }
    if (this.phase === 'collecting_constraints') {
      return CONSTRAINT_CARD_PROMPT;
    }
    if (this.phase === 'awaiting_expand_choice') {
      return `${this.buildSkeleton()}。${this.buildExpandMenu(remaining)}`;
    }
    if (this.phase === 'done') {
      return `${softBridgePhrase('done')}若要桌面摘要，调用 travel_finalize_plan。`;
    }
    return this.buildSkeleton() || '想去哪玩？我先跟你对一下时间和地点。';
  }

  private parseAspect(raw: string): TravelAspect | null {
    const text = raw.trim().toLowerCase();
    if (!text) return null;
    if (/(住宿|酒店|民宿|住哪)/.test(text) || text === 'accommodation') {
      return 'accommodation';
    }
    if (
      /(每日|行程|日程|安排|玩什么|itinerary|daily)/.test(text) ||
      text === 'daily_itinerary'
    ) {
      return 'daily_itinerary';
    }
    if (
      /(门票|预约|票务|买票|订票|雪票|缆车|索道|预订.*票|滑雪.*票|tickets)/.test(
        text,
      ) ||
      text === 'tickets'
    ) {
      return 'tickets';
    }
    if (
      /(花费|预算明细|订票|下单|booking|budget)/.test(text) ||
      text === 'budget_booking'
    ) {
      return 'budget_booking';
    }
    if (/(应急|备用|保险|风险|emergency)/.test(text) || text === 'emergency') {
      return 'emergency';
    }
    return null;
  }

  private buildAspectSummary(
    aspect: TravelAspect,
    notes: string | undefined,
    snippets: string[],
    userText?: string,
  ): string {
    const f = this.framework;
    const noteText = clean(notes);
    const interest = this.primaryInterest;
    const interestText = interest ? interestLabel(interest) : null;
    const picked = interest
      ? this.highlights.find((item) => item.interest === interest)
      : undefined;
    const placeLine = this.buildPlaceLine(aspect, snippets, notes, userText);
    const constraintLead = this.describeConstraintsInline();
    const pace =
      this.constraints.okWithEarlyStart === false ? '出发偏晚、不赶早。' : '';
    const walk =
      this.constraints.okWithWalking === false ? '少步行、优先地铁直达。' : '';
    const ski = isSkiOriented(
      `${f.destination || ''} ${f.purpose || ''} ${notes || ''}`,
    );

    switch (aspect) {
      case 'accommodation':
        return `${aspectLabel(aspect)}：${constraintLead}${pace}${walk}围绕「${interestText || (ski ? '滑雪' : '行程')}」${picked ? `靠近 ${picked.title}` : '靠近主活动区'}。${placeLine}预算按${f.budget || '你的预算'}控制；${noteText || '优先可免费取消。'}`;
      case 'daily_itinerary': {
        const blob = `${f.purpose || ''} ${notes || ''} ${userText || ''}`;
        const dayPlan = buildDayPlanFromCatalog({
          destination: f.destination,
          interest,
          userText: blob,
          preferLateStart: this.constraints.okWithEarlyStart === false,
          dayCount: /(一天|一日|1\s*天|当日|就一天)/.test(blob) ? 1 : 2,
        });
        const paceBits = [
          this.constraints.okWithEarlyStart === false ? '不赶早' : null,
          this.constraints.okWithWalking === false ? '少走路' : null,
        ].filter(Boolean);
        const paceNote = paceBits.length ? `（${paceBits.join('、')}）` : '';
        return `${dayPlan}${paceNote}`;
      }
      case 'tickets':
        return `${aspectLabel(aspect)}：${constraintLead}${this.constraints.okWithQueues === false ? '优先可预约/快速通道。' : ''}${placeLine}${noteText || ''}`;
      case 'budget_booking':
        return `${aspectLabel(aspect)}：总预算${f.budget || '待定'}。建议今天就定：大交通+住宿；给「${interestText || '主线'}」留弹性。${placeLine}${noteText || ''}`;
      case 'emergency':
        return `${aspectLabel(aspect)}：护照页/订单离线备份、旅行保险、当地急救与改签思路各准备一条。${noteText || '这份先作保底，不占用游玩时间。'}`;
      default:
        return placeLine;
    }
  }

  /**
   * Options first (no URLs). Booking links only after the user confirms one.
   */
  private buildPlaceLine(
    aspect: TravelAspect,
    snippets: string[],
    notes?: string,
    userText?: string,
  ): string {
    const catalogPlaces = resolveBookableOptions({
      destination: this.framework.destination,
      aspect,
      interest: this.primaryInterest,
      userText: `${this.framework.purpose || ''} ${notes || ''} ${userText || ''}`,
      preferLateStart: this.constraints.okWithEarlyStart === false,
      limit: 3,
    });

    if (catalogPlaces.length) {
      const selectionBlob = this.selectionTextForConfirm(notes, userText);
      const selected = selectionBlob
        ? matchSelectedCatalogPlace(catalogPlaces, selectionBlob)
        : null;

      if (selected?.url) {
        this.rememberConfirmedBooking(selected);
        return `你选定了「${selected.name}」。预订链接：${selected.url}（请自己打开下单，我不代订）。`;
      }

      const listed = catalogPlaces
        .map(
          (place, index) =>
            `${index + 1}) ${formatCatalogOption(place, { withUrl: false })}`,
        )
        .join('；');
      return `可执行选项：${listed}。你先定一个（可以说选项名或“选1”）；选定后我再发对应预订链接。`;
    }

    const fromSnippets = snippets
      .map((item) =>
        item
          .replace(/https?:\/\/\S+/gi, '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter(Boolean)
      .map((item) => (item.length > 36 ? `${item.slice(0, 34)}…` : item))
      .slice(0, 3);
    if (fromSnippets.length) {
      return `可执行选项：${fromSnippets.map((place, index) => `${index + 1}) ${place}`).join('；')}。你先定一个，选定后再给你预订入口。`;
    }

    const fromHighlights = this.highlights
      .filter((item) => {
        if (aspect === 'daily_itinerary' || aspect === 'tickets') return true;
        if (aspect === 'accommodation') {
          return (
            item.interest === this.primaryInterest ||
            item.interest === 'landmark' ||
            item.interest === 'food'
          );
        }
        return item.interest === this.primaryInterest;
      })
      .map((item) =>
        item.detail ? `${item.title}（${item.detail}）` : item.title,
      )
      .slice(0, 3);
    if (fromHighlights.length) {
      return `可执行选项：${fromHighlights.map((place, index) => `${index + 1}) ${place}`).join('；')}。你先定一个，选定后再给你预订入口。`;
    }

    return `可执行选项：先锁定${this.framework.destination || '目的地'}附近 2～3 个候选。你先说更偏向哪一类，选定具体项后我再发链接。`;
  }

  private rememberConfirmedBooking(place: CatalogPlace): void {
    if (!place.url) return;
    if (this.confirmedBookings.some((item) => item.url === place.url)) return;
    this.confirmedBookings.push({
      name: place.name,
      url: place.url,
      blurb: place.blurb,
    });
  }

  /**
   * Confirm only via `notes` (or a pure “选1” promoted into notes by the voice
   * layer). Ignore expand-request userText so links never bleed across aspects.
   */
  private selectionTextForConfirm(notes?: string, _userText?: string): string {
    return clean(notes) || '';
  }

  private hasConstraintAnswers(): boolean {
    return (
      this.constraints.okWithWalking != null ||
      this.constraints.okWithEarlyStart != null ||
      this.constraints.okWithQueues != null
    );
  }

  private describeConstraintsInline(): string {
    if (!this.hasConstraintAnswers()) return '';
    const bits = [
      this.constraints.okWithWalking === false ? '少走路' : null,
      this.constraints.okWithEarlyStart === false ? '不赶早' : null,
      this.constraints.okWithQueues === false ? '少排队' : null,
    ].filter(Boolean);
    return bits.length ? `${bits.join('、')}。` : '';
  }

  private inferConstraintsFromText(text?: string): TravelConstraints {
    if (!text) return {};
    const result: TravelConstraints = {};
    if (/(不能走太[多远]|少走路|不爱走路|腿脚|少步行)/.test(text)) {
      result.okWithWalking = false;
    } else if (/(走路没问题|可以多走走|能走)/.test(text)) {
      result.okWithWalking = true;
    }
    if (/(不早起|不起早|讨厌早起|别太早)/.test(text)) {
      result.okWithEarlyStart = false;
    } else if (/(可以早起|早起没问题|能早起)/.test(text)) {
      result.okWithEarlyStart = true;
    }
    if (/(不排队|讨厌排队|不想排队|别排队)/.test(text)) {
      result.okWithQueues = false;
    } else if (
      /(可以排队|排队没问题|排队还可以|排队也行|能排队|能等)/.test(text)
    ) {
      result.okWithQueues = true;
    }
    return result;
  }

  private inferFromUserText(text?: string): void {
    if (!text) return;

    if (!this.framework.destination) {
      const known =
        text.match(/(崇礼|太舞|云顶|张家口|巴黎|东京|大阪|京都|首尔)/)?.[1] ||
        null;
      const dest =
        known ||
        text.match(
          /去(?:一趟|玩玩|旅游|旅行)?([\u4e00-\u9fa5A-Za-z]{2,12}?)(?:的|玩|旅游|旅行|机票|酒店|滑雪|吗|呢|吧|$)/,
        )?.[1] ||
        text.match(
          /到([\u4e00-\u9fa5A-Za-z]{2,12}?)(?:玩|旅游|旅行|的|机票|酒店|滑雪|$)/,
        )?.[1];
      if (dest && !/(哪里|哪儿|酒店|机票)/.test(dest)) {
        this.framework.destination = dest;
      } else if (isSkiOriented(text)) {
        this.framework.destination = '崇礼';
      }
    }
    if (!this.framework.purpose && isSkiOriented(text)) {
      this.framework.purpose = '滑雪';
    }

    if (!this.framework.origin) {
      const origin = text.match(
        /从([\u4e00-\u9fa5A-Za-z]{2,12})(?:出发|飞|去)/,
      )?.[1];
      if (origin) this.framework.origin = origin;
    }

    if (!this.framework.transport && /(机票|航班|飞机|飞过去)/.test(text)) {
      this.framework.transport = '机票';
    }
    if (!this.framework.purpose && /(蜜月|亲子|商务|美食|观光)/.test(text)) {
      this.framework.purpose = text.match(/(蜜月|亲子|商务|美食|观光)/)?.[1];
    }
    if (!this.framework.companions) {
      const people =
        text.match(/([0-9一二两三四五六七八两]{1,2})\s*个人/)?.[1] ||
        text.match(/(一家三口|两个人|自己一人|独自)/)?.[1];
      if (people) this.framework.companions = people;
    }
    if (!this.framework.budget) {
      const budget = text.match(
        /预算\s*([0-9一二三四五六七八九十百千万约]+(?:元|块|人民币)?)/,
      )?.[1];
      if (budget) this.framework.budget = budget;
      const soft = text.match(/([0-9]+)\s*(?:元|块)\s*以内/)?.[0];
      if (!this.framework.budget && soft) this.framework.budget = soft;
    }
  }
}

export const travelPlanner = new TravelPlanner();
