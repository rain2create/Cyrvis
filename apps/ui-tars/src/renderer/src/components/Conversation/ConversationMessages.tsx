import { Check, ChevronRight, CircleDot, Copy, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ConversationWithSoM } from '@main/shared/types';
import { conversationTurns } from '@shared/conversation-view';
import type { Status } from '@ui-tars/shared/types';
import logo from '@resources/logo-vector.svg?url';
import { Button } from '../ui/button';
import { Markdown } from '../markdown';
import { GazeTurn } from './GazeTurn';

const statusLabels: Partial<Record<Status, string>> = {
  running: 'Working on your request…',
  pause: 'Task paused',
  call_user: 'Waiting for your input',
  error: 'Task could not finish',
  user_stopped: 'Task stopped',
  max_loop: 'Task reached its step limit',
};

function AssistantTurn({
  actions,
  answers,
  status,
}: {
  actions: string[];
  answers: string[];
  status?: Status;
}) {
  const active =
    status === 'running' || status === 'pause' || status === 'call_user';
  const [expanded, setExpanded] = useState(active);
  const [copied, setCopied] = useState(false);
  const answer = answers.join('\n\n');
  const statusLabel = status && statusLabels[status];
  useEffect(() => {
    setExpanded(active);
  }, [active]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copyAnswer = async () => {
    try {
      await navigator.clipboard.writeText(answer);
      setCopied(true);
    } catch {
      toast.error('Could not copy this answer. Select the text to copy it.');
    }
  };
  return (
    <article className="cyrvis-assistant-turn">
      <div className="cyrvis-assistant-author">
        <img src={logo} alt="" />
        <span>Cyrvis</span>
      </div>
      {actions.length > 0 && (
        <details
          className="cyrvis-processing"
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary>
            <CircleDot aria-hidden="true" />
            <span>{active ? 'Processing progress' : 'Processing summary'}</span>
            <span>
              {actions.length} recorded{' '}
              {actions.length === 1 ? 'action' : 'actions'}
            </span>
            <ChevronRight
              className="cyrvis-processing-chevron"
              aria-hidden="true"
            />
          </summary>
          <ol className="cyrvis-processing-steps">
            {actions.map((action, index) => (
              <li key={index}>
                <span>{index + 1}</span>
                {action}
              </li>
            ))}
          </ol>
        </details>
      )}
      {statusLabel && (
        <p className="cyrvis-run-status" role="status">
          {status === 'running' && (
            <Loader2 className="animate-spin" aria-hidden="true" />
          )}
          {statusLabel}
        </p>
      )}
      {answer && (
        <div className="cyrvis-answer">
          <Markdown>{answer.replace(/\\n/g, '\n')}</Markdown>
        </div>
      )}
      {answer && (
        <div className="cyrvis-answer-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void copyAnswer()}
            aria-label="Copy answer"
          >
            {copied ? (
              <Check aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
      {!answer && !statusLabel && (
        <p className="cyrvis-run-status">No final answer was recorded.</p>
      )}
    </article>
  );
}

/** Live and saved chats share the same single-column presentation. */
export function ConversationMessages({
  messages,
  status,
}: {
  messages: ConversationWithSoM[];
  status?: Status;
}) {
  const turns = conversationTurns(messages);
  if (status && statusLabels[status] && turns.at(-1)?.role !== 'assistant')
    turns.push({ role: 'assistant', actions: [], answers: [] });
  return (
    <div className="cyrvis-message-list">
      {turns.map((turn, index) =>
        turn.gazeTurn ? (
          <GazeTurn key={turn.gazeTurn.id} turn={turn.gazeTurn} />
        ) : turn.role === 'human' ? (
          <div className="cyrvis-human-turn" key={index}>
            <div>{turn.text}</div>
          </div>
        ) : (
          <AssistantTurn
            key={index}
            actions={turn.actions}
            answers={turn.answers}
            status={index === turns.length - 1 ? status : undefined}
          />
        ),
      )}
    </div>
  );
}
