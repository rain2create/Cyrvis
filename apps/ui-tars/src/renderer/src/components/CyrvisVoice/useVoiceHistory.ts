import { getState } from '@renderer/hooks/useStore';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { sessionManager } from '@renderer/db/session';
import { chatManager } from '@renderer/db/chat';
import { Operator } from '@main/store/types';
import type { ControllerEvent } from '@main/cyrvis/types';
import type { ConversationWithSoM } from '@main/shared/types';
import { taskDisplayInstruction } from '@shared/cyrvis';

/** Only mounted by the audio owner, so each finalized event is saved once. */
export function useVoiceHistory() {
  const navigate = useNavigate();
  // React Router changes navigate's identity with the current location. The
  // microphone/history owner must outlive those page changes.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const channel = new BroadcastChannel('cyrvis-history');
    let sessionId: string | null = null;
    let queue = Promise.resolve();
    const gazeSessions = new Map<string, string>();
    try {
      sessionId = sessionStorage.getItem('cyrvis.voice-history-session');
      const stored = JSON.parse(
        sessionStorage.getItem('cyrvis.gaze-history-sessions') || '[]',
      );
      if (Array.isArray(stored))
        for (const row of stored.slice(-128)) {
          if (
            Array.isArray(row) &&
            row.length === 2 &&
            row.every((value) => typeof value === 'string')
          )
            gazeSessions.set(row[0], row[1]);
        }
    } catch {
      /* Storage recovery must not interrupt capture or chat. */
    }
    const openedGaze = new Set<string>();
    let disposed = false;
    const append = (message: ConversationWithSoM, title?: string) => {
      queue = queue
        .then(async () => {
          const gazeId = message.gazeTurn?.id;
          let targetSessionId =
            (gazeId && gazeSessions.get(gazeId)) || sessionId;
          if (
            !targetSessionId ||
            !(await sessionManager.getSession(targetSessionId))
          ) {
            const session = await sessionManager.createSession(
              (title === '我正在注视的区域'
                ? '与 Cyrvis 的对话'
                : title || message.value
              ).slice(0, 60),
              { operator: Operator.LocalComputer, source: 'companion' },
            );
            targetSessionId = session.id;
          }
          if (!gazeId || !gazeSessions.has(gazeId)) sessionId = targetSessionId;
          if (gazeId) gazeSessions.set(gazeId, targetSessionId);
          try {
            if (sessionId)
              sessionStorage.setItem('cyrvis.voice-history-session', sessionId);
            sessionStorage.setItem(
              'cyrvis.gaze-history-sessions',
              JSON.stringify([...gazeSessions].slice(-128)),
            );
          } catch {
            /* Keep the live in-memory conversation available. */
          }
          const messages =
            (await chatManager.getSessionMessages(targetSessionId)) ?? [];
          const index = gazeId
            ? messages.findIndex((row) => row.gazeTurn?.id === gazeId)
            : -1;
          const updated =
            index < 0
              ? [...messages, message]
              : messages.map((row, i) => (i === index ? message : row));
          await chatManager.updateSessionMessages(targetSessionId, updated);
          await sessionManager.updateSession(targetSessionId, {});
          channel.postMessage({ sessionId: targetSessionId, gazeId });
          if (
            !disposed &&
            gazeId &&
            message.gazeTurn?.preview &&
            !openedGaze.has(gazeId)
          ) {
            openedGaze.add(gazeId);
            navigateRef.current(`/history/${targetSessionId}`, {
              replace: true,
            });
          }
          setError(null);
        })
        .catch(() =>
          setError('Could not save history. Check your local storage space.'),
        );
    };
    const reset = () => {
      queue = queue.then(() => {
        sessionId = null;
        try {
          sessionStorage.removeItem('cyrvis.voice-history-session');
        } catch {}
      });
    };
    const cleanups = [
      window.electron.voice.onGazeTurn((turn) =>
        append(
          { from: 'human', value: turn.question, gazeTurn: turn },
          turn.question,
        ),
      ),
      window.electron.voice.onTranscript(({ text, final }) => {
        if (final && text.trim()) append({ from: 'human', value: text });
      }),
      window.electron.voice.onAssistantText((payload) => {
        const { text, final } = payload;
        if (
          final &&
          text.trim() &&
          !(payload as { gazeTurnId?: string }).gazeTurnId
        )
          append({ from: 'gpt', value: text });
      }),
      window.electron.voice.onTaskEvent((raw) => {
        const event = raw as ControllerEvent;
        if (event.type === 'task_started')
          append(
            {
              from: 'gpt',
              value: `Starting task: ${taskDisplayInstruction(event.instruction)}`,
            },
            taskDisplayInstruction(event.instruction),
          );
        if (event.type === 'step_update')
          append({
            ...[...(getState().messages || [])]
              .reverse()
              .find(
                (message) =>
                  message.screenshotBase64 ||
                  message.screenshotBase64WithElementMarker,
              ),
            from: 'gpt',
            value: `Step ${event.step} · ${event.actionType}\n\n${event.summary}`,
          });
        if (event.type === 'task_done')
          append({ from: 'gpt', value: `Task completed\n\n${event.summary}` });
        if (event.type === 'task_failed')
          append({ from: 'gpt', value: `Task failed\n\n${event.error}` });
        if (event.type === 'task_cancelled')
          append({ from: 'gpt', value: 'Task cancelled' });
        if (event.type === 'task_needs_user')
          append({ from: 'gpt', value: event.question });
      }),
    ];
    // Idle sleep belongs to the voice state, not the chat lifetime. Only an
    // explicit New chat action starts a fresh history session.
    window.addEventListener('cyrvis:new-chat', reset);
    void window.electron.voice
      .getGazeTurns()
      .then((turns) => {
        if (!disposed)
          turns.forEach((turn) => {
            openedGaze.add(turn.id);
            append(
              { from: 'human', value: turn.question, gazeTurn: turn },
              turn.question,
            );
          });
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      window.removeEventListener('cyrvis:new-chat', reset);
      cleanups.forEach((cleanup) => cleanup());
      void queue.finally(() => channel.close());
    };
  }, []);
  return error;
}
