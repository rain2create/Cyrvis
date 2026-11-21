/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'node:path';

import type { TaskController } from './controller';
import {
  gazeDesktopAction,
  gazeDesktopInstruction,
  type GazeActionContext,
  type GazeDesktopAction,
} from './gaze/actions';
import {
  gazeActionRequest,
  resolveGazeReply,
  type GazeAction,
  type GazeSuggestion,
} from './gaze/suggestions';
import { TaskBusyError } from './controller';
import type { CodingAgentController, CodingTaskSnapshot } from './coding-agent';
import type { AllowedApp, SearchEngine } from './desktop-actions';
import { buildSearchUrl, defaultSearchEngine } from './navigation';
import { resolveSite, buildSiteSearchUrl } from './site-registry';
import { NAVIGATION_TOOL_ALIASES } from './voice/tool-surface';
import { classifyIntent, isExplicitChat } from './intent-gate';
import { SENSITIVE_CONFIRMATION_PROMPT } from './tools/confirmation-policy';
import { IntakeEngine } from './intake/engine';
import { IntakeScheduler } from './intake/scheduler';
import type { IntakeSession, IntakeSlotSpec } from './intake/types';
import { ProactivityPolicy, type ProactivityOptions } from './proactivity';
import { classifyVoiceIntent, type VoiceIntentDecision } from './search-intent';
import { TaskConversationCoordinator } from './task-conversation';
import { isLikelySpeakerEcho } from './speaker-echo';
import {
  isExplicitTravelGuiRequest,
  isTravelPlanningText,
  travelPlanner,
} from './travel/travel-planner';
import {
  appendTravelMemo,
  writeTravelPlanDesktopTxt,
} from './travel/travel-memo';
import {
  buildTravelSearchQuery,
  hitsToSnippets,
  probeTravelHighlights,
  searchTravelInfo,
} from './travel/travel-search';
import {
  TRAVEL_FLIGHT_DOMAIN,
  TRAVEL_FLIGHT_SLOTS,
  compareFlights,
  compareLiveFlights,
  formatFlightComparison,
  formatLiveFlightComparison,
  isTravelFlightIntent,
  parseTravelDate,
  parseTravelDestination,
  parseTravelDurationDays,
  parseTravelOrigin,
  type FlightComparison,
  type FlightSearchInput,
} from './travel/travel-flight';
import {
  buildGoogleFlightsUrl,
  searchLiveFlights,
  type LiveFlightSearchResult,
} from './travel/flight-provider';
import {
  focusOtaOffer,
  searchOtaFlights,
  type OtaFlightSearchResult,
} from './travel/ota-flight-provider';
import type { ControllerEvent } from './types';
import {
  extractBrowserSearchQuery,
  type FastToolOutcome,
  type FastToolRoute,
  type FastToolRouter,
} from './tools';
import type { CyrvisVoiceState } from '@shared/cyrvis';
import type {
  VoiceProvider,
  VoiceProviderCallbacks,
  VoiceToolCallWithId,
} from './voice/provider';
import type {
  PendingIntentDecision,
  PendingIntentInput,
} from './voice/pending-intent-classifier';
import type { TravelPlanSnapshot } from './travel/travel-planner';

export type VoiceBrainState = CyrvisVoiceState;

/** Compact travel tool payloads so the voice model does not stall on huge JSON. */
const slimTravelResult = (
  snapshot: TravelPlanSnapshot,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ok: true,
  phase: snapshot.phase,
  missingFramework: snapshot.missingFramework,
  nextQuestion: snapshot.nextQuestion,
  primaryInterest: snapshot.primaryInterest,
  interestLabel: snapshot.interestLabel,
  preferredNextAspect: snapshot.preferredNextAspect,
  softBridge: snapshot.softBridge,
  speakHint: snapshot.speakHint,
  // Prefer speakHint over raw skeleton wording (“骨架攻略”).
  routeHint: snapshot.skeleton
    ? snapshot.skeleton.replace(/^骨架攻略：|^行程要点：/, '')
    : null,
  confirmedBookings: snapshot.confirmedBookings.slice(0, 4),
  latestAspects: snapshot.aspects.slice(-2).map((item) => ({
    aspect: item.aspect,
    summary: item.summary.slice(0, 220),
  })),
  ...extra,
});

const coerceOptionalBoolean = (value: unknown): boolean | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', '是', '可以', '能', '接受'].includes(text)) {
      return true;
    }
    if (
      ['false', '0', 'no', 'n', '否', '不', '不行', '不能', '别'].includes(text)
    ) {
      return false;
    }
  }
  return undefined;
};

export interface VoiceBrainCallbacks {
  onAudio?: (pcm16: Int16Array) => void;
  onSpeechStarted?: () => void;
  onSpeechStopped?: () => void;
  onTranscript?: (text: string, final: boolean) => void;
  onAssistantText?: (text: string, final: boolean) => void;
  onSpeechText?: (text: string, final: boolean) => void;
  onState?: (state: VoiceBrainState) => void;
  onWake?: () => void;
  onSleep?: () => void;
  onTaskEvent?: (event: ControllerEvent) => void;
  /** The ASR transcript is almost certainly the assistant's own speaker audio. */
  onSelfEcho?: () => void;
  onError?: (error: Error) => void;
}

export interface VoiceBrainOptions {
  getGazeInspectionId?: () => string | undefined;
  getGazeActionContext?: (text: string) => GazeActionContext | null;
  inspectGaze?: (question: string) => Promise<string>;
  snoozeProactiveGaze?: (ms?: number) => void;
  requireWakeWord?: boolean;
  awakeTimeoutMs?: number;
  wakePatterns?: RegExp[];
  enableProactivity?: boolean;
  /** A clear task/control command can wake the assistant without the wake word. */
  autoWakeOnTask?: boolean;
  proactivity?: ProactivityOptions;
  memoryContextProvider?: () => Promise<string>;
  rememberFact?: (text: string) => Promise<string | null>;
  fastToolRouter?: FastToolRouter;
  codingAgent?: CodingAgentController;
  classifyPendingIntent?: (
    input: PendingIntentInput,
  ) => Promise<PendingIntentDecision>;
  /** Used by the travel demo to open the recommended booking page. */
  openExternal?: (url: string) => Promise<void>;
  /** Retained for the travel demo tests. */
  travelBookingOpenDelayMs?: number;
  /** Real-time flight search. Tests inject a fixture; production uses Google Flights. */
  flightSearch?: (input: FlightSearchInput) => Promise<LiveFlightSearchResult>;
  /** Best-effort Ctrip/Trip.com scrape. Tests inject a fixture. */
  otaSearch?: (input: FlightSearchInput) => Promise<OtaFlightSearchResult>;
  /** Set false only for the deterministic demo/tests. */
  useLiveFlights?: boolean;
  /** Set false in tests to avoid launching a visible browser. */
  useOtaFlights?: boolean;
  getWorkflowStatus?: () => {
    name: string;
    status: string;
    currentStepId: string | null;
    pendingConfirmation: { stepId: string; reason: string } | null;
    totalSteps: number;
    completedSteps: number;
  } | null;
  cancelWorkflow?: () => Promise<boolean>;
}

const DEFAULT_WAKE_PATTERNS: RegExp[] = [
  /\b(hello|hallo|hi|hey|ok)[\s,，]*(cyrvis|cyrus|cyris|cyprus|cypres|cypress|cybris|sirvis|cervis|sirius|siris|service|zawis|zavis|savis|cywiz|cy vis)\b/i,
  /\b(cyrvis|cyrus|cyris|cyprus|cypres|cypress|cybris|zawis|zavis|savis|savage|savages|s voice|svoice)\b/i,
  /\b(hello|hallo|hi|hey)\b/i,
  /(你好|您好|嗨|哈喽|哈啰|哈罗)/,
  /(你好|您好|嗨|喂|哈喽|哈啰|哈罗)[，,\s]*(cyrvis|赛维斯|瑟维斯|瑟尔维斯|赛勒斯|塞勒斯|赛鲁斯|塞浦路斯|塞维斯)/i,
  /(赛维斯|瑟维斯|瑟尔维斯|赛勒斯|塞勒斯|赛鲁斯|塞维斯)/i,
];

const USER_RESPONSE_FALLBACK_MS = 900;
const isGazeQuestion = (text: string) =>
  /(我(?:现在在|正在|在)看什么|我看(?:的|着的)(?:是)?什么|看看我在看|这个是什么|帮我看看这里|识别一下(?:这个|这里|我看的)|我(?:现在|刚才)?注视的是(?:谁|什么))/.test(
    text,
  );

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:：""''“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeTranscriptDedupeKey = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');

const shouldClassifyPendingReply = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed || Array.from(trimmed).length > 40) {
    return false;
  }
  return /(?:对|是|好|行|嗯|可以|确认|执行|删|取消|不要|不是|别|yes|no|ok|continue)/i.test(
    trimmed,
  );
};

/**
 * A search intent that also needs real page interaction (click a result,
 * book a flight, fill a form) is still a GUI task. Plain lookup/search must
 * go through search_web instead.
 */
const GUI_INTERACTION_PATTERNS: RegExp[] = [
  /(点击|点一下|双击|选择|预订|下单|填写|登录|滚动|比较|对比|查看页面|截图|截屏|加入购物车|支付|购买|提交|确认订单)/,
  /\b(click|select|book|order|fill|login|scroll|compare|screenshot|add to cart|pay|purchase|submit)\b/i,
];

/**
 * The conversational brain.
 *
 * Responsibilities:
 * - wake/sleep gating for "Hello CYRVIS";
 * - route tool calls through the intent gate before touching the GUI agent;
 * - drop audio/tool calls while asleep;
 * - translate Controller events into proactive speech.
 */
export class VoiceBrain {
  private readonly provider: VoiceProvider;
  private readonly proactivity: ProactivityPolicy;
  private readonly taskConversation: TaskConversationCoordinator;
  private awake = false;
  private userSpeaking = false;
  private ttsSpeaking = false;
  private userSpeechStartedAt = 0;
  private lastUserSpeechAt = 0;
  private lastUserSpeechDurationMs = 0;
  private lastUserText = '';
  private lastVoiceIntent: VoiceIntentDecision | null = null;
  private lastActionableUserText = '';
  private partialUserText = '';
  private assistantTextBuffer = '';
  private lastFinalTranscript = '';
  private lastFinalAt = 0;
  private lastEmptyReplyAt = 0;
  private inspectionGeneration = 0;
  private gazeSuggestion: { value: GazeSuggestion; expiresAt: number } | null =
    null;
  private gazeActionHandledUntil = 0;
  private speechAwaitingTranscript = false;
  private speechTurn = 0;
  private pendingGazeRequests = 0;
  private gazeToolTurn: {
    generation: number;
    speechTurn: number;
    awaitingTranscript: boolean;
  } | null = null;
  private lastInspection: {
    question: string;
    at: number;
    result: Promise<string>;
  } | null = null;
  private deterministicInspection: {
    generation: number;
    toolReply: boolean;
    answered: boolean;
  } | null = null;
  private suppressAudioUntilResponseDone = false;
  private completionGuardTriggered = false;
  private awakeTimer: ReturnType<typeof setTimeout> | null = null;
  private speakWatchdog: ReturnType<typeof setTimeout> | null = null;
  private playbackWatchdog: ReturnType<typeof setTimeout> | null = null;
  private responseHadAudio = false;
  private responseHadText = false;
  private responseHadSpeechOutput = false;
  private currentResponseText = '';
  private userResponseWatchdog: ReturnType<typeof setTimeout> | null = null;
  private waitingForUserResponse = false;
  private userResponseOutputSeen = false;
  private lastAssistantText = '';
  private lastAssistantAudioAt = 0;
  private lastAssistantTextAt = 0;
  // After a bare "停/暂停", do not let the model speak an acknowledgment.
  // The user expects the audio to stop, not a new reply confirming it.
  private suppressReplyUntil = 0;
  private userStopped = false;
  private stopToolGuardUntil = 0;
  private taskSpeechGuardUntil = 0;
  private readoutGuardUntil = 0;
  private gazeContextTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingBargeStopAt = 0;
  private lastDeterministicControl: {
    kind: 'cancel' | 'pause';
    at: number;
  } | null = null;
  private fastToolGuardUntil = 0;
  private deterministicFastToolGuardUntil = 0;
  private codingToolGuardUntil = 0;
  private codingFileNames = new Set<string>();
  private lastCodingProgressAt = 0;
  private lastCodingProgressMessage = '';
  private readonly intakeEngine = new IntakeEngine();
  private readonly intakeScheduler = new IntakeScheduler();
  private travelFlightCompleting = false;
  private flightComparisonActiveUntil = 0;
  private lastHardStopAt = 0;
  private navigationExecutions = new Set<string>();
  private readonly backgroundToolJobs = new Map<
    string,
    {
      heartbeat: ReturnType<typeof setInterval>;
      startFallback: ReturnType<typeof setTimeout> | null;
    }
  >();
  private readonly unsubscribeController: () => void;
  private readonly completionClaimPattern =
    /(已经打开|已经输入|已经完成|已完成|完成了|打开了|输入了|opened|typed|completed|finished|done|succeeded)/i;

  private readonly requireWakeWord: boolean;
  private readonly awakeTimeoutMs: number;
  private readonly wakePatterns: RegExp[];

  constructor(
    private readonly controller: TaskController,
    private readonly callbacks: VoiceBrainCallbacks = {},
    providerFactory: (callbacks: VoiceProviderCallbacks) => VoiceProvider,
    private readonly options: VoiceBrainOptions = {},
  ) {
    this.requireWakeWord = options.requireWakeWord ?? true;
    this.awakeTimeoutMs = options.awakeTimeoutMs ?? 20_000;
    this.wakePatterns = options.wakePatterns || DEFAULT_WAKE_PATTERNS;

    this.provider = providerFactory(this.createProviderCallbacks());

    this.proactivity = new ProactivityPolicy(
      (utterance) => {
        if (!this.awake) {
          return;
        }
        this.speak(utterance.text);
      },
      {
        // Qwen acknowledges a successful tool call by itself; do not double-ack.
        acknowledgeOnStart: false,
        enableProgress: false,
        enableSuggestions: false,
        ...options.proactivity,
      },
    );
    this.taskConversation = new TaskConversationCoordinator({
      speak: (text) => {
        if (this.userStopped || this.shouldSuppressReply()) {
          console.log('[cyrvis voice] task speech suppressed after stop', {
            text,
          });
          return;
        }
        if (!this.awake) {
          this.wake();
        }
        // Task progress/status speech is proactive; in speaker mode its own
        // echo must not trigger an energy barge that kills the task. KWS
        // stop words still bypass this guard.
        this.taskSpeechGuardUntil = Date.now() + 1_800;
        this.speak(text);
      },
      clearSpeech: () => this.provider.cancelPendingSpeech?.(),
      getStatus: () => this.controller.getStatus(),
    });

    this.unsubscribeController = controller.onEvent((event) => {
      this.callbacks.onTaskEvent?.(event);
      this.taskConversation.onEvent(event);
      this.notifyState();
    });
  }

  async start(): Promise<void> {
    if (this.provider.setContext) {
      const memoryContext =
        (await this.options
          .memoryContextProvider?.()
          .catch((error: unknown) => {
            console.warn('[cyrvis memory] context load failed', error);
            return '';
          })) || '';
      this.provider.setContext(memoryContext);
    }
    await this.provider.connect();
    if (!this.requireWakeWord) {
      this.wake();
    }
    this.notifyState();
  }

  getState(): VoiceBrainState {
    return {
      awake: this.awake,
      userSpeaking: this.userSpeaking,
      ttsSpeaking: this.ttsSpeaking,
      readoutGuardUntil: this.readoutGuardUntil,
      lastUserText: this.lastUserText,
      task: this.controller.getStatus(),
    };
  }

  forceAwake(): void {
    this.wake();
  }

  /** Progress from long-running non-GUI tools uses the same voice path. */
  announceProgress(text: string): void {
    const message = text.trim();
    if (!message || this.userSpeaking || this.ttsSpeaking) return;
    this.wake();
    this.taskSpeechGuardUntil = Date.now() + 1_800;
    this.speak(message);
  }

  /** A button/hotkey is an explicit reply request even when voice is asleep. */
  speakRequestedReply(text: string, readoutId?: string): void {
    this.suppressReplyUntil = 0;
    this.wake();
    this.protectGazeReadout();
    if (readoutId) this.rememberGazeContext(readoutId, text);
    this.speak(text, readoutId);
  }

  private rememberGazeContext(id: string, observation: string): void {
    if (this.gazeContextTimer) clearTimeout(this.gazeContextTimer);
    this.provider.setGazeContext?.(
      JSON.stringify({ screenshotId: id, observedAt: Date.now(), observation }),
    );
    this.gazeContextTimer = setTimeout(
      () => this.provider.setGazeContext?.(''),
      120_000,
    );
  }

  submitChatText(text: string): { ok: boolean; error?: string } {
    if (this.provider.isReady?.() === false)
      return { ok: false, error: '请先连接语音助手。' };
    this.wake();
    this.provider.cancelResponse();
    const consumed = this.handleTranscript(text.trim(), true);
    if (!consumed && this.provider.submitText?.(text.trim()) !== true)
      return { ok: false, error: '语音引擎暂时无法接收消息，请重试。' };
    return { ok: true };
  }

  private protectGazeReadout(): void {
    // Cleared by actual renderer playback-idle, not server response.done:
    // streamed audio may still have several seconds left in the queue.
    this.readoutGuardUntil = Date.now() + 45_000;
    this.notifyState();
  }

  isReadoutSpeechActive(): boolean {
    return Date.now() < this.readoutGuardUntil;
  }

  clearGazeSuggestion(): void {
    this.gazeSuggestion = null;
  }
  canOfferGazeSuggestion(): boolean {
    return !this.gazeSuggestionBlockReason();
  }
  gazeSuggestionBlockReason(): string | undefined {
    if (this.options.codingAgent?.isBusy())
      return '编码任务正在执行，结束后恢复主动提醒。';
    if (this.controller.isBusy())
      return '桌面任务正在执行或等待模型，结束后恢复主动提醒。';
    if (this.userSpeaking) return '正在听你说话，结束后恢复注视计时。';
    if (this.ttsSpeaking) return '正在播报，播报结束后恢复注视计时。';
    if (this.waitingForUserResponse || this.pendingGazeRequests > 0)
      return '正在处理你的请求，完成后恢复主动提醒。';
    return undefined;
  }
  offerGazeSuggestion(value: GazeSuggestion): boolean {
    if (
      this.provider.isReady?.() === false ||
      this.provider.isConnected?.() === false
    )
      return false;
    this.gazeSuggestion = { value, expiresAt: Date.now() + 120_000 };
    this.speakRequestedReply(value.speech, value.inspectionId);
    return true;
  }
  isGazeFollowup(text: string): boolean {
    const pending = this.gazeSuggestion;
    return (
      !!pending &&
      Date.now() < pending.expiresAt &&
      resolveGazeReply(text, pending.value) !== null
    );
  }
  followGazeSuggestion(
    id: string,
    action: GazeAction | 'dismiss',
  ): { ok: boolean; message?: string } {
    const pending = this.gazeSuggestion;
    if (!pending || pending.value.id !== id || Date.now() >= pending.expiresAt)
      return {
        ok: false,
        message: '这条建议已过期，请重新看向目标或直接说出完整请求。',
      };
    if (action === 'dismiss') {
      this.gazeSuggestion = null;
      this.options.snoozeProactiveGaze?.(60_000);
      this.provider.cancelResponse();
      this.speakRequestedReply('好，先不打扰你。');
      return { ok: true };
    }
    if (!pending.value.actions.some((item) => item.kind === action))
      return {
        ok: false,
        message: '这个对象暂不支持该操作，请先确认目标名称。',
      };
    if (
      (action === 'play' || action === 'open') &&
      (this.options.getGazeActionContext ||
        action === 'open' ||
        !pending.value.identified)
    ) {
      const context = pending.value.gaze
        ? { gaze: pending.value.gaze, observedAt: pending.value.gaze.at }
        : this.options.getGazeActionContext?.('刚才的这个对象') || null;
      const started = this.routeGazeDesktopAction(
        action === 'play'
          ? '执行刚才注视对象的播放操作'
          : '打开刚才注视的对象查看详情',
        action === 'play' ? 'play' : 'click',
        context,
      );
      return started
        ? { ok: true }
        : { ok: false, message: '请重新锁定目标或先处理当前桌面任务。' };
    }
    const request = gazeActionRequest(pending.value, action);
    this.gazeSuggestion = null;
    this.options.snoozeProactiveGaze?.();
    this.inspectionGeneration++;
    this.lastUserText = request;
    this.lastActionableUserText = request;
    this.lastVoiceIntent = classifyVoiceIntent(request);
    this.suppressReplyUntil = 0;
    this.wake();
    this.provider.cancelResponse();
    this.armUserResponseWatchdog();
    if (this.provider.submitText?.(request) !== true) {
      this.speak(
        '当前语音引擎无法接收这条上下文请求，请直接说出目标名称和要做的操作。',
      );
      return { ok: false, message: '当前语音引擎不支持上下文请求' };
    }
    return { ok: true };
  }

  isTaskSpeechActive(): boolean {
    return Date.now() < this.taskSpeechGuardUntil;
  }

  shouldSuppressReply(): boolean {
    return Date.now() < this.suppressReplyUntil;
  }

  private clearUserResponseWatchdog(): void {
    if (this.userResponseWatchdog) {
      clearTimeout(this.userResponseWatchdog);
      this.userResponseWatchdog = null;
    }
  }

  private markUserResponseOutput(): void {
    this.userResponseOutputSeen = true;
    this.waitingForUserResponse = false;
    this.clearUserResponseWatchdog();
    this.taskConversation.dispose();
  }

  private armUserResponseWatchdog(): void {
    this.clearUserResponseWatchdog();
    this.waitingForUserResponse = true;
    this.userResponseOutputSeen = false;
    this.userResponseWatchdog = setTimeout(() => {
      this.userResponseWatchdog = null;
      if (
        !this.waitingForUserResponse ||
        this.userResponseOutputSeen ||
        this.shouldSuppressReply()
      ) {
        return;
      }
      const taskActive = ['starting', 'executing', 'paused'].includes(
        this.controller.getStatus().status,
      );
      this.markUserResponseOutput();
      this.speak(
        taskActive ? '我在处理，完成后我会告诉你。' : this.fallbackReply(),
      );
    }, USER_RESPONSE_FALLBACK_MS);
  }

  private fallbackReply(): string {
    const text = this.lastUserText.trim();
    if (/(?:pptx?|powerpoint|演示文稿)/i.test(text)) {
      return '好，PPT 任务已开始。';
    }
    if (/(?:写入|写到|写进|保存|文本文件|\.txt\b|txt文件)/i.test(text)) {
      return '好，正在写入文件。';
    }
    if (/(?:关闭|关掉|退出)/i.test(text)) {
      return '好，正在关闭。';
    }
    if (/(?:打开|启动|运行)/i.test(text)) {
      return '好，正在打开。';
    }
    if (/(?:搜索|搜一下|查一下|查找)/i.test(text)) {
      return '好，正在查找。';
    }
    if (/(?:创建|新建|制作|生成)/i.test(text)) {
      return '好，正在处理。';
    }
    return '我在，马上回答。';
  }

  /**
   * Any confirmed barge is a stop request, even when ASR returns empty or
   * mishears "停". Cancel the current response and keep the model silent for
   * a short window so it cannot answer with "好的，已暂停…".
   */
  markUserStop(preserveIntake = false): void {
    this.readoutGuardUntil = 0;
    this.inspectionGeneration++;
    this.gazeToolTurn = null;
    this.deterministicInspection = null;
    this.lastInspection = null;
    this.gazeActionHandledUntil = 0;
    // Stop invalidates the old reply/task, while a NEW gaze target can resume
    // after the ordinary short cooldown. It does not pause eye tracking for a minute.
    this.options.snoozeProactiveGaze?.(8_000);
    if (this.gazeSuggestion) {
      this.gazeSuggestion = null;
    }
    if (!preserveIntake) {
      this.clearTravelFlightIntake();
    }
    // Qwen can start a follow-up response 2-3s after the barge audio was
    // cancelled. 3s covers the observed 2.3s follow-up while still allowing
    // a real new command to clear the window immediately.
    this.userStopped = true;
    this.suppressReplyUntil = Date.now() + 3000;
    this.stopToolGuardUntil = Date.now() + 3000;
    this.clearUserResponseWatchdog();
    this.waitingForUserResponse = false;
  }

  /**
   * Deterministic barge stop. Do not wait for ASR: a confirmed barge may be a
   * short "停" that the model hears as empty or something else several seconds
   * later. Pause the GUI task and keep the assistant silent.
   *
   * An energy barge is usually the user starting to answer the assistant's
   * question (e.g. "北京出发" while it asks for the origin), so it must stop
   * the speech without discarding an active intake. A KWS/global-shortcut
   * barge is an explicit stop and still clears the intake.
   */
  handleBargeStop(hardStop = false): void {
    // An energy barge only interrupts speech. It must not kill a coding task
    // that runs in the background: in speaker mode the microphone regularly
    // hears the assistant's own TTS and produces exactly this kind of barge,
    // which used to cancel coding tasks that the user never asked to stop.
    // KWS / Ctrl+Alt+X are explicit stops and still cancel everything.
    this.handleStopCommand(!hardStop, hardStop ? 'all' : 'gui');
  }

  sleep(): void {
    this.readoutGuardUntil = 0;
    this.inspectionGeneration++;
    if (!this.awake) {
      return;
    }
    this.awake = false;
    this.clearAwakeTimer();
    this.clearUserResponseWatchdog();
    this.callbacks.onSleep?.();
    this.notifyState();
  }

  dispose(): void {
    if (this.gazeContextTimer) clearTimeout(this.gazeContextTimer);
    this.inspectionGeneration++;
    this.clearAwakeTimer();
    this.clearPlaybackWatchdog();
    this.clearUserResponseWatchdog();
    if (this.speakWatchdog) {
      clearTimeout(this.speakWatchdog);
      this.speakWatchdog = null;
    }
    this.clearTravelFlightIntake();
    for (const job of this.backgroundToolJobs.values()) {
      clearInterval(job.heartbeat);
      if (job.startFallback) clearTimeout(job.startFallback);
    }
    this.backgroundToolJobs.clear();
    this.unsubscribeController();
    this.proactivity.reset();
    this.provider.close();
  }

  private createProviderCallbacks(): VoiceProviderCallbacks {
    return {
      onReady: () => {
        if (!this.requireWakeWord) {
          this.wake();
        }
        this.notifyState();
      },
      onClose: () => {
        this.sleep();
        this.notifyState();
      },
      onSpeechStarted: () => {
        this.intakeScheduler.cancelPending();
        if (!this.userSpeaking) {
          this.speechTurn++;
          this.speechAwaitingTranscript = true;
        }
        this.userSpeaking = true;
        this.userSpeechStartedAt = Date.now();
        if (!this.isReadoutSpeechActive()) {
          this.ttsSpeaking = false;
          this.clearPlaybackWatchdog();
        }
        this.proactivity.setUserSpeaking(true);
        this.proactivity.setTtsSpeaking(this.ttsSpeaking);
        this.callbacks.onSpeechStarted?.();
        this.notifyState();
      },
      onSpeechStopped: () => {
        this.userSpeaking = false;
        this.lastUserSpeechAt = Date.now();
        this.lastUserSpeechDurationMs = this.userSpeechStartedAt
          ? this.lastUserSpeechAt - this.userSpeechStartedAt
          : 0;
        this.proactivity.setUserSpeaking(false);
        this.callbacks.onSpeechStopped?.();
        this.notifyState();
      },
      onTranscript: (text, final) => this.handleTranscript(text, final),
      onAssistantText: (text, final) => {
        if (!this.awake || this.shouldSuppressReply()) {
          return;
        }
        if (text.trim()) {
          this.lastAssistantTextAt = Date.now();
          this.responseHadText = true;
          this.taskConversation.noteAssistantOutput();
          this.currentResponseText = final
            ? text
            : `${this.currentResponseText}${text}`;
          this.markUserResponseOutput();
        }
        if (final && text.trim()) {
          this.lastAssistantText = text;
        }
        this.guardCompletionClaim(text);
        this.callbacks.onAssistantText?.(text, final);
      },
      onSpeechText: (text, final) => {
        if (this.awake && !this.shouldSuppressReply()) {
          if (text.trim()) {
            this.responseHadSpeechOutput = true;
            this.taskConversation.noteAssistantOutput();
            this.markUserResponseOutput();
          }
          this.callbacks.onSpeechText?.(text, final);
        }
      },
      onToolCall: (call) => {
        void this.handleToolCall(call).catch((error: unknown) => {
          this.callbacks.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      },
      onAudio: (pcm16) => {
        this.responseHadAudio = true;
        this.taskConversation.noteAssistantOutput();
        this.markUserResponseOutput();
        this.lastAssistantAudioAt = Date.now();
        if (
          this.awake &&
          !this.suppressAudioUntilResponseDone &&
          !this.shouldSuppressReply()
        ) {
          this.callbacks.onAudio?.(pcm16);
        }
      },
      onResponseStarted: (info) => {
        if (info?.readoutId) this.protectGazeReadout();
        if (this.shouldSuppressReply()) {
          console.log('[cyrvis voice] suppressed reply after stop command');
          this.provider.cancelResponse();
          return;
        }
        this.assistantTextBuffer = '';
        this.completionGuardTriggered = false;
        this.suppressAudioUntilResponseDone = false;
        this.responseHadAudio = false;
        this.responseHadText = false;
        this.responseHadSpeechOutput = false;
        this.currentResponseText = '';
        this.taskConversation.noteAssistantOutput();
        this.clearPlaybackWatchdog();
        this.ttsSpeaking = true;
        this.proactivity.setTtsSpeaking(true);
        this.notifyState();
      },
      onResponseDone: () => {
        const textOnlyFallback =
          this.awake &&
          !this.suppressAudioUntilResponseDone &&
          !this.shouldSuppressReply() &&
          this.responseHadText &&
          !this.responseHadAudio &&
          !this.responseHadSpeechOutput;
        const fallbackText = this.currentResponseText.trim();
        const hadAudio = this.responseHadAudio;
        this.assistantTextBuffer = '';
        this.suppressAudioUntilResponseDone = false;
        this.completionGuardTriggered = false;
        this.responseHadAudio = false;
        this.responseHadText = false;
        this.responseHadSpeechOutput = false;
        this.currentResponseText = '';
        this.resetAwakeTimer();
        if (hadAudio) {
          // The server finished generating audio, but the renderer is still
          // playing the WAV queue. Keep ttsSpeaking=true so proactive lines
          // cannot start a second response and cut this one off.
          this.armPlaybackWatchdog();
        } else {
          this.ttsSpeaking = false;
          this.proactivity.setTtsSpeaking(false);
          this.clearPlaybackWatchdog();
        }
        this.notifyState();
        if (textOnlyFallback && fallbackText) {
          setTimeout(() => {
            if (!this.shouldSuppressReply()) {
              this.speak(fallbackText);
            }
          }, 50);
        }
      },
      onPlaybackIdle: () => {
        this.readoutGuardUntil = 0;
        this.clearPlaybackWatchdog();
        this.ttsSpeaking = false;
        this.proactivity.setTtsSpeaking(false);
        this.notifyState();
      },
      onError: (error) => {
        this.readoutGuardUntil = 0;
        this.notifyState();
        this.callbacks.onError?.(error);
        if (this.waitingForUserResponse && !this.userResponseOutputSeen) {
          this.markUserResponseOutput();
          this.speak('抱歉，刚才没有成功生成回复，请再说一遍。');
        }
      },
    };
  }

  private handleTranscript(text: string, final: boolean): boolean {
    if (final && !text.trim()) {
      // Buffer clear/trim acknowledgements can arrive while an earlier tool
      // result is being spoken. Silence is not an explicit user stop.
      return true;
    }
    this.callbacks.onTranscript?.(text, final);
    const workflowWaiting =
      this.options.getWorkflowStatus?.()?.status === 'waiting_confirmation';
    const deferStopToWorkflow =
      workflowWaiting || /工作流|多步骤任务/i.test(text);

    if (!final) {
      this.partialUserText += text;
      // "停一下" is short enough that the final transcript may arrive after
      // the GUI/coding task has already taken another action. Act on the
      // partial as soon as it is unambiguous. A pending sensitive-action
      // confirmation keeps "取消" for its own cancel path.
      if (
        this.isStopCommand(this.partialUserText) &&
        !deferStopToWorkflow &&
        this.options.fastToolRouter?.hasPendingConfirmation() !== true
      ) {
        this.partialUserText = '';
        this.handleStopCommand();
        return true;
      }
      if (!this.awake && this.isWakePhrase(this.partialUserText)) {
        this.wake();
      }
      return false;
    }

    this.partialUserText = '';

    if (!text.trim()) {
      // Empty finals are server-side VAD noise or a dropped short word. The
      // barge/KWS path already handles real stops; cancelling here cut every
      // ongoing answer after a few words. Only answer when local VAD proves the
      // user actually spoke and no assistant response is active.
      console.log('[cyrvis voice] empty transcript ignored', {
        sinceSpeechMs: this.lastUserSpeechAt
          ? Date.now() - this.lastUserSpeechAt
          : null,
        speechMs: this.lastUserSpeechDurationMs,
      });
      const now = Date.now();
      if (
        this.awake &&
        !this.ttsSpeaking &&
        this.lastUserSpeechDurationMs >= 700 &&
        now - this.lastAssistantAudioAt > 5_000 &&
        now - this.lastEmptyReplyAt > 10_000
      ) {
        this.lastEmptyReplyAt = now;
        this.speak('我没听清，请再说一遍。');
      }
      return true;
    }

    // ASR often truncates "停下" to "下" or "停" when the user talks over the
    // assistant. If a barge just paused a task and the final transcript is a
    // stop-word fragment, treat it as a hard stop instead of leaving a paused
    // GUI task behind.
    const bargeStopRecent =
      this.pendingBargeStopAt > 0 &&
      Date.now() - this.pendingBargeStopAt < 3_000;
    if (bargeStopRecent && this.isStopFragment(text)) {
      this.pendingBargeStopAt = 0;
      this.handleStopCommand();
      return true;
    }
    this.pendingBargeStopAt = 0;

    // A transcript that starts with a stop word is a stop, full stop.
    // The remainder may be the assistant's own TTS echo picked up by ASR
    // ("停一下，现在这样，打开B站…"), so it must never be re-routed as a new
    // command in the same turn. Ask the user to repeat a new command after the
    // stop if they actually want one.
    const leadingStop =
      /^(?:呃|啊|哦|嗯|唉|诶|好|ok)?[，,\s]*(?:马上|赶紧|赶快|立刻|立即|快点|快|现在就|现在|先|给我)?[，,\s]*(先停一下|先停|停一下|停一停|停下来|停下|停住|停止|停|别动|不要动|住手|别说了|不要说了|别念了|不要念了|闭嘴|安静|取消|算了|stop|cancel|abort)[，,\s]*(.*)$/i.exec(
        text,
      );
    if (
      leadingStop &&
      !deferStopToWorkflow &&
      this.options.fastToolRouter?.hasPendingConfirmation() !== true
    ) {
      this.handleStopCommand();
      return true;
    }
    if (
      this.isStopCommand(text) &&
      !deferStopToWorkflow &&
      this.options.fastToolRouter?.hasPendingConfirmation() !== true
    ) {
      this.handleStopCommand();
      return true;
    }

    // A real user turn after a stop re-opens task/coding speech. Do not wait
    // for the 3s anti-acknowledgment window to expire: a coding task may
    // finish long after that and its result must still be announced.
    this.userStopped = false;

    if (this.handleContinueCommand(text)) {
      return true;
    }

    const now = Date.now();
    const transcriptKey = normalizeTranscriptDedupeKey(text);
    if (
      transcriptKey &&
      transcriptKey === this.lastFinalTranscript &&
      now - this.lastFinalAt < 750
    ) {
      console.log('[cyrvis voice] duplicate transcript ignored');
      return true;
    }
    this.lastFinalTranscript = transcriptKey;
    this.lastFinalAt = now;
    this.navigationExecutions = new Set();
    // Keep main's concrete file requests in the file/tool router while the
    // gaze action implementation follows the user's selected 78c6d8ce version.
    const concreteFileRequest =
      !/(正在看|看着的|注视|眼神|光标|高亮)/i.test(text) &&
      /(最近|桌面上?|下载|文档|文件名|文件夹|路径|扩展名|\.[a-z0-9]{1,12}\b)/i.test(
        text,
      );
    const gazeAction =
      !concreteFileRequest &&
      !this.options.fastToolRouter?.hasPendingConfirmation() &&
      this.options.getGazeActionContext
        ? gazeDesktopAction(text)
        : null;
    // Snapshot the referent before clearing the spoken suggestion/cooldown.
    const desktopContext = gazeAction
      ? this.options.getGazeActionContext?.(text)
      : null;
    const desktopAction = gazeAction;

    const pendingConfirmation =
      this.options.fastToolRouter?.getPendingConfirmation();
    if (
      pendingConfirmation &&
      this.options.classifyPendingIntent &&
      this.options.fastToolRouter?.canHandle(text) !== true &&
      shouldClassifyPendingReply(text)
    ) {
      this.lastUserText = text;
      this.armUserResponseWatchdog();
      this.notifyState();
      this.handleSemanticPendingReply(text, pendingConfirmation);
      return true;
    }

    if (
      !this.options.fastToolRouter?.hasPendingConfirmation() &&
      !desktopAction &&
      this.isGazeFollowup(text) &&
      this.gazeSuggestion
    ) {
      const pending = this.gazeSuggestion.value;
      const action = resolveGazeReply(text, pending);
      if (action === 'clarify') {
        this.provider.cancelResponse();
        this.speakRequestedReply(
          `你想选择哪一项：${pending.actions.map((item) => item.label).join('，')}？`,
        );
      } else if (action) this.followGazeSuggestion(pending.id, action);
      return true;
    }

    if (this.gazeSuggestion) {
      this.clearGazeSuggestion();
      this.options.snoozeProactiveGaze?.();
    }
    const voiceIntent = classifyVoiceIntent(text);
    this.lastVoiceIntent = voiceIntent;
    const semanticMode =
      voiceIntent.mode === 'answer' ||
      voiceIntent.mode === 'search' ||
      voiceIntent.mode === 'compare' ||
      (voiceIntent.mode === 'navigate' && voiceIntent.targetKind === 'site');
    // The semantic layer owns answers, navigation, search and comparison. Do
    // not let the dynamic fast-tool router consume those turns.
    const canHandleFastTool =
      !semanticMode && this.options.fastToolRouter?.canHandle(text) === true;
    const explicitConfirmation =
      this.options.fastToolRouter?.isConfirmationIntent(text) === true;
    const workflowCancellation =
      workflowWaiting && /^(?:取消|不要|算了|否|no|cancel)$/i.test(text.trim());
    const actionableVoiceTurn =
      canHandleFastTool ||
      ['task', 'control'].includes(classifyIntent(text).kind) ||
      (['task', 'navigate', 'search', 'compare'].includes(voiceIntent.mode) &&
        voiceIntent.confidence === 'high');

    // A long verbatim repeat of the assistant's own recent reply is speaker
    // leakage even when its wording looks actionable ("需要继续完善这个
    // 任务吗？"). Without this, the brain treated its own question as a user
    // command and started a fresh coding task.
    if (!this.isStopCommand(text) && this.isStrongSelfEchoTranscript(text)) {
      console.log('[cyrvis voice] strong self-echo transcript ignored', text);
      this.callbacks.onSelfEcho?.();
      this.provider.cancelResponse();
      return true;
    }

    // Speaker mode: the mic can pick up the assistant's own voice. If ASR
    // returns a short echo of the last reply ("我在", "我来", "我"), do not
    // start another turn; otherwise the model answers itself forever.
    if (
      !canHandleFastTool &&
      !explicitConfirmation &&
      !actionableVoiceTurn &&
      !workflowCancellation &&
      this.isSelfEchoTranscript(text)
    ) {
      console.log('[cyrvis voice] self-echo transcript ignored', text);
      this.callbacks.onSelfEcho?.();
      this.provider.cancelResponse();
      return true;
    }

    this.lastUserText = text;
    // Realtime tools can precede the final ASR event for the same speech.
    // Keep that turn's generation instead of invalidating its pending result.
    const joinsEarlyGazeTool =
      this.speechAwaitingTranscript &&
      this.gazeToolTurn?.awaitingTranscript &&
      this.gazeToolTurn.speechTurn === this.speechTurn;
    if (joinsEarlyGazeTool) this.gazeToolTurn!.awaitingTranscript = false;
    else this.inspectionGeneration++;
    this.speechAwaitingTranscript = false;
    const inspectionGeneration = this.inspectionGeneration;
    if (voiceIntent.mode !== 'chat') {
      console.log(
        '[cyrvis intent]',
        JSON.stringify({
          mode: voiceIntent.mode,
          query: voiceIntent.query,
          target: voiceIntent.target,
          targetKind: voiceIntent.targetKind,
          silent: voiceIntent.silent,
          siteSearch: voiceIntent.siteSearch === true,
          confidence: voiceIntent.confidence,
          reason: voiceIntent.reason,
        }),
      );
    }

    if (!canHandleFastTool) {
      this.deterministicFastToolGuardUntil = 0;
      this.fastToolGuardUntil = 0;
    }

    // After a stop, a real new command should not be delayed by the 3s
    // anti-acknowledgment window. Numeric/short fragments are usually TTS
    // echo or noise, so they do not clear it.
    if (this.shouldSuppressReply()) {
      const trimmed = text.trim();
      if (
        canHandleFastTool ||
        (trimmed.length >= 3 && !/^\d+$/.test(trimmed))
      ) {
        this.suppressReplyUntil = 0;
        this.stopToolGuardUntil = 0;
        this.userStopped = false;
        console.log('[cyrvis voice] new command after stop; allowing reply');
      }
    }

    const bareStop =
      /^(停|停下|停止|暂停|停一下|停一停|先停|先停一下|别说了|不要说了|stop|cancel)[。！!，,\s]*$/i.test(
        text.trim(),
      );

    if (!this.awake) {
      const decision = classifyIntent(text);
      const autoWake =
        this.options.autoWakeOnTask !== false &&
        (decision.kind === 'task' ||
          decision.kind === 'control' ||
          canHandleFastTool ||
          !!desktopAction ||
          (!!this.options.inspectGaze && isGazeQuestion(text)) ||
          ((voiceIntent.mode === 'search' ||
            voiceIntent.mode === 'compare' ||
            voiceIntent.mode === 'answer') &&
            voiceIntent.confidence === 'high'));
      if (this.isWakePhrase(text) || autoWake) {
        this.wake();
      } else {
        // The model may already be answering background speech. Suppress it.
        console.log('[cyrvis voice] asleep; transcript ignored', text);
        this.provider.cancelResponse();
        return true;
      }
      this.notifyState();
    }

    if (desktopAction) {
      this.routeGazeDesktopAction(text, desktopAction, desktopContext || null);
      return true;
    }
    this.gazeActionHandledUntil = 0;

    if (this.gazeToolTurn?.generation === inspectionGeneration) {
      this.markUserResponseOutput();
      this.resetAwakeTimer();
      this.notifyState();
      return true;
    }

    if (!bareStop) {
      this.armUserResponseWatchdog();
    }

    // Consume gaze questions before fast tools. Cascade must skip its own
    // LLM turn when this handler returns true.
    if (this.options.inspectGaze && isGazeQuestion(text)) {
      this.provider.cancelResponse();
      this.markUserResponseOutput();
      const request = {
        generation: inspectionGeneration,
        toolReply: false,
        answered: false,
      };
      this.deterministicInspection = request;
      void this.inspectGaze(text).then(
        (answer) => {
          if (
            this.awake &&
            inspectionGeneration === this.inspectionGeneration &&
            !request.toolReply
          ) {
            request.answered = true;
            this.speakRequestedReply(
              answer,
              this.options.getGazeInspectionId?.(),
            );
          }
        },
        (error) => {
          if (
            this.awake &&
            inspectionGeneration === this.inspectionGeneration &&
            !request.toolReply
          ) {
            request.answered = true;
            this.speak(
              error instanceof Error ? error.message : '看屏识别失败，请重试。',
            );
          }
        },
      );
      this.resetAwakeTimer();
      this.notifyState();
      return true;
    }

    const isStatusQuery = this.isTaskStatusQuery(text);
    if (!bareStop && !isStatusQuery) {
      this.lastActionableUserText = text;
    }

    if (workflowCancellation && this.options.cancelWorkflow) {
      this.provider.cancelResponse();
      void this.options
        .cancelWorkflow()
        .then((cancelled) => {
          this.speak(cancelled ? '已取消工作流。' : '当前没有可取消的工作流。');
        })
        .catch((error: unknown) => {
          this.speak(
            `取消工作流失败：${error instanceof Error ? error.message : String(error)}`,
          );
        });
      return true;
    }

    if (
      /(?:取消|停止|终止).{0,8}(?:工作流|多步骤任务)|(?:工作流|多步骤任务).{0,8}(?:取消|停止)/i.test(
        text,
      ) &&
      this.options.cancelWorkflow
    ) {
      this.provider.cancelResponse();
      void this.options
        .cancelWorkflow()
        .then((cancelled) => {
          this.speak(cancelled ? '已取消工作流。' : '当前没有可取消的工作流。');
        })
        .catch((error: unknown) => {
          this.speak(
            `取消工作流失败：${error instanceof Error ? error.message : String(error)}`,
          );
        });
      return true;
    }

    if (isStatusQuery && this.handleTaskStatusQuery(text)) {
      return true;
    }

    this.rememberTravelSelection(text);
    if (this.handleTravelFlightCommand(text)) {
      return true;
    }

    // Code-file creation/execution is deterministic enough to route before
    // the model can mistake it for a Notepad/desktop task.
    if (this.handleCodingCommand(text)) {
      return true;
    }

    // A deterministic fast command owns this turn before the broader GUI
    // control/verb heuristics run.
    if (canHandleFastTool && this.handleFastToolCommand(text)) {
      return true;
    }

    // Safety-critical: stop/pause must act even if the voice model forgets to
    // call the tool (observed in real testing: it said "paused" but the GUI
    // agent kept running).
    this.handleDeterministicControl(text);
    if (bareStop) {
      // A bare stop should end playback, not trigger "好的，已暂停…" audio.
      this.markUserStop();
      this.provider.cancelResponse();
    }

    this.resetAwakeTimer();
    this.notifyState();
    return Boolean(bareStop);
  }

  private routeGazeDesktopAction(
    text: string,
    action: GazeDesktopAction,
    context: GazeActionContext | null,
  ): boolean {
    this.provider.cancelResponse();
    this.markUserResponseOutput();
    this.inspectionGeneration++;
    this.gazeActionHandledUntil = Date.now() + 8000;
    this.options.snoozeProactiveGaze?.();
    this.gazeSuggestion = null;
    this.lastActionableUserText = text;
    this.userStopped = false;
    this.suppressReplyUntil = 0;
    this.wake();
    if (
      !context ||
      Date.now() - context.observedAt > 60_000 ||
      !context.gaze.target
    ) {
      this.speak('请先看向要操作的对象，等绿框锁定，或者直接说出目标名称。');
      return false;
    }
    if (this.controller.isBusy()) {
      this.speak('桌面任务正在执行。请先停止当前任务，再操作这个对象。');
      return false;
    }
    if (this.options.codingAgent?.isBusy()) {
      this.speak('编码任务正在执行。请先停止当前任务，再操作这个对象。');
      return false;
    }
    try {
      this.controller.startTask(
        gazeDesktopInstruction(text, action, context),
        'voice',
      );
      this.speak(
        action === 'click'
          ? '好，正在操作你选中的对象。'
          : '好，正在执行选定对象的操作，完成后告诉你。',
      );
      return true;
    } catch (error) {
      this.speak(
        error instanceof Error
          ? `桌面任务未启动：${error.message}`
          : '桌面任务未启动，请重试。',
      );
      return false;
    }
  }

  private handleTaskStatusQuery(text: string): boolean {
    if (!this.isTaskStatusQuery(text)) {
      return false;
    }
    const workflow = this.options.getWorkflowStatus?.();
    if (workflow) {
      this.provider.cancelResponse();
      const progress = `${workflow.completedSteps}/${workflow.totalSteps}`;
      this.speak(
        `工作流 ${workflow.name} 状态：${workflow.status}，已完成 ${progress} 步${workflow.currentStepId ? `，当前步骤 ${workflow.currentStepId}` : ''}。`,
      );
      return true;
    }
    const coding = this.options.codingAgent?.getStatus();
    const codingIsRecent =
      coding &&
      coding.status !== 'idle' &&
      (coding.status === 'running' ||
        Date.now() - (coding.endedAt ?? 0) < 120_000);
    // The model may already be answering the audio input. A deterministic
    // status reply owns this turn; cancel the in-flight reply so it cannot
    // race with a duplicate create_text_file / GUI tool call.
    this.provider.cancelResponse();
    if (coding && codingIsRecent) {
      if (coding.status === 'running') {
        this.speak(
          `编码任务正在执行，最后状态：${coding.lastMessage || '处理中'}。`,
        );
      } else if (coding.status === 'done') {
        const summary = this.summarizeCodingResult(coding.result);
        this.speakCodingSummary(
          summary ? `编码任务已完成。总结：${summary}` : '编码任务已完成。',
        );
      } else if (coding.status === 'failed') {
        this.speak(`编码任务失败：${coding.error || '未知错误'}`);
      } else {
        this.speak('编码任务已取消。');
      }
      return true;
    }
    this.speak(this.taskConversation.describeStatus());
    return true;
  }

  /**
   * Capture “就三亚吧” when the assistant just listed that city. The model can
   * still call travel_update_plan; this only preserves context for a following
   * “去这/买机票” turn if the tool call is missed.
   */
  private rememberTravelSelection(text: string): void {
    if (this.intakeEngine.getSession()) return;
    const match = text
      .trim()
      .match(/^(?:就|选|要|定)([一-龥]{2,8}?)(?:吧|了|呀)?$/);
    if (!match?.[1] || !this.lastAssistantText.includes(match[1])) return;
    travelPlanner.updateFramework({
      destination: match[1],
      userText: text,
    });
  }

  private handleTravelFlightCommand(text: string): boolean {
    const active = this.intakeEngine.getSession();
    if (active?.domain === TRAVEL_FLIGHT_DOMAIN) {
      this.intakeScheduler.cancelPending();
      const turn = this.intakeEngine.updateFromText(text);
      if (turn && turn.filled.length > 0) {
        if (turn.ready) {
          // Do not cancel the model's acknowledgement here. Canceling it and
          // then sending the comparison as a proactive line made the model
          // answer the stale slot turn instead of reading the comparison, so
          // the browser opened without the price summary being spoken.
          // Let the acknowledgement finish; the comparison is queued behind it.
          void this.completeTravelFlight();
          return true;
        }
        if (turn.question) {
          this.speakExact(`收到。${turn.question}`);
          if (turn.nextSlot) {
            this.scheduleIntakeReminder(turn.session, turn.nextSlot);
          }
          return true;
        }
      }

      const current = this.intakeEngine.getCurrentSlot();
      const newCommand =
        /(打开|搜索|播放|写|代码|编码|任务|文件|天气|新闻|介绍|讲个|聊|暂停|继续)/.test(
          text,
        );
      if (newCommand || text.trim().length > 18) {
        this.provider.cancelResponse();
        this.clearTravelFlightIntake();
        return false;
      }
      if (current) {
        this.speakExact(`还在等你补充${current.label}。${current.question}`);
        this.scheduleIntakeReminder(active, current);
        return true;
      }
      return false;
    }

    const framework = travelPlanner.getSnapshot().framework;
    // Follow-ups like "有做好比价吗" or "直接告诉我机票" do not contain the
    // full buy/check phrase, but once a route is known they must still enter
    // the deterministic flight comparison instead of the highlights probe.
    const flightFollowUp =
      Boolean(framework.origin && framework.destination) &&
      /(?:机票|航班|飞机票|比价)/.test(text);
    if (!isTravelFlightIntent(text) && !flightFollowUp) {
      return false;
    }
    this.flightComparisonActiveUntil = Date.now() + 120_000;
    this.provider.cancelResponse();

    const destination = parseTravelDestination(text) || framework.destination;
    const origin = parseTravelOrigin(text) || framework.origin;
    // The planner already has what the user said earlier (e.g. "从北京",
    // "23号"). Reuse it instead of asking the same question again; a bare
    // day such as "23号" is resolved against the current month.
    const departDate =
      parseTravelDate(text) ||
      (framework.startDate ? parseTravelDate(framework.startDate) : undefined);
    const durationDays = parseTravelDurationDays(text);
    if (
      departDate &&
      !/20\d{2}/.test(text) &&
      Math.abs(new Date(`${departDate}T00:00:00`).getTime() - Date.now()) >
        300 * 24 * 60 * 60 * 1000
    ) {
      const spokenDate = departDate.replace(
        /^(\d{4})-(\d{2})-(\d{2})$/,
        '$1年$2月$3日',
      );
      this.provider.cancelResponse();
      this.speakExact(
        `日期我听到的是 ${spokenDate}，离现在比较远。能再说一遍具体日期吗？`,
      );
      return true;
    }
    if (destination || origin || departDate) {
      travelPlanner.updateFramework({
        destination,
        origin,
        startDate: departDate,
        transport: '机票',
        userText: text,
      });
    }

    this.intakeEngine.start(TRAVEL_FLIGHT_DOMAIN, text, TRAVEL_FLIGHT_SLOTS, {
      destination,
      origin,
      departDate,
      durationDays,
    });
    const session = this.intakeEngine.getSession();
    if (!session) return false;
    if (session.status === 'ready') {
      void this.completeTravelFlight();
      return true;
    }
    const next = this.intakeEngine.next();
    if (!next) {
      this.clearTravelFlightIntake();
      return false;
    }
    this.speakExact(`好的，我来帮你比机票。${next.question}`);
    this.scheduleIntakeReminder(session, next.slot);
    return true;
  }

  private scheduleIntakeReminder(
    session: IntakeSession,
    slot: IntakeSlotSpec,
  ): void {
    const sessionId = session.id;
    this.intakeScheduler.schedule(
      slot.key,
      () => {
        const current = this.intakeEngine.getSession();
        if (!current || current.id !== sessionId) return;
        if (this.userStopped || !this.awake || this.userSpeaking) return;
        this.speakExact(`还在等你补充${slot.label}。${slot.question}`);
      },
      () => {
        const current = this.intakeEngine.getSession();
        return (
          !!current &&
          current.id === sessionId &&
          current.status === 'collecting' &&
          this.awake &&
          !this.userSpeaking &&
          !this.ttsSpeaking
        );
      },
    );
  }

  private clearTravelFlightIntake(): void {
    this.intakeScheduler.cancelAll();
    this.intakeEngine.cancel();
    this.travelFlightCompleting = false;
    this.flightComparisonActiveUntil = 0;
  }

  private async completeTravelFlight(): Promise<void> {
    if (this.travelFlightCompleting) return;
    const session = this.intakeEngine.getSession();
    if (!session || session.domain !== TRAVEL_FLIGHT_DOMAIN) return;
    const origin = String(session.answers.origin || '').trim();
    const destination = String(session.answers.destination || '').trim();
    const departDate = String(session.answers.departDate || '').trim();
    const durationDays = Number(session.answers.durationDays) || undefined;
    if (!origin || !destination || !departDate) {
      const next = this.intakeEngine.next();
      if (next) {
        this.speakExact(next.question);
        this.scheduleIntakeReminder(session, next.slot);
      }
      return;
    }

    this.travelFlightCompleting = true;
    try {
      // Finish the intake before the network search: a slow provider must not
      // keep the slot session open or let a new utterance mutate its answers.
      this.intakeScheduler.cancelAll();
      this.intakeEngine.complete();
      const input: FlightSearchInput = {
        origin,
        destination,
        departDate,
        durationDays,
        passengers: 1,
      };
      const useLive =
        this.options.useLiveFlights ??
        process.env.CYRVIS_FLIGHT_PROVIDER !== 'demo';
      let comparison: FlightComparison | null = null;

      if (useLive) {
        this.speak('好的，我查一下实时航班，请稍等。');
        const useOta =
          (this.options.useOtaFlights ?? true) && !input.durationDays;
        const [googleOutcome, otaOutcome] = await Promise.allSettled([
          (this.options.flightSearch ?? searchLiveFlights)(input),
          useOta
            ? (this.options.otaSearch ?? searchOtaFlights)(input)
            : Promise.resolve(null),
        ]);
        let google: LiveFlightSearchResult | null = null;
        let ota: OtaFlightSearchResult | null = null;
        if (googleOutcome.status === 'fulfilled') {
          google = googleOutcome.value;
        } else {
          console.warn('[cyrvis travel] Google Flights search failed', {
            error:
              googleOutcome.reason instanceof Error
                ? googleOutcome.reason.message
                : String(googleOutcome.reason),
          });
        }
        if (otaOutcome.status === 'fulfilled') {
          ota = otaOutcome.value;
          if (ota) {
            console.info('[cyrvis travel] OTA search', {
              ctrip: ota.sources.ctrip,
              trip: ota.sources.trip,
            });
          }
        } else {
          console.warn('[cyrvis travel] OTA search failed', {
            error:
              otaOutcome.reason instanceof Error
                ? otaOutcome.reason.message
                : String(otaOutcome.reason),
          });
        }
        const offers = [...(google?.offers ?? []), ...(ota?.offers ?? [])];
        if (offers.length) {
          comparison = compareLiveFlights(input, offers, google?.searchUrl);
        }
      } else {
        comparison = compareFlights(input);
      }

      if (!comparison) {
        // Never fall back to fake prices when the user asked for real fares.
        let fallbackUrl = 'https://www.google.com/travel/flights';
        try {
          fallbackUrl = buildGoogleFlightsUrl(input);
        } catch {
          // Keep the generic Google Flights landing page.
        }
        // Open immediately: the user should see the live page as soon as the
        // real-data attempt fails, not after the failure speech finishes.
        void this.openTravelBooking(fallbackUrl);
        const spokenDate = departDate.replace(
          /^(\d{4})-(\d{2})-(\d{2})$/,
          '$1年$2月$3日',
        );
        const speech = `没有查到 ${origin} 到 ${destination} ${spokenDate} 的实时航班，我先打开 Google Flights 搜索页，你可以在页面上看实时价格。`;
        this.taskSpeechGuardUntil = Date.now() + 8_000;
        this.speakExact(speech);
        return;
      }

      const speech =
        comparison.source === 'google_flights'
          ? formatLiveFlightComparison(comparison)
          : formatFlightComparison(comparison);
      this.taskSpeechGuardUntil =
        Date.now() + Math.min(15_000, Math.max(3_000, speech.length * 180));
      const best = comparison.best;
      const url = best?.url || comparison.searchUrl;
      // Open the source immediately, before the summary. For OTA winners also
      // launch the persistent-profile helper that clicks the exact flight and
      // leaves Chrome on its fare/checkout page.
      if (url) {
        void this.openTravelBooking(url);
      }
      const otaSource = best?.metadata?.source;
      if (otaSource === 'ctrip' || otaSource === 'trip') {
        focusOtaOffer({
          source: otaSource,
          origin,
          destination,
          date: departDate,
          flightNo:
            typeof best?.metadata?.flightNo === 'string'
              ? best.metadata.flightNo
              : undefined,
          airline: best?.provider,
          price: best?.totalPrice,
        });
      }
      this.speakExact(speech);
    } finally {
      this.travelFlightCompleting = false;
      this.flightComparisonActiveUntil = 0;
    }
  }

  private async openTravelBooking(url: string): Promise<void> {
    try {
      if (this.options.openExternal) {
        await this.options.openExternal(url);
        return;
      }
      const { openUrl } = await import('./desktop-actions');
      await openUrl(url);
    } catch (error) {
      this.callbacks.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private handleCodingCommand(text: string): boolean {
    const codingAgent = this.options.codingAgent;
    if (!codingAgent) {
      return false;
    }

    const hasCodeFile =
      /\.(?:js|mjs|cjs|ts|tsx|jsx|py|java|cpp|c|go|rs|rb|php|sh|ps1)\b|(?:python|py|javascript|js|typescript|ts|java|c\+\+|cpp|go|rust|ruby|php|shell|bash|powershell|ps1)\s*(?:文件|脚本|程序)/i.test(
        text,
      );
    const hasCodeVerb =
      /(创建|新建|建|写|生成|实现|修复|改|重构|添加|加|运行|执行|跑|测试|test|run|execute)/i.test(
        text,
      );
    const hasWriteCodeVerb =
      /(创建|新建|建|写|生成|实现|修复|改|重构|添加|加|测试|test)/i.test(text);
    const hasRepoContext =
      /(项目|仓库|代码|工作区|workspace|demo|coding)/i.test(text);
    const hasStrongCodeTerm =
      /(代码|脚本|程序|算法|函数|接口|组件|排序|查找|遍历|递归|链表|二叉树|动态规划|dfs|bfs|bug|测试|运行|执行|仓库|workspace|coding|修复)/i.test(
        text,
      );
    if (
      !(hasCodeFile && hasCodeVerb) &&
      !(hasRepoContext && hasStrongCodeTerm) &&
      !(hasStrongCodeTerm && hasWriteCodeVerb)
    ) {
      return false;
    }

    if (this.controller.isBusy()) {
      this.speak('当前有一个 GUI 任务在运行，先完成后我再开始编码任务。');
      return true;
    }
    if (codingAgent.isBusy()) {
      this.speak('编码任务已经在运行了，请稍等。');
      return true;
    }

    this.provider.cancelResponse();
    this.resetAwakeTimer();
    this.codingToolGuardUntil = Date.now() + 180_000;
    this.lastCodingProgressAt = 0;
    this.lastCodingProgressMessage = '';
    this.codingFileNames = new Set(
      (
        text.match(
          /[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|java|cpp|c|go|rs|rb|php|sh|ps1)\b/gi,
        ) || []
      ).map((name) => path.basename(name).toLowerCase()),
    );
    void codingAgent
      .start(text)
      .then((task) => {
        if (task.status === 'running') {
          this.speak('好的，编码任务已启动，我会在完成后汇报结果。');
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(message),
        );
        this.speak(`编码任务启动失败：${message}`);
      });
    return true;
  }

  private isTaskStatusQuery(text: string): boolean {
    return /(?:任务|工作流).*(?:进度|状态|到哪|第几步)|(?:进度|第几步|执行到哪|做到哪|进行.{0,3}哪一步|现在在做什么)|(?:任务|工作流|你).*怎么样了|(?:开始|做完|完成|执行完|跑完|弄完|创建完).{0,3}(?:了)?(?:吗|没|没有)|(?:还在|仍在).{0,4}(?:做|执行|运行|处理)/i.test(
      text,
    );
  }

  private resolveSiteTarget(value: string, query?: string) {
    const site = resolveSite(value);
    if (!site) throw new Error('Unknown site: ' + value);
    return {
      label: site.label,
      url: query ? buildSiteSearchUrl(site, query) : site.url,
    };
  }

  private async executeNavigation(
    call: VoiceToolCallWithId,
    tool: string,
    args: Record<string, unknown>,
    fallback: () => Promise<void>,
  ): Promise<boolean> {
    const executions = this.navigationExecutions;
    const key = JSON.stringify([tool, args]);
    if (executions.has(key)) {
      this.provider.sendToolResult(
        call.callId,
        'ALREADY_HANDLED_BY_FAST_TOOL: this navigation was already requested in this turn.',
      );
      return false;
    }
    executions.add(key);
    try {
      const completed = await this.runNavigation(call, tool, args, fallback);
      if (!completed) executions.delete(key);
      return completed;
    } catch (error) {
      executions.delete(key);
      throw error;
    }
  }

  private async runNavigation(
    call: VoiceToolCallWithId,
    tool: string,
    args: Record<string, unknown>,
    fallback: () => Promise<void>,
  ): Promise<boolean> {
    const router = this.options.fastToolRouter;
    if (!router) {
      await fallback();
      return true;
    }
    if (router.hasPendingConfirmation()) {
      this.provider.cancelResponse();
      return false;
    }
    const execution = await router.executeNavigationTool(tool, args);
    const outcome = execution?.outcome;
    if (outcome?.result?.error?.code === 'CONFIRMATION_REQUIRED') {
      this.provider.cancelResponse();
      this.speak(outcome.speech || SENSITIVE_CONFIRMATION_PROMPT);
      return false;
    }
    if (!outcome?.ok) {
      this.provider.sendToolResult(
        call.callId,
        JSON.stringify({
          ok: false,
          status: 'failed',
          error: outcome?.result?.error,
          message: outcome?.speech || 'Navigation tool unavailable',
        }),
      );
      return false;
    }
    return true;
  }

  private async finishFastOpen(
    call: VoiceToolCallWithId,
    target: string,
    taskInstruction: unknown,
    delayMs: number,
    silent = false,
  ): Promise<void> {
    const instruction =
      typeof taskInstruction === 'string' ? taskInstruction.trim() : '';
    if (!instruction || isExplicitChat(instruction)) {
      this.provider.sendToolResult(
        call.callId,
        JSON.stringify({
          ok: true,
          status: 'opened',
          target,
          message: silent
            ? 'OPENED. The user asked to browse without a summary. Do NOT read, summarize, or describe results. Do not claim what is on the page; wait for the user.'
            : 'OPENED. The target is opening/loading. If the user asked you to read, compare, or click results, call start_gui_task with a concrete instruction. Do not claim results yet.',
        }),
      );
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const task = this.controller.startTask(instruction, 'voice');
      this.provider.sendToolResult(
        call.callId,
        JSON.stringify({
          ok: true,
          status: 'started',
          target,
          task_id: task.taskId,
          message:
            'TASK_STARTED. The GUI agent is working on the opened target. Do NOT claim completion; wait for task_done/task_failed.',
        }),
      );
    } catch (error) {
      if (error instanceof TaskBusyError) {
        this.provider.sendToolResult(
          call.callId,
          'TASK_BUSY: a GUI task is already running. Ask the user whether to cancel it before starting a new one.',
        );
        return;
      }
      this.provider.sendToolResult(
        call.callId,
        `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleToolCall(call: VoiceToolCallWithId): Promise<void> {
    if (!this.awake) {
      this.provider.sendToolResult(
        call.callId,
        'REJECTED: the assistant is asleep. Do not execute anything.',
      );
      return;
    }

    this.resetAwakeTimer();
    // A barge "停一下" often arrives just before the model's already-planned
    // open_site/start_gui_task call. Do not let that queued call start a new
    // task after the user asked to stop.
    if (
      Date.now() < this.stopToolGuardUntil &&
      !/^(?:get_|cancel_|pause_|stop_)/.test(call.name)
    ) {
      this.provider.sendToolResult(
        call.callId,
        JSON.stringify({
          ok: false,
          status: 'stopped',
          message:
            'STOPPED: the user asked to stop. Do not start or continue any task or tool action.',
        }),
      );
      console.log('[cyrvis voice] tool call blocked by stop guard', {
        tool: call.name,
      });
      return;
    }
    if (
      Date.now() < this.gazeActionHandledUntil &&
      ['start_gui_task', 'inspect_gaze_target'].includes(call.name)
    ) {
      this.provider.sendToolResult(
        call.callId,
        this.controller.isBusy()
          ? 'ALREADY_ROUTED_TO_GUI: 用户确认的注视对象操作已经交给桌面 Agent，等待执行结果，不要重复启动或声称无法操作。'
          : 'GAZE_ACTION_HANDLED: 该轮已由确定性路径处理，请等待用户明确目标。',
      );
      return;
    }
    const localFastTool = this.options.fastToolRouter?.resolveProviderToolName(
      call.name,
    );
    const effectiveTool =
      localFastTool === 'capability.invoke'
        ? String((call.args as Record<string, unknown>).toolId || '')
        : localFastTool;
    const navigationCall = [
      'search_web',
      'open_url',
      'open_app',
      'open_site',
    ].includes(call.name);
    // While the coding worker owns the workspace, the voice model must not
    // race it with a duplicate create_text_file / GUI launch. This was
    // observed when the user asked "你开始做了吗？" mid-task: the model wrote
    // 桌面/hello.js while the worker was already writing CYRVIS-demo/hello.js.
    const codingControlCall =
      call.name === 'get_coding_status' || call.name === 'cancel_coding_task';
    const requestedCodingFile =
      call.name === 'create_text_file'
        ? path.basename(String(call.args.path || '')).toLowerCase()
        : '';
    const duplicateCodingFile =
      Date.now() < this.codingToolGuardUntil &&
      Boolean(requestedCodingFile) &&
      this.codingFileNames.has(requestedCodingFile);
    if (
      (this.options.codingAgent?.isBusy() || duplicateCodingFile) &&
      !codingControlCall &&
      (localFastTool ||
        navigationCall ||
        call.name === 'create_text_file' ||
        call.name === 'start_gui_task' ||
        call.name === 'start_coding_task')
    ) {
      this.provider.sendToolResult(
        call.callId,
        JSON.stringify({
          ok: false,
          status: duplicateCodingFile
            ? 'coding_file_already_handled'
            : 'coding_task_running',
          message: duplicateCodingFile
            ? 'CODING_FILE_ALREADY_HANDLED: the coding worker is creating this file. Do not create or overwrite it from the voice tool. Report the coding task status instead.'
            : 'CODING_TASK_RUNNING: the coding worker owns this workspace. Do not create files, run commands, or start another task. Tell the user it is still running; use get_coding_status for progress.',
        }),
      );
      return;
    }
    if (
      Date.now() < this.deterministicFastToolGuardUntil &&
      (localFastTool || navigationCall || call.name === 'start_gui_task')
    ) {
      this.provider.sendToolResult(
        call.callId,
        'ALREADY_HANDLED_BY_FAST_TOOL: the deterministic local route already handled this turn. Do not execute it again.',
      );
      return;
    }
    if (
      Date.now() >= this.deterministicFastToolGuardUntil &&
      ((effectiveTool && NAVIGATION_TOOL_ALIASES[effectiveTool]) ||
        navigationCall)
    ) {
      const mode = this.lastVoiceIntent?.mode;
      if (mode === 'answer') {
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({
            ok: false,
            status: 'answer_from_knowledge',
            message:
              `ANSWER_FROM_KNOWLEDGE: "${this.lastUserText}" is stable knowledge. ` +
              'Answer from your internal knowledge; do not use a web or app fast tool.',
          }),
        );
        return;
      }
      if (mode === 'search' && localFastTool) {
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({
            ok: false,
            status: 'use_search_tool',
            query: this.lastVoiceIntent?.query,
            message: `USE_SEARCH_WEB: call search_web with query "${this.lastVoiceIntent?.query}" instead of cyrvis web tools.`,
          }),
        );
        return;
      }
      if (mode === 'navigate' && localFastTool) {
        const target = this.lastVoiceIntent?.target;
        const isApp = this.lastVoiceIntent?.targetKind === 'app';
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({
            ok: false,
            status: isApp ? 'use_open_app' : 'use_open_site',
            target,
            message: isApp
              ? `USE_OPEN_APP: call open_app with app "${target}" instead of a cyrvis app tool.`
              : `USE_OPEN_SITE: call open_site with site "${target ?? 'bing'}" instead of a cyrvis web tool.`,
          }),
        );
        return;
      }
    }
    if (localFastTool) {
      if (this.options.fastToolRouter?.hasPendingConfirmation()) {
        this.provider.cancelResponse();
        console.info('[cyrvis fast-tools] ignored tool call while confirming', {
          providerTool: call.name,
          tool: localFastTool,
        });
        return;
      }
      const canonical = effectiveTool && NAVIGATION_TOOL_ALIASES[effectiveTool];
      if (canonical) {
        const args =
          localFastTool === 'capability.invoke'
            ? (call.args as Record<string, unknown>).arguments
            : call.args;
        const input =
          args && typeof args === 'object' && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
        await this.handleToolCall({
          ...call,
          name: canonical,
          args: {
            ...input,
            ...(canonical === 'open_app' ? { app: input.name } : {}),
          },
        } as VoiceToolCallWithId);
        return;
      }
      await this.handleFastProviderToolCall(call, localFastTool);
      return;
    }

    switch (call.name) {
      case 'inspect_gaze_target': {
        const generation = this.inspectionGeneration;
        const deterministic =
          this.deterministicInspection?.generation === generation
            ? this.deterministicInspection
            : null;
        // Join an in-flight local request, instead of taking a second screenshot.
        // Once spoken, cancel a late duplicate response so the mic is not left muted.
        if (deterministic?.answered || deterministic?.toolReply) {
          this.provider.cancelResponse();
          return;
        }
        if (deterministic) deterministic.toolReply = true;
        const turn = {
          generation,
          speechTurn: this.speechTurn,
          awaitingTranscript: this.speechAwaitingTranscript,
        };
        this.gazeToolTurn = turn;
        this.markUserResponseOutput();
        try {
          const answer = await (deterministic && this.lastInspection
            ? this.lastInspection.result
            : this.inspectGaze(
                call.args.question || this.lastUserText || '我在看什么？',
              ));
          if (this.awake && generation === this.inspectionGeneration) {
            this.protectGazeReadout();
            const readoutId = this.options.getGazeInspectionId?.();
            if (readoutId) this.rememberGazeContext(readoutId, answer);
            this.provider.sendToolResult(
              call.callId,
              JSON.stringify({ ok: true, answer, read_only: true }),
              this.options.getGazeInspectionId?.(),
            );
          }
        } catch (error) {
          if (this.awake && generation === this.inspectionGeneration)
            this.provider.sendToolResult(
              call.callId,
              JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : '看屏识别失败',
              }),
            );
        } finally {
          if (this.gazeToolTurn === turn) this.gazeToolTurn = null;
          this.resetAwakeTimer();
        }
        break;
      }
      case 'start_gui_task': {
        if (this.options.codingAgent?.isBusy()) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'busy',
              message:
                'A coding task is already running. Cancel it before starting a GUI task.',
            }),
          );
          return;
        }
        // Semantic intents own the turn before the dynamic web.search shortcut.
        const earlyInstruction = call.args.instruction?.trim() || '';
        const earlyIntent = this.lastVoiceIntent;
        const earlyNeedsGui = GUI_INTERACTION_PATTERNS.some((pattern) =>
          pattern.test(earlyInstruction),
        );
        if (earlyIntent?.mode === 'navigate' && !earlyNeedsGui) {
          const target = earlyIntent.target;
          const isApp = earlyIntent.targetKind === 'app';
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: isApp ? 'use_open_app' : 'use_open_site',
              target,
              message: isApp
                ? `USE_OPEN_APP: "${this.lastUserText}" is app navigation, not a GUI task. Call open_app with app "${target}".`
                : `USE_OPEN_SITE: "${this.lastUserText}" is site navigation, not a GUI task. Call open_site with site "${target ?? 'bing'}".`,
            }),
          );
          return;
        }
        if (
          earlyIntent?.mode === 'search' &&
          earlyIntent.confidence === 'high' &&
          !earlyNeedsGui
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'use_search_tool',
              query: earlyIntent.query,
              message:
                `USE_SEARCH_WEB: "${this.lastUserText}" is a web information need, not a GUI automation task. ` +
                `Call search_web with query "${earlyIntent.query}" instead. ` +
                'If the user also wants to read/compare/click the results, pass a task_instruction to search_web.',
            }),
          );
          return;
        }
        if (earlyIntent?.mode === 'answer') {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'answer_from_knowledge',
              message:
                `ANSWER_FROM_KNOWLEDGE: "${this.lastUserText}" is stable knowledge. ` +
                'Answer from your internal knowledge; do not start a GUI task or search.',
            }),
          );
          return;
        }

        const searchQuery = extractBrowserSearchQuery(
          call.args.instruction || '',
        );
        if (searchQuery && this.options.fastToolRouter) {
          await this.handleToolCall({
            ...call,
            name: 'search_web',
            args: { query: searchQuery },
          });
          return;
        }
        if (Date.now() < this.fastToolGuardUntil) {
          this.provider.sendToolResult(
            call.callId,
            'ALREADY_HANDLED_BY_FAST_TOOL: the local fast-tool matrix handled the user command. Do not start a GUI task for the same request.',
          );
          return;
        }
        const instruction = call.args.instruction?.trim();
        if (!instruction) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: instruction is required.',
          );
          return;
        }

        const instructionDecision = classifyIntent(instruction);
        const userDecision = this.lastUserText
          ? classifyIntent(this.lastUserText)
          : null;
        const userIsExplicitChat = this.lastUserText
          ? isExplicitChat(this.lastUserText)
          : false;
        const travelText = `${this.lastUserText} ${instruction}`;
        if (
          isTravelPlanningText(travelText) &&
          !isExplicitTravelGuiRequest(travelText)
        ) {
          this.provider.sendToolResult(
            call.callId,
            'REJECTED: this is travel planning, not a desktop GUI task. Use travel_update_plan / travel_probe_highlights / travel_set_preference / travel_set_constraints / travel_expand_aspect / travel_finalize_plan instead. Only call start_gui_task when the user explicitly asks to open a booking site and operate it.',
          );
          return;
        }

        // The model often paraphrases the user's task with verbs the gate does
        // not know ("在桌面新建一个txt文件..." lacks 打开/搜索/给我). Allow the
        // call when either the instruction or the original user text is a task.
        const allowedByUserText = userDecision?.kind === 'task';
        if (
          (instructionDecision.kind !== 'task' && !allowedByUserText) ||
          userIsExplicitChat
        ) {
          this.provider.sendToolResult(
            call.callId,
            'REJECTED: this is conversation, not a GUI task. Do not call the GUI agent. Answer the user directly or ask a clarifying question.',
          );
          return;
        }

        // The model sometimes routes "我要去巴黎的机票" or "打开B站" to the
        // GUI agent and slowly clicks through a homepage. Pure navigation and
        // search have faster fast-path tools. Allow the GUI path when the
        // instruction itself needs interaction.
        const voiceIntent = this.lastVoiceIntent;
        const needsGuiInteraction = GUI_INTERACTION_PATTERNS.some((pattern) =>
          pattern.test(instruction),
        );
        if (voiceIntent?.mode === 'navigate' && !needsGuiInteraction) {
          const target = voiceIntent.target;
          const isApp = voiceIntent.targetKind === 'app';
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: isApp ? 'use_open_app' : 'use_open_site',
              target,
              message: isApp
                ? `USE_OPEN_APP: "${this.lastUserText}" is app navigation, not a GUI task. Call open_app with app "${target}".`
                : `USE_OPEN_SITE: "${this.lastUserText}" is site navigation, not a GUI task. Call open_site with site "${target ?? 'bing'}".`,
            }),
          );
          return;
        }
        if (
          voiceIntent?.mode === 'search' &&
          voiceIntent.confidence === 'high' &&
          !needsGuiInteraction
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'use_search_tool',
              query: voiceIntent.query,
              message:
                `USE_SEARCH_WEB: "${this.lastUserText}" is a web information need, not a GUI automation task. ` +
                `Call search_web with query "${voiceIntent.query}" instead. ` +
                'If the user also wants to read/compare/click the results, pass a task_instruction to search_web.',
            }),
          );
          return;
        }

        try {
          const task = this.controller.startTask(instruction, 'voice');
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              task_id: task.taskId,
              status: 'started',
              message:
                'TASK_STARTED. The GUI agent is still executing. Do NOT claim the task is complete. Say briefly that you are working on it, then wait for the final task_done/task_failed event.',
            }),
          );
        } catch (error) {
          if (error instanceof TaskBusyError) {
            this.provider.sendToolResult(
              call.callId,
              'TASK_BUSY: a GUI task is already running. Ask the user whether to cancel it before starting a new one.',
            );
            return;
          }
          throw error;
        }
        break;
      }
      case 'search_web': {
        const intent = this.lastVoiceIntent;
        if (intent?.mode === 'navigate') {
          const isApp = intent.targetKind === 'app';
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: isApp ? 'use_open_app' : 'use_open_site',
              target: intent.target,
              message: isApp
                ? `USE_OPEN_APP: "${this.lastUserText}" is app navigation. Call open_app with app "${intent.target}" instead of searching.`
                : `USE_OPEN_SITE: "${this.lastUserText}" is site navigation. Call open_site with site "${intent.target ?? 'bing'}" instead of searching.`,
            }),
          );
          return;
        }
        if (intent?.mode === 'answer') {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'answer_from_knowledge',
              message:
                `ANSWER_FROM_KNOWLEDGE: "${this.lastUserText}" is stable knowledge, not a live web lookup. ` +
                'Answer now from your internal knowledge. Do not search. If you are genuinely unsure, say so and ask the user for permission to search.',
            }),
          );
          return;
        }
        const query = String(call.args.query || '').trim();
        if (
          Date.now() < this.flightComparisonActiveUntil &&
          /机票|航班|比价|travel|flight|ctrip|trip/i.test(
            `${query} ${this.lastUserText}`,
          )
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              code: 'FLIGHT_COMPARISON_RUNNING',
              message:
                'A live three-site flight comparison is already running. Do not search the web for flights; wait for its result.',
            }),
          );
          return;
        }

        // "打开B站搜一下猫": keep the search inside Bilibili instead of
        // sending the user to a generic Bing results page.
        if (
          intent?.siteSearch &&
          intent.target &&
          intent.targetKind === 'site'
        ) {
          const siteQuery = query || intent.query;
          if (siteQuery) {
            try {
              const result = this.resolveSiteTarget(intent.target, siteQuery);
              if (
                !(await this.executeNavigation(
                  call,
                  'web.open_url',
                  { url: result.url },
                  async () => {
                    const { openUrl } = await import('./desktop-actions');
                    await openUrl(result.url);
                  },
                ))
              )
                return;
              await this.finishFastOpen(
                call,
                `${result.label}: ${result.url}`,
                call.args.task_instruction,
                1200,
                intent.silent,
              );
              break;
            } catch (error) {
              console.warn('[cyrvis voice] site search redirect failed', error);
            }
          }
        }

        if (!query) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: search_web requires a query.',
          );
          return;
        }
        const engineValue = String(call.args.engine || defaultSearchEngine());
        const engine: SearchEngine =
          engineValue === 'baidu' || engineValue === 'google'
            ? (engineValue as SearchEngine)
            : 'bing';
        const site =
          typeof call.args.site === 'string' ? call.args.site : undefined;
        try {
          const url = buildSearchUrl(query, engine, site);
          if (
            !(await this.executeNavigation(
              call,
              'web.search',
              { query, engine, site },
              async () => {
                const { openSearch } = await import('./desktop-actions');
                await openSearch(url);
              },
            ))
          )
            return;
          await this.finishFastOpen(
            call,
            url,
            call.args.task_instruction,
            1200,
            this.lastVoiceIntent?.silent === true,
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case 'open_url': {
        const url = String(call.args.url || '').trim();
        if (!url) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: open_url requires a URL.',
          );
          return;
        }
        if (
          Date.now() < this.flightComparisonActiveUntil &&
          /google\.com\/(?:travel\/flights|search)|ctrip|trip\.com|qunar|fliggy/i.test(
            url,
          )
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              code: 'FLIGHT_COMPARISON_RUNNING',
              message:
                'A live three-site flight comparison is already running. Do not open a search or booking page; wait for its result.',
            }),
          );
          return;
        }
        try {
          const opened = url;
          if (
            !(await this.executeNavigation(
              call,
              'web.open_url',
              { url },
              async () => {
                const { openUrl } = await import('./desktop-actions');
                await openUrl(url);
              },
            ))
          )
            return;
          await this.finishFastOpen(
            call,
            opened,
            call.args.task_instruction,
            1200,
            this.lastVoiceIntent?.silent === true,
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case 'open_app': {
        if (
          this.lastVoiceIntent?.mode === 'navigate' &&
          this.lastVoiceIntent.targetKind === 'site' &&
          this.lastVoiceIntent.target
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'use_open_site',
              target: this.lastVoiceIntent.target,
              message: `USE_OPEN_SITE: "${this.lastUserText}" is site navigation. Call open_site with site "${this.lastVoiceIntent.target}" instead of opening an app.`,
            }),
          );
          return;
        }
        const appValue = String(call.args.app || '');
        const allowedApps: AllowedApp[] = [
          'vscode',
          'chrome',
          'explorer',
          'notepad',
        ];
        if (
          !this.options.fastToolRouter &&
          !allowedApps.includes(appValue as AllowedApp)
        ) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: unsupported app. Allowed: ${allowedApps.join(', ')}.`,
          );
          return;
        }
        const target =
          typeof call.args.target === 'string' ? call.args.target : undefined;
        try {
          if (
            !(await this.executeNavigation(
              call,
              'app.launch',
              { name: appValue, target },
              async () => {
                const { openApp } = await import('./desktop-actions');
                await openApp(appValue as AllowedApp, target);
              },
            ))
          )
            return;
          const label = target ? `${appValue}:${target}` : appValue;
          await this.finishFastOpen(
            call,
            label,
            call.args.task_instruction,
            1800,
            this.lastVoiceIntent?.silent === true,
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case 'create_text_file': {
        const path = String(call.args.path || '').trim();
        const content =
          typeof call.args.content === 'string' ? call.args.content : '';
        const shouldOpen = call.args.open !== false;
        const overwrite = call.args.overwrite === true;
        if (!path) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: create_text_file requires a path.',
          );
          return;
        }
        if (!this.options.fastToolRouter) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: fast file tools are unavailable.',
          );
          return;
        }
        this.speak('好，正在写入文件。');
        try {
          if (
            !(await this.executeNavigation(
              call,
              'fs.create_file',
              { path, content, overwrite },
              async () => {
                throw new Error('fast file tools are unavailable');
              },
            ))
          ) {
            return;
          }

          let opened = false;
          if (shouldOpen) {
            const openResult =
              await this.options.fastToolRouter.executeNavigationTool(
                'fs.open',
                { path },
              );
            opened = openResult?.outcome?.ok === true;

            if (!opened) {
              const extension = path.split('.').pop()?.toLowerCase() || '';
              const textLike = [
                'txt',
                'md',
                'log',
                'json',
                'csv',
                'yaml',
                'yml',
                'ini',
                'xml',
                'html',
                'css',
                'js',
                'ts',
                'tsx',
                'jsx',
                'py',
              ].includes(extension);
              if (textLike) {
                // Last-resort visible launch for text documents when the
                // shell association cannot open the file.
                const { openApp } = await import('./desktop-actions');
                await openApp('notepad', path);
                opened = true;
              }
            }
          }

          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              status: opened ? 'created_and_opened' : 'created',
              path,
              bytes: Buffer.byteLength(content, 'utf8'),
              message: opened
                ? 'FILE_CREATED_AND_OPENED. Do not claim anything beyond what the tool returned; wait for the user.'
                : 'FILE_CREATED. The file was written but not opened.',
            }),
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case 'close_webpage': {
        const query = String(call.args.query || '').trim();
        if (!query || !this.options.fastToolRouter) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'invalid_request',
              message: 'close_webpage requires a page title or URL.',
            }),
          );
          break;
        }
        this.speak(`好，正在关闭${query}。`);
        try {
          const execution =
            await this.options.fastToolRouter.executeNavigationTool(
              'browser.close_page',
              { query },
            );
          const outcome = execution?.outcome;
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: outcome?.ok === true,
              status: outcome?.ok === true ? 'closed' : 'failed',
              query,
              message: outcome?.speech,
              data: outcome?.result?.data,
              error: outcome?.result?.error,
            }),
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'failed',
              query,
              message: `关闭网页失败：${
                error instanceof Error ? error.message : String(error)
              }`,
            }),
          );
        }
        break;
      }
      case 'create_presentation': {
        if (!this.options.fastToolRouter) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'unavailable',
              message: '本地演示文稿工具不可用。',
            }),
          );
          break;
        }
        const title =
          String(call.args.title || '').trim() ||
          this.lastActionableUserText ||
          'CYRVIS 演示文稿';
        const requestedPath = String(call.args.path || '').trim();
        const targetPath =
          requestedPath ||
          `桌面/CYRVIS-${title
            .replace(/[<>:"/\\|?*]/g, '-')
            .replace(/\s+/g, ' ')
            .slice(0, 60)}-${Date.now()}.pptx`;
        const presentationArgs = {
          path: targetPath,
          title,
          content:
            String(call.args.content || '').trim() ||
            this.lastActionableUserText,
          ...(call.args.sourcePath
            ? { sourcePath: String(call.args.sourcePath) }
            : {}),
          ...(typeof call.args.pageCount === 'number'
            ? { pageCount: call.args.pageCount }
            : {}),
          ...(call.args.audience
            ? { audience: String(call.args.audience) }
            : {}),
          ...(call.args.templateId
            ? { templateId: String(call.args.templateId) }
            : {}),
          ...(call.args.mode ? { mode: call.args.mode } : {}),
          provider: call.args.provider || 'auto',
        };
        if (
          this.options.fastToolRouter.isLongRunningTool(
            'office.create_presentation',
            presentationArgs,
          )
        ) {
          this.startBackgroundProviderToolCall(
            call,
            'office.create_presentation',
            presentationArgs,
          );
          break;
        }
        try {
          const execution =
            await this.options.fastToolRouter.executeNavigationTool(
              'office.create_presentation',
              presentationArgs,
            );
          const outcome = execution?.outcome;
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: outcome?.ok === true,
              status: outcome?.ok === true ? 'completed' : 'failed',
              path: targetPath,
              message: outcome?.speech,
              data: outcome?.result?.data,
              error: outcome?.result?.error,
            }),
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'failed',
              path: targetPath,
              message: `PPT 制作失败：${
                error instanceof Error ? error.message : String(error)
              }`,
            }),
          );
        }
        break;
      }
      case 'start_coding_task': {
        if (!this.options.codingAgent) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: coding agent is not configured.',
          );
          return;
        }
        if (this.controller.isBusy()) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'busy',
              message:
                'A GUI task is already running. Finish or cancel it before starting a coding task.',
            }),
          );
          return;
        }
        const instruction = String(call.args.instruction || '').trim();
        if (!instruction) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: start_coding_task requires an instruction.',
          );
          return;
        }
        const requestedWorkspace = String(call.args.workspace || '').trim();
        if (
          requestedWorkspace &&
          path.resolve(requestedWorkspace) !==
            this.options.codingAgent.getWorkspace()
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'workspace_rejected',
              message: `Coding workspace is fixed to ${this.options.codingAgent.getWorkspace()}.`,
            }),
          );
          return;
        }
        try {
          const task = await this.options.codingAgent.start(instruction);
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              status: task.status,
              task_id: task.taskId,
              workspace: task.workspace,
              message:
                'CODING_TASK_STARTED. Do not claim completion; use get_coding_status or wait for the final result.',
            }),
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case 'get_coding_status': {
        if (!this.options.codingAgent) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: coding agent is not configured.',
          );
          return;
        }
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(this.options.codingAgent.getStatus()),
        );
        break;
      }
      case 'cancel_coding_task': {
        if (!this.options.codingAgent) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: coding agent is not configured.',
          );
          return;
        }
        const task = await this.options.codingAgent.cancel();
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({ ok: true, status: task.status }),
        );
        break;
      }
      case 'open_site': {
        if (
          this.lastVoiceIntent?.targetKind === 'app' &&
          this.lastVoiceIntent.target
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              status: 'use_open_app',
              target: this.lastVoiceIntent.target,
              message: `USE_OPEN_APP: "${this.lastUserText}" is app navigation. Call open_app with app "${this.lastVoiceIntent.target}" instead of open_site.`,
            }),
          );
          return;
        }
        const siteValue = String(call.args.site || '').trim();
        if (!siteValue) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: open_site requires a site.',
          );
          return;
        }
        const query =
          typeof call.args.query === 'string' ? call.args.query.trim() : '';
        if (
          Date.now() < this.flightComparisonActiveUntil &&
          /google|ctrip|trip|qunar|fliggy|机票|航班|旅行|travel/i.test(
            `${siteValue} ${query}`,
          )
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              code: 'FLIGHT_COMPARISON_RUNNING',
              message:
                'A live three-site flight comparison is already running. Do not open a travel site; wait for its result.',
            }),
          );
          return;
        }
        try {
          const result = this.resolveSiteTarget(siteValue, query || undefined);
          if (
            !(await this.executeNavigation(
              call,
              'web.open_url',
              { url: result.url },
              async () => {
                const { openUrl } = await import('./desktop-actions');
                await openUrl(result.url);
              },
            ))
          )
            return;
          await this.finishFastOpen(
            call,
            `${result.label}: ${result.url}`,
            call.args.task_instruction,
            1200,
            this.lastVoiceIntent?.silent === true,
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case 'cancel_gui_task': {
        if (
          this.lastDeterministicControl?.kind === 'cancel' &&
          Date.now() - this.lastDeterministicControl.at < 4000
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              status: this.controller.getStatus().status,
              message: 'ALREADY_HANDLED',
            }),
          );
          break;
        }
        const task = await this.controller.cancelTask(call.args.task_id);
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({ ok: true, status: task.status }),
        );
        break;
      }
      case 'pause_gui_task': {
        if (
          this.lastDeterministicControl?.kind === 'pause' &&
          Date.now() - this.lastDeterministicControl.at < 4000
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              status: this.controller.getStatus().status,
              message: 'ALREADY_HANDLED',
            }),
          );
          break;
        }
        const task = await this.controller.pauseTask();
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({ ok: true, status: task.status }),
        );
        break;
      }
      case 'resume_gui_task': {
        const task = await this.controller.resumeTask();
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({ ok: true, status: task.status }),
        );
        break;
      }
      case 'get_gui_status': {
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(this.controller.getStatus()),
        );
        break;
      }
      case 'remember_fact': {
        const text = call.args.text?.trim();
        if (!text || !this.options.rememberFact) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: long-term memory is unavailable or the fact is empty.',
          );
          break;
        }
        try {
          await this.options.rememberFact(text);
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({ ok: true, remembered: text }),
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case 'travel_update_plan': {
        const snapshot = travelPlanner.updateFramework({
          destination: call.args.destination,
          origin: call.args.origin,
          startDate: call.args.start_date,
          endDate: call.args.end_date,
          companions: call.args.companions,
          budget: call.args.budget,
          purpose: call.args.purpose,
          transport: call.args.transport,
          userText: call.args.user_text || this.lastUserText,
        });
        if (snapshot.skeleton) {
          void appendTravelMemo('framework', '旅行行程要点', snapshot.skeleton);
        }
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(
            slimTravelResult(snapshot, {
              message: /travel_expand_aspect|tickets|订票|雪票/.test(
                snapshot.speakHint || '',
              )
                ? 'Call travel_expand_aspect(aspect=tickets, with_search=false). Speak briefly; no GUI.'
                : snapshot.phase === 'probing_preferences'
                  ? 'Speak skeleton in one short line, then travel_probe_highlights.'
                  : 'Speak speakHint briefly; ask at most one missing field.',
            }),
          ),
        );
        break;
      }
      case 'travel_get_plan': {
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(slimTravelResult(travelPlanner.getSnapshot())),
        );
        break;
      }
      case 'travel_confirm_skeleton': {
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(
            slimTravelResult(travelPlanner.confirmSkeleton(), {
              message:
                'If preference missing, travel_probe_highlights next. Speak short.',
            }),
          ),
        );
        break;
      }
      case 'travel_probe_highlights': {
        const plan = travelPlanner.getSnapshot();
        if (plan.missingFramework.length > 0) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify(
              slimTravelResult(plan, {
                ok: false,
                message: 'Finish required framework fields first.',
              }),
            ),
          );
          break;
        }
        if (
          /(?:机票|航班|比价)/.test(this.lastUserText) &&
          plan.framework.origin &&
          plan.framework.destination &&
          plan.framework.startDate
        ) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify(
              slimTravelResult(plan, {
                ok: false,
                message:
                  'This is a flight/ticket comparison request. Do not probe highlights; run the deterministic flight comparison instead.',
              }),
            ),
          );
          break;
        }
        const probed = await probeTravelHighlights(plan.framework);
        if (probed.queries[0]) travelPlanner.noteSearch(probed.queries[0]);
        const snapshot = travelPlanner.setHighlights(probed.highlights);
        void appendTravelMemo(
          'highlights',
          `亮点试探-${plan.framework.destination || '旅行'}`,
          `${probed.season.monthLabel || ''} ${probed.season.festivalHints.join('、')}；` +
            snapshot.highlights
              .map((item) => `${item.interest}:${item.title}`)
              .join('；'),
        );
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(
            slimTravelResult(snapshot, {
              highlights: snapshot.highlights.map((item) => ({
                interest: item.interest,
                title: item.title,
              })),
              message:
                'Ask which one category they prefer. One short question; no long lists.',
            }),
          ),
        );
        break;
      }
      case 'travel_set_preference': {
        const interest = call.args.interest?.trim();
        if (!interest) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: interest is required.',
          );
          break;
        }
        const snapshot = travelPlanner.setPreference(interest, call.args.notes);
        void appendTravelMemo(
          'preference',
          '旅行偏好',
          snapshot.interestLabel || interest,
        );
        const latest = snapshot.aspects[snapshot.aspects.length - 1];
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(
            slimTravelResult(snapshot, {
              latestAspect: latest
                ? { aspect: latest.aspect, summary: latest.summary }
                : null,
              message:
                'Speak the concrete day plan from speakHint (named places). Do NOT narrate process or say you will organize later. No booking URLs until they pick one option.',
            }),
          ),
        );
        break;
      }
      case 'travel_set_constraints': {
        const snapshot = travelPlanner.setConstraints({
          okWithWalking: coerceOptionalBoolean(call.args.ok_with_walking),
          okWithEarlyStart: coerceOptionalBoolean(
            call.args.ok_with_early_start,
          ),
          okWithQueues: coerceOptionalBoolean(call.args.ok_with_queues),
          notes: call.args.notes,
          userText: call.args.user_text || this.lastUserText,
        });
        void appendTravelMemo(
          'constraints',
          '行程节奏备注',
          travelPlanner.getSnapshot().constraints
            ? [
                `步行：${snapshot.constraints.okWithWalking === false ? '尽量少走' : '可以多走走'}`,
                `早起：${snapshot.constraints.okWithEarlyStart === false ? '不赶早' : '可以早出门'}`,
                `排队：${snapshot.constraints.okWithQueues === false ? '少排队' : '能接受'}`,
                snapshot.constraints.notes || '',
              ]
                .filter(Boolean)
                .join('；')
            : '轻松不赶早',
        );
        const latest = snapshot.aspects[snapshot.aspects.length - 1];
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(
            slimTravelResult(snapshot, {
              latestAspect: latest
                ? { aspect: latest.aspect, summary: latest.summary }
                : null,
              message:
                'Speak the concrete executable plan from speakHint first. Put pace notes in one short aside. Never dump JSON. No URLs until they confirm an option.',
            }),
          ),
        );
        break;
      }
      case 'travel_expand_aspect': {
        const aspect = call.args.aspect?.trim();
        if (!aspect) {
          this.provider.sendToolResult(
            call.callId,
            'ERROR: aspect is required.',
          );
          break;
        }
        let snippets: string[] = [];
        const bookableLike =
          /ticket|accommodation|budget|门票|票务|买票|订票|预约|预订|雪票|住宿|酒店|民宿|ski/i.test(
            aspect,
          ) ||
          /(门票|买票|订票|预约|预订|雪票|展览票|演出票|乐园|住宿|酒店|民宿|住哪|帮我订)/.test(
            this.lastUserText || '',
          );
        // Bookable aspects: never search (avoids URL bleed before confirm).
        const shouldSearch = !bookableLike && call.args.with_search !== false;
        if (shouldSearch) {
          const plan = travelPlanner.getSnapshot();
          const query = buildTravelSearchQuery(
            plan.framework,
            null,
            `${aspect} ${call.args.notes || ''}`.trim(),
          );
          travelPlanner.noteSearch(query);
          const search = await searchTravelInfo(query);
          snippets = hitsToSnippets(search.hits);
        }
        travelPlanner.syncFromConversation([
          this.lastUserText,
          aspect,
          call.args.notes || '',
        ]);
        const pureConfirm = (() => {
          const compact = (this.lastUserText || '').replace(/\s+/g, '');
          return /^(选[123一二三]|选第[123一二三]个|第[123一二三]个|选第一个|选第二个|选第三个|就这个|就它|定这个|要这个|选定了?|就选这个)$/.test(
            compact,
          )
            ? this.lastUserText
            : undefined;
        })();
        const snapshot = travelPlanner.expandAspect(
          aspect,
          call.args.notes || pureConfirm,
          snippets,
          this.lastUserText,
        );
        const latest = snapshot.aspects[snapshot.aspects.length - 1];
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(
            slimTravelResult(snapshot, {
              latestAspect: latest
                ? { aspect: latest.aspect, summary: latest.summary }
                : null,
              message: bookableLike
                ? 'Speak 2-3 option names only; do NOT read URLs until the user picks one. Then give that one booking link. No GUI.'
                : 'Speak Day plan / options briefly from speakHint. Do not re-ask preference. No booking URLs until they confirm an option.',
            }),
          ),
        );
        break;
      }
      case 'travel_search': {
        if (Date.now() < this.flightComparisonActiveUntil) {
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: false,
              code: 'FLIGHT_COMPARISON_RUNNING',
              message:
                'A live three-site flight comparison is already running. Do not run travel_search; wait for its result.',
            }),
          );
          break;
        }
        const plan = travelPlanner.getSnapshot();
        const query =
          call.args.query?.trim() ||
          buildTravelSearchQuery(
            plan.framework,
            null,
            call.args.aspect || this.lastUserText,
          );
        travelPlanner.noteSearch(query);
        // Keep planner warm even when search is the first travel tool call.
        if (plan.phase === 'idle' && this.lastUserText) {
          travelPlanner.updateFramework({ userText: this.lastUserText });
        }
        const search = await searchTravelInfo(query);
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify({
            ok: search.ok,
            query: search.query,
            hits: search.hits.slice(0, 3).map((hit) => ({
              title: hit.title,
              snippet: (hit.snippet || '')
                .replace(/https?:\/\/\S+/gi, '')
                .trim(),
            })),
            error: search.error,
            phase: travelPlanner.getSnapshot().phase,
            message:
              'Use titles/snippets as short hints only. Do not read or invent booking URLs here. Speak briefly.',
          }),
        );
        break;
      }
      case 'travel_decline_expand': {
        const snapshot = travelPlanner.declineFurther();
        void appendTravelMemo(
          'pause',
          '旅行规划先告一段落',
          snapshot.skeleton || snapshot.speakHint,
        );
        this.provider.sendToolResult(
          call.callId,
          JSON.stringify(
            slimTravelResult(snapshot, {
              message:
                'Soft close in one sentence. Offer travel_finalize_plan if they want the desktop HTML plan page.',
            }),
          ),
        );
        break;
      }
      case 'travel_finalize_plan': {
        try {
          const plan = travelPlanner.getSnapshot();
          const written = await writeTravelPlanDesktopTxt(plan);
          const snapshot = travelPlanner.markFinalized(written.desktopPath);
          const fileName =
            written.desktopPath.split(/[/\\]/).pop() || written.desktopPath;
          this.provider.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              phase: snapshot.phase,
              desktopPath: written.desktopPath,
              fileName,
              speakHint: snapshot.speakHint,
              message:
                'ONLY say: the styled travel plan page is ready on the desktop; open it in the browser to review. One or two short sentences. Do NOT read any plan content aloud.',
            }),
          );
        } catch (error) {
          this.provider.sendToolResult(
            call.callId,
            `ERROR: failed to write travel plan HTML: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        break;
      }
      default: {
        const unknown = call as { callId: string; name: string };
        this.provider.sendToolResult(
          unknown.callId,
          `ERROR: unknown tool "${unknown.name}".`,
        );
      }
    }
  }

  private handleFastToolCommand(text: string): boolean {
    const router = this.options.fastToolRouter;
    if (!router) {
      return false;
    }
    const startedAt = Date.now();
    this.fastToolGuardUntil = Date.now() + 8000;
    this.deterministicFastToolGuardUntil = Date.now() + 8000;
    this.provider.cancelResponse();
    this.resetAwakeTimer();
    void router
      .match(text)
      .then(async (route) => {
        if (!route) {
          return null;
        }
        console.info('[cyrvis fast-tools] route', {
          kind: route.kind,
          tool: route.tool,
          domain: route.domain,
          risk: route.risk,
        });
        const acknowledgement = this.fastToolAcknowledgement(route.tool);
        if (acknowledgement) this.speak(acknowledgement);
        if (router.isLongRunningTool(route.tool, route.args)) {
          this.startBackgroundRoute(route);
          return null;
        }
        return router.execute(route);
      })
      .then((outcome) => {
        if (!outcome?.handled || !outcome.speech) {
          return;
        }
        console.info('[cyrvis fast-tools] result', {
          kind: outcome.route?.kind,
          tool: outcome.route?.tool,
          ok: outcome.ok,
          durationMs: Date.now() - startedAt,
        });
        this.fastToolGuardUntil = Date.now() + 3000;
        this.deterministicFastToolGuardUntil = Date.now() + 3000;
        this.speak(outcome.speech);
      })
      .catch((error: unknown) => {
        this.fastToolGuardUntil = 0;
        this.deterministicFastToolGuardUntil = 0;
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        this.callbacks.onError?.(normalized);
        this.speak(`操作失败：${normalized.message}`);
      });
    return true;
  }

  private startBackgroundRoute(route: FastToolRoute): void {
    this.runBackgroundFastTool(
      `route:${route.tool}:${Date.now()}`,
      this.backgroundToolLabel(route.tool),
      () => this.options.fastToolRouter!.execute(route),
    );
  }

  private startBackgroundProviderToolCall(
    call: VoiceToolCallWithId,
    localName: string,
    args: Record<string, unknown>,
  ): void {
    if (this.backgroundToolJobs.has(call.callId)) return;
    const label = this.backgroundToolLabel(localName);
    const startMessage = `好，${label}已开始，完成后我会向你汇报。`;
    this.provider.sendToolResult(
      call.callId,
      JSON.stringify({
        ok: true,
        status: 'running',
        background: true,
        tool: localName,
        message: `${label}已在后台启动。请立即简短确认已开始，并告诉用户完成后会汇报；不要说任务已经完成。`,
        startMessage,
      }),
    );
    this.fastToolGuardUntil = Date.now() + 3_000;
    this.runBackgroundFastTool(
      call.callId,
      label,
      async () => {
        const execution =
          await this.options.fastToolRouter!.executeProviderToolCall(
            call.name,
            args,
          );
        return execution?.outcome || null;
      },
      startMessage,
    );
  }

  private runBackgroundFastTool(
    key: string,
    label: string,
    operation: () => Promise<FastToolOutcome | null>,
    startMessage?: string,
  ): void {
    if (this.backgroundToolJobs.has(key)) return;
    const heartbeat = setInterval(() => {
      this.announceProgress(`${label}仍在处理中，完成后会告诉你。`);
    }, 30_000);
    heartbeat.unref?.();
    const startFallback = startMessage
      ? setTimeout(() => {
          const job = this.backgroundToolJobs.get(key);
          if (!job || this.userSpeaking || this.ttsSpeaking) return;
          if (Date.now() - this.lastAssistantTextAt < 5_000) return;
          this.speakRequestedReply(startMessage);
        }, 2_000)
      : null;
    startFallback?.unref?.();
    this.backgroundToolJobs.set(key, { heartbeat, startFallback });
    void operation()
      .then((outcome) => {
        if (!this.backgroundToolJobs.has(key)) return;
        if (!outcome) {
          this.speakRequestedReply(`${label}没有返回执行结果。`);
          return;
        }
        const detail = outcome.speech?.trim();
        const message = outcome.ok
          ? `${label}已完成。${detail || ''}`
          : `${label}未完成。${detail || '请查看任务详情。'}`;
        this.speakRequestedReply(message);
      })
      .catch((error: unknown) => {
        if (!this.backgroundToolJobs.has(key)) return;
        const message = error instanceof Error ? error.message : String(error);
        this.speakRequestedReply(`${label}执行失败：${message}`);
      })
      .finally(() => {
        const job = this.backgroundToolJobs.get(key);
        if (job) {
          clearInterval(job.heartbeat);
          if (job.startFallback) clearTimeout(job.startFallback);
        }
        this.backgroundToolJobs.delete(key);
        this.fastToolGuardUntil = Date.now() + 3_000;
        this.deterministicFastToolGuardUntil = Date.now() + 3_000;
      });
  }

  private backgroundToolLabel(tool: string): string {
    if (tool === 'office.create_presentation') return 'PPT 制作';
    if (tool === 'workflow.start') return '工作流任务';
    if (tool === 'web.download') return '文件下载';
    if (tool === 'archive.create') return '压缩任务';
    if (tool === 'archive.extract') return '解压任务';
    if (tool === 'document.extract_text' || tool === 'pdf.extract_text') {
      return '文档解析';
    }
    if (tool === 'capability.invoke') return '长程任务';
    return '任务';
  }

  private fastToolAcknowledgement(tool: string): string | null {
    if (tool === 'office.create_presentation') {
      return '好，PPT 已开始制作，我会汇报进度。';
    }
    if (tool === 'web.download' || tool === 'network.download') {
      return '好，正在下载。';
    }
    if (
      tool === 'document.archive' ||
      tool === 'document.extract' ||
      tool === 'fs.copy' ||
      tool === 'fs.move'
    ) {
      return '好，正在处理文件。';
    }
    return null;
  }

  private async handleFastProviderToolCall(
    call: VoiceToolCallWithId,
    localName: string,
  ): Promise<void> {
    const router = this.options.fastToolRouter;
    if (!router) {
      this.provider.sendToolResult(
        call.callId,
        'ERROR: local fast-tool router is unavailable.',
      );
      return;
    }

    const discoveryOnly =
      localName === 'capability.search' || localName === 'capability.describe';
    const toolArgs = call.args as Record<string, unknown>;
    if (!discoveryOnly && router.isLongRunningTool(localName, toolArgs)) {
      const backgroundName =
        localName === 'capability.invoke' && typeof toolArgs.toolId === 'string'
          ? toolArgs.toolId
          : localName;
      this.startBackgroundProviderToolCall(call, backgroundName, toolArgs);
      return;
    }
    this.fastToolGuardUntil = discoveryOnly ? 0 : Date.now() + 8000;
    try {
      const execution = await router.executeProviderToolCall(
        call.name,
        call.args as Record<string, unknown>,
      );
      if (!execution) {
        this.provider.sendToolResult(
          call.callId,
          `ERROR: unknown local fast tool "${call.name}".`,
        );
        return;
      }
      const outcome = execution.outcome;
      const confirmationRequired =
        outcome.route?.requiresConfirmation === true ||
        outcome.result?.error?.code === 'CONFIRMATION_REQUIRED';
      if (confirmationRequired) {
        // Returning another tool result starts a new model response, which
        // commonly calls the same tool again and repeats "confirm". Cancel the
        // model turn and ask directly from the deterministic confirmation state.
        this.provider.cancelResponse();
        this.speak(outcome.speech || SENSITIVE_CONFIRMATION_PROMPT);
        console.info('[cyrvis fast-tools] confirmation required', {
          providerTool: call.name,
          tool: localName,
        });
        return;
      }
      const payload = {
        ok: outcome.ok === true,
        status: outcome.ok === true ? 'completed' : 'failed',
        tool: localName,
        message: outcome.speech,
        data: outcome.result?.data,
        error: outcome.result?.error,
      };
      const serialized = JSON.stringify(payload);
      this.provider.sendToolResult(
        call.callId,
        serialized.length > 12_000
          ? `${serialized.slice(0, 12_000)}...TRUNCATED`
          : serialized,
      );
      const handledLocally = !discoveryOnly && outcome.ok === true;
      this.fastToolGuardUntil = handledLocally ? Date.now() + 3000 : 0;
      console.info('[cyrvis fast-tools] model tool result', {
        providerTool: call.name,
        tool: localName,
        ok: outcome.ok,
        confirmationRequired,
      });
    } catch (error) {
      this.fastToolGuardUntil = 0;
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[cyrvis fast-tools] model tool failed', {
        providerTool: call.name,
        tool: localName,
        error: message,
      });
      this.provider.sendToolResult(
        call.callId,
        JSON.stringify({
          ok: false,
          status: 'failed',
          tool: localName,
          message: `本地工具执行失败：${message}`,
        }),
      );
    }
  }

  private inspectGaze(question: string): Promise<string> {
    if (!this.options.inspectGaze)
      return Promise.reject(new Error('当前未配置AI看屏功能。'));
    this.pendingGazeRequests++;
    let operation: Promise<string>;
    try {
      operation = this.options.inspectGaze(question);
    } catch (error) {
      operation = Promise.reject(error);
    }
    const result = operation.finally(() => {
      this.pendingGazeRequests--;
      this.resetAwakeTimer();
    });
    this.lastInspection = { question, at: Date.now(), result };
    return result;
  }

  private handleContinueCommand(text: string): boolean {
    const isContinueOnly =
      /^(?:啊|呃|哦|嗯|好|ok)?[，,\s]*(?:继续|恢复|接着做|继续任务|continue|resume)(?:吧|啊|呀|刚刚那个任务|刚才那个任务|之前的任务)?[。！？!?，,\s]*$/i.test(
        text.trim(),
      );
    if (!isContinueOnly) {
      return false;
    }
    this.userStopped = false;
    this.provider.cancelResponse();
    const status = this.controller.getStatus().status;
    if (status === 'paused') {
      void this.controller
        .resumeTask()
        .then(() => this.speak('继续执行。'))
        .catch((error: unknown) => {
          this.speak(
            `恢复任务失败：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      return true;
    }
    if (status === 'starting' || status === 'executing') {
      this.speak('任务正在执行，不需要重复启动。');
      return true;
    }
    if (this.options.codingAgent?.isBusy()) {
      this.speak('编码任务正在执行，请稍等。');
      return true;
    }
    this.speak('当前没有可继续的任务，请重新说明要做什么。');
    return true;
  }

  private handleSemanticPendingReply(
    text: string,
    pending: NonNullable<ReturnType<FastToolRouter['getPendingConfirmation']>>,
  ): void {
    const router = this.options.fastToolRouter;
    const classify = this.options.classifyPendingIntent;
    if (!router || !classify) {
      return;
    }
    this.fastToolGuardUntil = Date.now() + 8_000;
    this.deterministicFastToolGuardUntil = Date.now() + 8_000;
    this.provider.cancelResponse();
    const context = [
      this.lastActionableUserText,
      this.taskConversation.describeStatus(),
    ]
      .filter(Boolean)
      .join('\n');
    void classify({ text, pending, context })
      .then(async (decision) => {
        const threshold = pending.risk === 'high' ? 0.9 : 0.82;
        if (decision.intent === 'confirm' && decision.confidence >= threshold) {
          const outcome = await router.confirmPending();
          this.markUserResponseOutput();
          this.speak(outcome.speech || '操作已执行。');
          console.info('[cyrvis intent-arbiter] confirmed', {
            tool: pending.tool,
            confidence: decision.confidence,
            reason: decision.reason,
          });
          return;
        }
        if (decision.intent === 'cancel' && decision.confidence >= 0.82) {
          const outcome = await router.cancelPending();
          this.markUserResponseOutput();
          this.speak(outcome.speech || '已取消。');
          console.info('[cyrvis intent-arbiter] cancelled', {
            tool: pending.tool,
            confidence: decision.confidence,
            reason: decision.reason,
          });
          return;
        }
        this.markUserResponseOutput();
        this.speak('待确认操作尚未执行。请明确说“执行”或“取消”。');
        console.info('[cyrvis intent-arbiter] ambiguous pending reply', {
          tool: pending.tool,
          intent: decision.intent,
          confidence: decision.confidence,
          reason: decision.reason,
        });
      })
      .catch((error: unknown) => {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        this.callbacks.onError?.(normalized);
        this.markUserResponseOutput();
        this.speak('没有判断出是否确认。请说“执行”或“取消”。');
      })
      .finally(() => {
        this.fastToolGuardUntil = Date.now() + 3_000;
        this.deterministicFastToolGuardUntil = Date.now() + 3_000;
        this.notifyState();
      });
  }

  private isStopFragment(text: string): boolean {
    return /^(?:马上|赶紧|赶快|立刻|立即|快点|快|现在|先)?(?:停|停了|停下|停住|停止|停一下|下|住|止|别动|不要动|住手|别说了|不要说了|别念了|不要念了|闭嘴|安静|算了|取消)[。！？!?，,\s]*$/i.test(
      text.trim(),
    );
  }

  private isStopCommand(text: string): boolean {
    const compact = text
      .replace(/[，。！？、,.!?;；:：\s]/g, '')
      .replace(/^(?:呃|啊|哦|嗯|唉|诶)+/i, '');
    return /^(?:马上|赶紧|赶快|立刻|立即|快点|快|现在就|现在|先|给我)*(?:停|停一下|停一停|停下|停下来|停住|停止|先停|别做|别做了|不要做|不要做了|别动|不要动|住手|别说了|不要说了|别念了|不要念了|闭嘴|安静|取消|算了|stop|cancel|abort)(?:之前(?:的)?|目前|当前|这个|所有)?(?:任务|操作)?(?:吧|啊|呀|好吗|好不好)?$/i.test(
      compact,
    );
  }

  private handleStopCommand(
    preserveIntake = false,
    cancelTasks: 'all' | 'gui' | 'none' = 'all',
  ): boolean {
    const status = this.controller.getStatus().status;
    const guiActive =
      cancelTasks !== 'none' &&
      ['starting', 'executing', 'paused', 'cancelling'].includes(status);
    const codingActive =
      cancelTasks === 'all' && this.options.codingAgent?.isBusy() === true;
    if (cancelTasks === 'all' && Date.now() - this.lastHardStopAt < 1_500) {
      return true;
    }
    if (cancelTasks === 'all') {
      this.lastHardStopAt = Date.now();
    }
    this.pendingBargeStopAt = 0;
    this.provider.cancelResponse();
    this.provider.cancelPendingSpeech?.();
    this.markUserStop(preserveIntake);
    if (cancelTasks !== 'all') {
      // A soft barge stops the current answer, not the session. Keep
      // `userStopped` false so a background coding task can still announce
      // its progress/result after the 3s reply-suppression window.
      this.userStopped = false;
    }
    this.taskConversation.markStopped();
    this.lastDeterministicControl = { kind: 'cancel', at: Date.now() };
    console.info('[cyrvis voice] hard stop', {
      gui: guiActive,
      coding: codingActive,
      speaking: this.ttsSpeaking,
    });
    if (guiActive) {
      void this.controller.cancelTask().catch((error: unknown) => {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }
    if (codingActive) {
      void this.options.codingAgent?.cancel().catch((error: unknown) => {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }
    return true;
  }

  private handleDeterministicControl(text: string): 'cancel' | 'pause' | null {
    const status = this.controller.getStatus().status;
    const guiActive = [
      'starting',
      'executing',
      'paused',
      'cancelling',
    ].includes(status);
    const codingActive = this.options.codingAgent?.isBusy() === true;
    if (!guiActive && !codingActive) {
      return null;
    }

    const explicitCancel =
      /(取消|算了|不想|不要|不用|停止|停下|停一下|先停|别做|别动|stop|cancel|abort)/i.test(
        text,
      ) || /(^|[\s，。])停([\s，。！？]|$)/.test(text);
    const pause = /(暂停|等一下|等等|pause)/i.test(text);

    if (explicitCancel) {
      this.lastDeterministicControl = { kind: 'cancel', at: Date.now() };
      if (guiActive) {
        void this.controller.cancelTask().catch((error: unknown) => {
          this.callbacks.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      }
      if (codingActive) {
        void this.options.codingAgent?.cancel().catch((error: unknown) => {
          this.callbacks.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      }
      return 'cancel';
    }
    if (pause) {
      this.lastDeterministicControl = { kind: 'pause', at: Date.now() };
      if (guiActive) {
        void this.controller.pauseTask().catch((error: unknown) => {
          this.callbacks.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      }
      if (codingActive) {
        // The coding worker has no resumable pause; treat pause as a safe
        // cancellation instead of leaving it running.
        void this.options.codingAgent?.cancel().catch((error: unknown) => {
          this.callbacks.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      }
      return 'pause';
    }
    return null;
  }

  private guardCompletionClaim(text: string): void {
    if (this.completionGuardTriggered) {
      return;
    }

    const status = this.controller.getStatus().status;
    const taskActive = [
      'starting',
      'executing',
      'paused',
      'cancelling',
    ].includes(status);
    if (!taskActive) {
      return;
    }

    this.assistantTextBuffer += text;
    if (!this.completionClaimPattern.test(this.assistantTextBuffer)) {
      return;
    }

    this.completionGuardTriggered = true;
    this.suppressAudioUntilResponseDone = true;
    this.provider.cancelResponse();
    this.callbacks.onAssistantText?.(
      '[任务仍在执行，已拦截提前完成声明]',
      true,
    );
    const task = this.controller.getStatus();
    const atTaskStart =
      task.startedAt !== null && Date.now() - task.startedAt < 5_000;
    setTimeout(() => {
      this.speak(
        atTaskStart
          ? '任务已开始。我正在执行，请稍等。'
          : '好的，我正在执行，请稍等。',
      );
    }, 300);
  }

  /**
   * Full-sentence echo detection. `isSelfEchoTranscript` deliberately lets
   * actionable-looking turns through, which is exactly what a self-echo of
   * "需要继续完善这个任务吗？" looks like. Require a full sentence so a real
   * short reply such as "继续完善这个任务" is not discarded.
   */
  private isStrongSelfEchoTranscript(text: string): boolean {
    if (!this.lastAssistantText.trim()) {
      return false;
    }
    const heard = normalize(text).replace(/[，。！？,.!?\s]/g, '');
    if (heard.length < 12) {
      return false;
    }
    return isLikelySpeakerEcho(
      text,
      this.lastAssistantText,
      Date.now() - this.lastAssistantAudioAt,
      8_000,
    );
  }

  private isSelfEchoTranscript(text: string): boolean {
    if (!this.lastAssistantText.trim()) {
      return false;
    }
    // Only close to recent assistant audio; this avoids treating an unrelated
    // "我在" much later as an echo.
    if (Date.now() - this.lastAssistantAudioAt > 3000) {
      return false;
    }
    const strip = (value: string) =>
      normalize(value).replace(/[，。！？,.!?\s]/g, '');
    const heard = strip(text);
    if (!heard) {
      return false;
    }
    const spoken = strip(this.lastAssistantText);
    if (spoken.includes(heard) || heard.includes(spoken)) {
      return true;
    }
    // ASR often truncates the assistant's short acknowledgement in speaker
    // mode. Keep this list deliberately narrow so a real "停" is unaffected.
    return /^(我在|我来|我|在听|我听到了|听到|嗯+|啊+|好+)$/.test(heard);
  }

  private isWakePhrase(text: string): boolean {
    const normalized = normalize(text);
    return this.wakePatterns.some((pattern) => pattern.test(normalized));
  }

  private wake(): void {
    if (this.awake) {
      this.resetAwakeTimer();
      return;
    }
    this.awake = true;
    this.callbacks.onWake?.();
    this.resetAwakeTimer();
    this.notifyState();
  }

  notifyCodingStatus(snapshot: CodingTaskSnapshot): void {
    if (snapshot.status === 'idle' || this.userStopped) {
      return;
    }
    if (snapshot.status === 'running') {
      this.notifyCodingProgress(snapshot);
      return;
    }
    console.info('[cyrvis coding] notify status', {
      status: snapshot.status,
      awake: this.awake,
      result: snapshot.result.slice(0, 200),
      error: snapshot.error,
    });
    if (!this.awake) {
      // A coding task can outlive the 20s wake window. Its completion is a
      // direct answer to the user's request, so wake and report it instead of
      // silently dropping the status.
      this.wake();
    }
    if (snapshot.status === 'done') {
      const summary = this.summarizeCodingResult(snapshot.result);
      this.speakCodingSummary(
        summary ? `编码任务完成。总结：${summary}` : '编码任务已完成。',
      );
    } else if (snapshot.status === 'failed') {
      this.speakCodingSummary(`编码任务失败：${snapshot.error || '未知错误'}`);
    } else if (snapshot.status === 'cancelled') {
      this.speakCodingSummary('编码任务已取消。');
    }
  }

  private notifyCodingProgress(snapshot: CodingTaskSnapshot): void {
    if (this.userStopped || !this.awake || this.userSpeaking) {
      return;
    }
    if (!this.awake) this.wake();
    const now = Date.now();
    const event = snapshot.lastEvent;
    if (
      /(?:background[- ]shells?|shell-bg_|\.qwen\/tmp|Blocked:\s*sleep\b)/i.test(
        `${event?.message || ''} ${event?.filePath || ''} ${snapshot.lastMessage}`,
      )
    ) {
      return;
    }
    if (!event?.tool) {
      const fallback = snapshot.lastMessage.trim();
      if (!this.lastCodingProgressAt) {
        this.lastCodingProgressAt = now;
        this.lastCodingProgressMessage = fallback;
        return;
      }
      if (
        fallback &&
        now - this.lastCodingProgressAt >= 15_000 &&
        fallback !== this.lastCodingProgressMessage
      ) {
        this.lastCodingProgressAt = now;
        this.lastCodingProgressMessage = fallback;
        this.speakCodingProgress(`编码进度：${fallback}`);
      }
      return;
    }

    const isResult = event.ok !== undefined;
    let text = '';
    if (['write_file', 'edit_file', 'replace'].includes(event.tool)) {
      // Key node only: file finished writing, not the "reading/finding" noise.
      if (event.ok !== true) {
        return;
      }
      const file = path.basename(event.filePath || '') || '文件';
      text = `编码进度：已写入 ${file}`;
    } else if (event.tool === 'run_shell_command') {
      if (!isResult) {
        // Do not read raw shell command lines aloud. They are long, noisy,
        // and used to dominate TTS in speaker mode, where the microphone then
        // heard the assistant itself and cancelled the coding task.
        return;
      } else {
        const output = this.cleanCodingOutput(
          event.output || event.message.replace(/^命令(?:完成|失败)：/, ''),
        );
        if (
          !event.ok &&
          /Command is not allowed|Path is outside the workspace|Command directory is outside/i.test(
            output,
          )
        ) {
          // The raw text contains a whole shell command and used to be read
          // aloud for half a minute. The model already got the details.
          text = '编码进度：有个操作被安全策略拦住了，我换个方式继续。';
        } else {
          text = event.ok
            ? `运行结果：${output || '命令执行完成'}`
            : `运行失败：${output || '未知错误'}`;
        }
      }
    } else {
      if (!this.lastCodingProgressAt) {
        this.lastCodingProgressAt = now;
        this.lastCodingProgressMessage = event.message || snapshot.lastMessage;
        return;
      }
      if (now - this.lastCodingProgressAt < 15_000) return;
      text = `编码进度：${event.message || snapshot.lastMessage}`.trim();
    }

    if (!isResult && now - this.lastCodingProgressAt < 1_500) {
      return;
    }
    if (text === this.lastCodingProgressMessage) {
      return;
    }
    this.lastCodingProgressAt = now;
    this.lastCodingProgressMessage = text;
    console.info('[cyrvis coding] speak progress', { text });
    this.speakCodingProgress(text);
  }

  private cleanCodingOutput(value: string): string {
    return value
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[|]{1,}/g, ' ')
      .replace(/-{3,}/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);
  }

  private summarizeCodingResult(result: string): string {
    // Keep the contents of fenced blocks here: they often contain the command
    // output the user explicitly asked to hear. Only strip the fence markers.
    const normalized = result
      .replace(/```[a-z0-9_-]*\n?([\s\S]*?)```/gi, ' $1 ')
      .replace(/[A-Za-z]:\\[^\s`'"，。；;]+/g, (value) =>
        path.win32.basename(value.replace(/\//g, '\\')),
      )
      .replace(/[|]{1,}/g, ' ')
      .replace(/-{3,}/g, ' ')
      .replace(/\*{2,}/g, '')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    let runIndex = normalized.search(
      /(?:运行输出|执行输出|输出结果|遍历顺序)/i,
    );
    if (runIndex < 0) {
      runIndex = normalized.search(/(?:运行结果|执行结果|exit code|退出码)/i);
    }
    if (runIndex >= 0) {
      const before = normalized.slice(0, runIndex).slice(0, 90);
      const after = normalized.slice(runIndex).slice(0, 150);
      return `${before} ${after}`.trim();
    }
    return normalized.slice(0, 180);
  }

  private speakCodingSummary(text: string): void {
    // A coding result can be a long paragraph. Keep the speaker-mode energy
    // barge from treating the assistant's own TTS tail as an interruption
    // while it reads the result. KWS stop words and Ctrl+Alt+X still cancel.
    this.speakCodingProgress(text);
  }

  private speakCodingProgress(text: string): void {
    this.taskSpeechGuardUntil =
      Date.now() + Math.min(25_000, Math.max(2_500, text.length * 220));
    this.speak(text);
  }

  private speak(text: string, readoutId?: string): void {
    this.say(text, false, readoutId);
  }

  /** Read deterministic workflow lines without answering a stale user turn. */
  private speakExact(text: string): void {
    this.say(text, true);
  }

  private say(text: string, exact: boolean, readoutId?: string): void {
    if (!this.awake) return;
    this.taskConversation.noteAssistantOutput();
    this.markUserResponseOutput();
    this.ttsSpeaking = true;
    this.proactivity.setTtsSpeaking(true);
    if (exact && this.provider.speakExact) {
      this.provider.speakExact(text);
    } else if (readoutId) {
      this.provider.speak(text, readoutId);
    } else {
      this.provider.speak(text);
    }
    this.notifyState();

    if (this.speakWatchdog) {
      clearTimeout(this.speakWatchdog);
    }
    this.speakWatchdog = setTimeout(
      () => {
        this.readoutGuardUntil = 0;
        this.ttsSpeaking = false;
        this.proactivity.setTtsSpeaking(false);
        this.notifyState();
      },
      this.isReadoutSpeechActive() ? 45_000 : 15_000,
    );
  }

  private armPlaybackWatchdog(): void {
    this.clearPlaybackWatchdog();
    this.playbackWatchdog = setTimeout(
      () => {
        this.playbackWatchdog = null;
        console.warn('[cyrvis voice] playback idle watchdog fired');
        this.readoutGuardUntil = 0;
        this.ttsSpeaking = false;
        this.proactivity.setTtsSpeaking(false);
        this.notifyState();
      },
      this.isReadoutSpeechActive() ? 45_000 : 15_000,
    );
  }

  private clearPlaybackWatchdog(): void {
    if (this.playbackWatchdog) {
      clearTimeout(this.playbackWatchdog);
      this.playbackWatchdog = null;
    }
  }

  private resetAwakeTimer(): void {
    this.clearAwakeTimer();
    if (!this.awake || this.awakeTimeoutMs <= 0) {
      return;
    }
    this.awakeTimer = setTimeout(() => {
      if (
        this.pendingGazeRequests > 0 ||
        this.ttsSpeaking ||
        this.controller.isBusy()
      ) {
        this.resetAwakeTimer();
        return;
      }
      this.sleep();
    }, this.awakeTimeoutMs);
  }

  private clearAwakeTimer(): void {
    if (this.awakeTimer) {
      clearTimeout(this.awakeTimer);
      this.awakeTimer = null;
    }
  }

  private notifyState(): void {
    this.callbacks.onState?.(this.getState());
  }
}
