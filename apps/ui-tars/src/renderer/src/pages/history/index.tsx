import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { chatManager } from '@renderer/db/chat';
import { sessionManager, type SessionItem } from '@renderer/db/session';
import type { ConversationWithSoM } from '@main/shared/types';
import { ConversationMessages } from '@renderer/components/Conversation/ConversationMessages';
import { NewChatButton } from '@renderer/components/Conversation/NewChatButton';
import ChatInput from '@renderer/components/ChatInput';
import {
  checkVLMSettings,
  LocalSettingsDialog,
} from '@renderer/components/Settings/local';
import { ErrorMessage } from '@renderer/components/RunMessages/Messages';
import { useStore } from '@renderer/hooks/useStore';
import { useSessionStore } from '@renderer/store/session';
import { Operator } from '@main/store/types';
import { StatusEnum } from '@ui-tars/shared/types';

export default function HistoryPage() {
  const { id = '' } = useParams();
  const [record, setRecord] = useState<SessionItem | null>(null);
  const [messages, setMessages] = useState<ConversationWithSoM[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { thinking, status, errorMsg } = useStore();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const ownsRun = currentSessionId === id;
  const busy =
    thinking ||
    [StatusEnum.RUNNING, StatusEnum.PAUSE, StatusEnum.CALL_USER].includes(
      status,
    );
  const checkBeforeRun = async () => {
    const configured = await checkVLMSettings();
    if (!configured) setSettingsOpen(true);
    return configured;
  };
  useEffect(() => {
    const container = messageScrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [id, messages.length]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setRecord(null);
    setMessages([]);
    setError(false);
    setSettingsOpen(false);
    const refresh = async () => {
      try {
        const [session, rows] = await Promise.all([
          sessionManager.getSession(id),
          chatManager.getSessionMessages(id),
        ]);
        if (active) {
          setRecord(session ?? null);
          setMessages(rows ?? []);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      } finally {
        if (active) setLoading(false);
      }
    };
    void refresh();
    const channel = new BroadcastChannel('cyrvis-history');
    channel.onmessage = () => void refresh();
    return () => {
      active = false;
      channel.close();
    };
  }, [id]);
  if (loading)
    return (
      <p className="cyrvis-history-empty" role="status">
        Loading chat…
      </p>
    );
  if (error)
    return (
      <p className="cyrvis-history-empty" role="alert">
        Could not load this chat. Select it again to retry.
      </p>
    );
  if (!record)
    return <p className="cyrvis-history-empty">This chat no longer exists.</p>;
  return (
    <article className="cyrvis-conversation">
      <header className="cyrvis-conversation-header">
        <div>
          <h1>{record.name}</h1>
        </div>
        <NewChatButton />
      </header>
      <section className="cyrvis-chat-body" aria-label="Conversation">
        <div className="cyrvis-message-scroll" ref={messageScrollRef}>
          <div className="cyrvis-thread">
            {!messages.length && (
              <p className="cyrvis-history-empty">
                No messages in this chat yet.
              </p>
            )}
            <ConversationMessages
              messages={messages}
              status={
                ownsRun ? (thinking ? StatusEnum.RUNNING : status) : undefined
              }
            />
            {ownsRun && errorMsg && <ErrorMessage text={errorMsg} />}
          </div>
        </div>
        <div className="cyrvis-composer-area">
          {busy && !ownsRun && (
            <p className="mb-2 text-xs text-muted-foreground" role="status">
              Finish or stop the current task before continuing this chat.
            </p>
          )}
          <ChatInput
            voiceConversation={record.meta.source === 'companion'}
            key={id}
            sessionId={id}
            operator={record.meta.operator || Operator.LocalComputer}
            disabled={Boolean(busy && !ownsRun)}
            checkBeforeRun={checkBeforeRun}
          />
        </div>
      </section>
      <LocalSettingsDialog
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSubmit={() => setSettingsOpen(false)}
      />
    </article>
  );
}
