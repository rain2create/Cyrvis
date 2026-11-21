import { useState } from 'react';
import { useNavigate } from 'react-router';
import { MessageCirclePlus } from 'lucide-react';
import { toast } from 'sonner';
import { StatusEnum } from '@ui-tars/shared/types';
import { Operator } from '@main/store/types';
import { getState, useStore } from '@renderer/hooks/useStore';
import { useSessionStore } from '@renderer/store/session';
import { api } from '@renderer/api';
import { Button } from '../ui/button';

export function NewChatButton({ className }: { className?: string }) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const { thinking, status } = useStore();
  const busy =
    thinking ||
    [StatusEnum.RUNNING, StatusEnum.PAUSE, StatusEnum.CALL_USER].includes(
      status,
    );
  const createChat = async () => {
    const live = getState();
    if (
      creating ||
      live.thinking ||
      [StatusEnum.RUNNING, StatusEnum.PAUSE, StatusEnum.CALL_USER].includes(
        live.status,
      )
    )
      return;
    setCreating(true);
    try {
      // Keep this as a draft route. The session is created only when the user
      // sends the first non-empty message.
      await api.clearHistory();
      window.dispatchEvent(new Event('cyrvis:new-chat'));
      const store = useSessionStore.getState();
      store.setCurrentSessionId('');
      store.setChatMessages([]);
      navigate('/local', {
        state: {
          operator: Operator.LocalComputer,
          from: 'new',
        },
      });
    } catch {
      toast.error('Could not create a chat. Please try again.');
    } finally {
      setCreating(false);
    }
  };
  return (
    <Button
      variant="outline"
      className={className}
      onClick={() => void createChat()}
      disabled={creating || busy}
      title={
        busy
          ? 'Finish or stop the current task before starting a new chat.'
          : 'Start a new chat'
      }
    >
      <MessageCirclePlus size={16} />
      {creating ? 'Opening…' : 'New chat'}
    </Button>
  );
}
