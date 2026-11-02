// SPDX-License-Identifier: AGPL-3.0-only
import {
  CaretRightIcon,
  ChatsIcon,
  DoorIcon,
  LightningIcon,
  LockIcon,
  PlusIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { unreadLabel, useChatUnread } from '../../chat/api.ts';
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { errorBodyOf } from '../../api/client.ts';
import {
  type Room,
  roomsQuery,
  type Space,
  useCreateFixedRoom,
  useCreateQuickRoom,
} from '../../api/spaces.ts';
import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorText, QueryError } from '../../components/QueryError.tsx';
import { useNow } from '../../hooks/use-now.ts';
import { translateError } from '../../i18n/errors.ts';
import { TemplatePicker } from '../../components/capabilities/CapabilityFields.tsx';
import {
  aboveCeiling,
  ceilingOf,
  isValidCapabilities,
  type Template,
  TEMPLATES,
} from '../../lib/capabilities.ts';
import { SLUG_PATTERN, slugify } from '../../lib/slug.ts';
import { Countdown } from '../room/Countdown.tsx';

/**
 * A quick room's join code. Rooms opened before codes were stored show their slug, which
 * was the code in lowercase.
 */
export const quickCode = (room: Pick<Room, 'code' | 'slug'>) =>
  room.code ?? room.slug.toUpperCase();

export function RoomsTab({ space }: { space: Space }) {
  const { t } = useTranslation();
  const rooms = useQuery(roomsQuery(space.id));
  const now = useNow();
  if (rooms.isPending) return <Skeleton className="h-28 w-full" />;
  if (rooms.isError) {
    return <QueryError error={rooms.error} onRetry={() => void rooms.refetch()} />;
  }
  const open = rooms.data.filter(
    (room) => room.archivedAt === null && (room.expiresAt === null || room.expiresAt > now),
  );
  const fixed = open.filter((room) => room.kind === 'fixed');
  const quick = open.filter((room) => room.kind === 'quick');
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-labelledby="fixed-rooms">
        <h2 id="fixed-rooms" className="eyebrow text-muted-foreground">
          {t('space.rooms.fixed')}
        </h2>
        {fixed.length === 0 ? (
          <EmptyState
            icon={DoorIcon}
            title={t('space.rooms.emptyFixed.title')}
            description={t('space.rooms.emptyFixed.description')}
          />
        ) : (
          <RoomList space={space} rooms={fixed} />
        )}
      </section>
      <section className="flex flex-col gap-3" aria-labelledby="quick-rooms">
        <h2 id="quick-rooms" className="eyebrow text-muted-foreground">
          {t('space.rooms.quick')}
        </h2>
        {quick.length === 0 ? (
          <p className="text-[0.9375rem] text-muted-foreground">{t('space.rooms.emptyQuick')}</p>
        ) : (
          <RoomList space={space} rooms={quick} />
        )}
      </section>
    </div>
  );
}

function RoomList({ space, rooms }: { space: Space; rooms: Room[] }) {
  const { t } = useTranslation();
  const unread = useChatUnread(space.id);
  return (
    <ul className="flex flex-col divide-y rounded-xl border">
      {rooms.map((room) => (
        <li key={room.id}>
          <Link
            to="/s/$spaceSlug/r/$roomSlug"
            params={{ spaceSlug: space.slug, roomSlug: room.slug }}
            className="flex items-center gap-3 px-4 py-2 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 md:px-6"
          >
            {room.kind === 'quick' ? (
              <LightningIcon className="shrink-0 text-muted-foreground" aria-hidden />
            ) : room.visibility === 'restricted' ? (
              <LockIcon className="shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <DoorIcon className="shrink-0 text-muted-foreground" aria-hidden />
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[0.9375rem] font-medium">{room.name}</span>
              <span className="truncate font-mono text-[0.8125rem] text-muted-foreground">
                {room.kind === 'quick' ? (
                  <>
                    {quickCode(room)}
                    {room.expiresAt !== null && (
                      <>
                        {' · '}
                        <Countdown expiresAt={room.expiresAt} />
                      </>
                    )}
                  </>
                ) : (
                  `/s/${space.slug}/r/${room.slug}`
                )}
              </span>
            </div>
            {room.visibility === 'restricted' && (
              <Badge variant="outline">{t('space.rooms.restricted')}</Badge>
            )}
            {(unread[room.id] ?? 0) > 0 && (
              <Badge
                aria-label={t('chat.unread', { count: unread[room.id] ?? 0 })}
                data-testid="room-unread"
              >
                <ChatsIcon data-icon="inline-start" aria-hidden />
                {unreadLabel(unread[room.id] ?? 0)}
              </Badge>
            )}
            <CaretRightIcon className="shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** One click: opens a quick room with a code and goes there. */
export function QuickRoomButton({ space }: { space: Space }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateQuickRoom(space.id);
  const open = () =>
    create.mutate(undefined, {
      onSuccess: ({ room, code }) => {
        toast.success(t('space.rooms.quickCreated', { code }));
        void navigate({
          to: '/s/$spaceSlug/r/$roomSlug',
          params: { spaceSlug: space.slug, roomSlug: room.slug },
        });
      },
      onError: (error) => toast.error(translateError(errorBodyOf(error), t)),
    });
  return (
    <Button
      variant="outline"
      disabled={create.isPending}
      onClick={open}
      data-tour="space-quick-room"
    >
      {create.isPending ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <LightningIcon data-icon="inline-start" />
      )}
      {t('space.rooms.quickAction')}
    </Button>
  );
}

/**
 * The template a new room starts from: "Watch together", or the
 * first one the space allows.
 */
function firstTemplate(space: Space): Exclude<Template, 'custom'> {
  const ceiling = ceilingOf(space.effectiveSettings);
  const ids = Object.keys(TEMPLATES) as Exclude<Template, 'custom'>[];
  return ids.find((id) => aboveCeiling(TEMPLATES[id], ceiling).length === 0) ?? 'watchTogether';
}

export function CreateFixedRoomDialog({ space }: { space: Space }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateFixedRoom(space.id);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<'space' | 'restricted'>('space');
  const [template, setTemplate] = useState<Template>(() => firstTemplate(space));
  const [capabilities, setCapabilities] = useState(() => TEMPLATES[firstTemplate(space)]);
  const effectiveSlug = slug ?? slugify(name);
  const slugValid = SLUG_PATTERN.test(effectiveSlug);
  const ceiling = ceilingOf(space.effectiveSettings);
  const capabilitiesValid =
    isValidCapabilities(capabilities) && aboveCeiling(capabilities, ceiling).length === 0;

  const reset = () => {
    setName('');
    setSlug(null);
    setVisibility('space');
    setTemplate(firstTemplate(space));
    setCapabilities(TEMPLATES[firstTemplate(space)]);
    create.reset();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name: name.trim(), slug: effectiveSlug, visibility, settings: { capabilities } },
      {
        onSuccess: (room) => {
          setOpen(false);
          reset();
          void navigate({
            to: '/s/$spaceSlug/r/$roomSlug',
            params: { spaceSlug: space.slug, roomSlug: room.slug },
          });
        },
      },
    );
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <ResponsiveDialogTrigger asChild>
        <Button data-tour="space-create-room">
          <PlusIcon data-icon="inline-start" />
          {t('space.rooms.createAction')}
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent className="max-h-[90dvh] overflow-y-auto">
        <ResponsiveDialogForm onSubmit={submit} className="flex flex-col gap-6">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>{t('space.rooms.create.title')}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {t('space.rooms.create.description')}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="room-name">{t('space.rooms.create.name')}</FieldLabel>
                <Input
                  id="room-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  required
                  autoFocus
                />
              </Field>
              <Field data-invalid={effectiveSlug !== '' && !slugValid ? true : undefined}>
                <FieldLabel htmlFor="room-slug">{t('space.rooms.create.slug')}</FieldLabel>
                <Input
                  id="room-slug"
                  value={effectiveSlug}
                  onChange={(event) => setSlug(event.target.value.toLowerCase())}
                  aria-invalid={effectiveSlug !== '' && !slugValid}
                  className="font-mono"
                  maxLength={48}
                  required
                />
                <FieldDescription>
                  {t('spaces.create.slugHint', {
                    path: `/s/${space.slug}/r/${effectiveSlug || '…'}`,
                  })}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel id="room-visibility">{t('space.rooms.create.visibility')}</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={visibility}
                  onValueChange={(value) => {
                    if (value === 'space' || value === 'restricted') setVisibility(value);
                  }}
                  aria-labelledby="room-visibility"
                >
                  <ToggleGroupItem value="space">
                    {t('space.rooms.visibility.space')}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="restricted">
                    {t('space.rooms.visibility.restricted')}
                  </ToggleGroupItem>
                </ToggleGroup>
                <FieldDescription>{t(`space.rooms.visibility.${visibility}Hint`)}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel id="room-capabilities">{t('capabilities.templates.label')}</FieldLabel>
                <TemplatePicker
                  template={template}
                  value={capabilities}
                  ceiling={ceiling}
                  onChange={(nextTemplate, next) => {
                    setTemplate(nextTemplate);
                    setCapabilities(next);
                  }}
                />
              </Field>
            </FieldGroup>
            <ErrorText error={create.error} />
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button
              type="submit"
              disabled={!name.trim() || !slugValid || !capabilitiesValid || create.isPending}
            >
              {create.isPending && <Spinner data-icon="inline-start" />}
              {t('space.rooms.create.submit')}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogForm>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
