import { useState } from 'react';
import type { GazeChatTurn } from '@shared/cyrvis';

const labels: Record<GazeChatTurn['phase'], string> = {
  capturing: '正在截取注视区域',
  recognizing: '截图已收到，正在识别',
  recognized: '识别完成，等待交给语音',
  queued: '语音已接收，正在排队',
  generating: '正在生成语音',
  audio: '音频已收到，等待播放器启动',
  playing: '播放器已开始播报',
  spoken: '语音播报已结束',
  failed: '播报未完成',
  cancelled: '播报已停止',
};

export function GazeTurn({ turn }: { turn: GazeChatTurn }) {
  const [error, setError] = useState('');
  const [replaying, setReplaying] = useState(false);
  const busy = [
    'capturing',
    'recognizing',
    'queued',
    'generating',
    'audio',
    'playing',
  ].includes(turn.phase);
  const replay = async () => {
    setError('');
    setReplaying(true);
    try {
      const result = await window.electron.voice.replayGazeTurn(turn.id);
      if (!result.ok) setError(result.error || '暂时无法播报，请稍后重试。');
    } catch {
      setError('语音连接异常，请重新开启语音后重试。');
    } finally {
      setReplaying(false);
    }
  };
  return (
    <article
      className="my-4 overflow-hidden rounded-2xl border bg-white p-5 dark:bg-background"
      aria-label="注视截图对话"
    >
      <div className="mb-3 flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>
          注视截图 · {turn.trigger === 'proactive' ? '主动提醒' : '看屏提问'}
        </span>
        <time dateTime={new Date(turn.createdAt).toISOString()}>
          {new Date(turn.createdAt).toLocaleTimeString()}
        </time>
      </div>
      <p className="mb-3 font-medium">{turn.question}</p>
      {turn.preview && (
        <img
          src={turn.preview}
          alt="当次注视区域的实际截图"
          className="mb-4 max-h-72 max-w-full rounded-xl border object-contain"
        />
      )}
      {turn.answer && (
        <p className="mb-4 whitespace-pre-wrap leading-relaxed">
          {turn.answer}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-sm text-muted-foreground">
          {labels[turn.phase]}
        </p>
        {turn.answer && (
          <button
            type="button"
            className="rounded-lg border px-3 py-2 text-sm disabled:opacity-40"
            disabled={busy || replaying}
            onClick={() => void replay()}
          >
            {replaying ? '正在交给语音…' : '重新播报'}
          </button>
        )}
      </div>
      {(turn.error || error) && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error || turn.error}
        </p>
      )}
    </article>
  );
}
