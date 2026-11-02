// SPDX-License-Identifier: AGPL-3.0-only
import { SlidersHorizontalIcon } from '@phosphor-icons/react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogForm,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from '@/components/ui/responsive-dialog';
import { Spinner } from '@/components/ui/spinner';
import type { ChatRetentionDays } from '@openlive/protocol';
import { type Room, type Space, useUpdateRoom } from '../../api/spaces.ts';
import { ChatSettingsFields } from '../../chat/ChatSettingsFields.tsx';
import { CapabilityFields } from '../../components/capabilities/CapabilityFields.tsx';
import { ErrorText } from '../../components/QueryError.tsx';
import {
  aboveCeiling,
  ceilingOf,
  isValidCapabilities,
  sameCapabilities,
  STREAM_ONLY,
} from '../../lib/capabilities.ts';

/**
 * The room's capabilities, for the space's owners and admins.
 * Turning stream off ends the live streams. With text, the chat's retention and whether guests
 * write.
 */
export function RoomFeaturesDialog({
  room,
  space,
  liveStreams,
}: {
  room: Room;
  space: Space | null;
  liveStreams: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const stored = room.settings.capabilities ?? STREAM_ONLY;
  const [value, setValue] = useState(stored);
  const storedChat = {
    retention: room.settings.chatRetentionDays ?? 30,
    guestsCanWrite: room.settings.guestsCanWrite !== false,
  };
  const [chat, setChat] = useState<{ retention: ChatRetentionDays; guestsCanWrite: boolean }>(
    storedChat,
  );
  const chatChanged =
    chat.retention !== storedChat.retention || chat.guestsCanWrite !== storedChat.guestsCanWrite;
  const update = useUpdateRoom(room);
  const ceiling = ceilingOf(space?.effectiveSettings);
  const valid = isValidCapabilities(value) && aboveCeiling(value, ceiling).length === 0;
  const endsStreams = stored.stream && !value.stream && liveStreams > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      {
        settings: {
          capabilities: value,
          ...(value.text && chatChanged
            ? { chatRetentionDays: chat.retention, guestsCanWrite: chat.guestsCanWrite }
            : {}),
        },
      },
      {
        onSuccess: () => {
          setOpen(false);
          toast.success(t('room.features.saved'));
        },
      },
    );
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setValue(stored);
          setChat(storedChat);
        } else update.reset();
      }}
    >
      <ResponsiveDialogTrigger asChild>
        <Button variant="outline" data-tour="room-features">
          <SlidersHorizontalIcon data-icon="inline-start" />
          {t('room.features.action')}
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent className="max-h-[90dvh] overflow-y-auto">
        <ResponsiveDialogForm onSubmit={submit} className="flex flex-col gap-6">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>{t('room.features.title')}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {t('room.features.description')}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            <CapabilityFields value={value} onChange={setValue} ceiling={ceiling} />
            {value.text && (
              <ChatSettingsFields
                value={chat}
                onChange={setChat}
                ceiling={space?.effectiveSettings.chatRetentionDays ?? 90}
                quick={room.kind === 'quick'}
              />
            )}
            {endsStreams && (
              <Alert variant="destructive">
                <AlertDescription>{t('room.features.streamOff')}</AlertDescription>
              </Alert>
            )}
            <ErrorText error={update.error} />
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button
              type="submit"
              disabled={
                !valid ||
                (sameCapabilities(value, stored) && !(value.text && chatChanged)) ||
                update.isPending
              }
            >
              {update.isPending && <Spinner data-icon="inline-start" />}
              {t('common.save')}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogForm>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
