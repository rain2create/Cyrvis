import type { GazeChatPhase, GazeChatTurn } from '@shared/cyrvis';
import type { GazeInspection } from './inspector';

/** Correlates one frozen screenshot with its own reply and playback receipt. */
export class GazeChat {
  private turns = new Map<string, GazeChatTurn>();
  private gazes = new Map<string, NonNullable<GazeInspection['gaze']>>();
  private listeners = new Set<(turn: GazeChatTurn) => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  subscribe(listener: (turn: GazeChatTurn) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  get(id: string) {
    return this.turns.get(id);
  }
  getGaze(id: string) {
    return this.gazes.get(id);
  }
  recent() {
    return [...this.turns.values()];
  }
  observe(inspection: GazeInspection) {
    if (!inspection.id || inspection.phase === 'idle') return;
    if (inspection.gaze)
      this.gazes.set(inspection.id, structuredClone(inspection.gaze));
    const previous = this.turns.get(inspection.id);
    const phase =
      inspection.phase === 'capturing'
        ? 'capturing'
        : inspection.phase === 'thinking'
          ? 'recognizing'
          : inspection.phase === 'error'
            ? /取消|关闭/.test(inspection.error || '')
              ? 'cancelled'
              : 'failed'
            : 'recognized';
    this.publish({
      ...previous,
      id: inspection.id,
      createdAt: previous?.createdAt || inspection.createdAt || Date.now(),
      updatedAt: Date.now(),
      trigger: inspection.intent || 'manual',
      question:
        inspection.intent === 'proactive'
          ? '我正在注视的区域'
          : inspection.question || '我在看什么？',
      preview: inspection.preview,
      answer: inspection.answer,
      phase,
      error: inspection.error,
    });
    if (phase === 'recognized') {
      const id = inspection.id;
      clearTimeout(this.timers.get(id));
      const timer = setTimeout(
        () =>
          this.speech(
            id,
            'failed',
            '识别完成，但结果没有进入语音播放。请点击重新播报。',
          ),
        30_000,
      );
      timer.unref?.();
      this.timers.set(id, timer);
    }
  }
  speech(id: string, phase: GazeChatPhase, error?: string) {
    const turn = this.turns.get(id);
    if (!turn) return;
    // Late audio receipts cannot resurrect a stopped or failed request.
    if (
      ['spoken', 'failed', 'cancelled'].includes(turn.phase) &&
      phase !== 'queued'
    )
      return;
    if (phase === 'spoken' && turn.phase !== 'playing') {
      phase = 'failed';
      error = '语音队列结束，但没有收到播放器启动确认。可以点击重新播报。';
    }
    if (turn.phase === phase && turn.error === error) return;
    this.publish({ ...turn, phase, error, updatedAt: Date.now() });
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    if (['queued', 'generating', 'audio', 'playing'].includes(phase)) {
      const timer = setTimeout(
        () => {
          this.speech(
            id,
            'failed',
            phase === 'playing'
              ? '播放器未确认播报结束，请检查输出设备后重播。'
              : '截图已识别，但语音等待超时；可以点击重新播报。',
          );
        },
        phase === 'playing' ? 120_000 : 30_000,
      );
      timer.unref?.();
      this.timers.set(id, timer);
    }
  }
  private publish(turn: GazeChatTurn) {
    this.turns.set(turn.id, turn);
    if (this.turns.size > 20) {
      const oldest = this.turns.keys().next().value!;
      clearTimeout(this.timers.get(oldest));
      this.timers.delete(oldest);
      this.turns.delete(oldest);
      this.gazes.delete(oldest);
    }
    this.listeners.forEach((listener) => listener({ ...turn }));
  }
}
export const gazeChat = new GazeChat();
