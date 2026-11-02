// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ChangeEvent, type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import {
  DISPLAY_NAME_MAX,
  meQuery,
  removeAvatar,
  restoreDiscordAvatar,
  updateMe,
  uploadAvatar,
  type AvatarState,
  type User,
} from '../api/auth.ts';
import { errorBodyOf } from '../api/client.ts';
import { translateError } from '../i18n/errors.ts';
import {
  AVATAR_INPUT_TYPES,
  avatarFileProblem,
  loadImage,
  MAX_ZOOM,
  renderAvatar,
} from '../lib/avatar-image.ts';

/** Settings → Profile: the display name and the photo others see (docs/PROTOCOL.md 11.5). */
export function ProfileCard() {
  const { t } = useTranslation();
  const me = useQuery(meQuery);
  const user = me.data?.user;
  return (
    <Card data-testid="profile-card">
      <CardHeader>
        <CardTitle>{t('settings.profile.title')}</CardTitle>
        <CardDescription>{t('settings.profile.description')}</CardDescription>
      </CardHeader>
      {user && (
        <CardContent>
          <FieldGroup>
            <NameField user={user} />
            <FieldSeparator />
            <PhotoField user={user} avatar={me.data?.avatar} />
          </FieldGroup>
        </CardContent>
      )}
    </Card>
  );
}

/** Why a typed name cannot be saved, as the API checks it (trimmed, 1 to 80 characters). */
function nameProblem(value: string): 'required' | 'tooLong' | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'required';
  if (trimmed.length > DISPLAY_NAME_MAX) return 'tooLong';
  return null;
}

function NameField({ user }: { user: User }) {
  const { t } = useTranslation();
  const id = useId();
  const [value, setValue] = useState(user.displayName);
  const [touched, setTouched] = useState(false);
  const save = useMutation({
    mutationFn: (displayName: string) => updateMe({ displayName }),
    onSuccess: (saved) => {
      setValue(saved.displayName);
      setTouched(false);
      toast.success(t('settings.profile.name.saved'));
    },
  });
  const problem = nameProblem(value);
  const unchanged = value.trim() === user.displayName;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem || unchanged) return;
    save.mutate(value.trim());
  };
  return (
    <form onSubmit={submit} noValidate>
      <Field data-invalid={touched && problem ? true : undefined}>
        <FieldLabel htmlFor={id}>{t('settings.profile.name.label')}</FieldLabel>
        <FieldDescription>
          {t('settings.profile.name.description', { max: DISPLAY_NAME_MAX })}
        </FieldDescription>
        <div className="flex gap-2">
          <Input
            id={id}
            value={value}
            autoComplete="nickname"
            aria-invalid={touched && problem ? true : undefined}
            onChange={(event) => {
              setValue(event.target.value);
              setTouched(true);
              save.reset();
            }}
          />
          <Button type="submit" disabled={unchanged || problem !== null || save.isPending}>
            {t('common.save')}
          </Button>
        </div>
        {touched && problem && (
          <FieldError>
            {t(`settings.profile.name.${problem}`, { max: DISPLAY_NAME_MAX })}
          </FieldError>
        )}
        {save.isError && <FieldError>{translateError(errorBodyOf(save.error), t)}</FieldError>}
      </Field>
    </form>
  );
}

interface Draft {
  image: ImageBitmap;
  zoom: number;
  photo: Blob | null;
  previewUrl: string | null;
}

function PhotoField({ user, avatar }: { user: User; avatar: AvatarState | undefined }) {
  const { t } = useTranslation();
  const zoomId = useId();
  // Offered while the shown photo is not already the Discord one.
  const offerDiscord =
    avatar?.discordAvailable === true && !(avatar.source === 'discord' && user.avatarUrl);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The preview follows the zoom; each render replaces the previous object URL.
  const image = draft?.image;
  const zoom = draft?.zoom;
  useEffect(() => {
    if (!image || zoom === undefined) return;
    let cancelled = false;
    let url: string | null = null;
    renderAvatar(image, zoom).then(
      (photo) => {
        if (cancelled) return;
        url = URL.createObjectURL(photo);
        setDraft((d) => (d && d.image === image ? { ...d, photo, previewUrl: url } : d));
      },
      () => {
        if (!cancelled) setProblem(t('settings.profile.photo.unreadable'));
      },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [image, zoom, t]);

  const done = (message: string) => {
    setDraft(null);
    toast.success(message);
  };
  const upload = useMutation({
    mutationFn: uploadAvatar,
    onSuccess: () => done(t('settings.profile.photo.saved')),
  });
  const remove = useMutation({
    mutationFn: removeAvatar,
    onSuccess: () => done(t('settings.profile.photo.removed')),
  });
  const discord = useMutation({
    mutationFn: restoreDiscordAvatar,
    onSuccess: () => done(t('settings.profile.photo.discordSet')),
  });
  const pending = upload.isPending || remove.isPending || discord.isPending;
  const failed = upload.error ?? remove.error ?? discord.error;

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setProblem(null);
    upload.reset();
    const fileProblem = avatarFileProblem(file);
    if (fileProblem) {
      setProblem(t(`settings.profile.photo.${fileProblem === 'type' ? 'badType' : 'tooBig'}`));
      return;
    }
    try {
      setDraft({ image: await loadImage(file), zoom: 1, photo: null, previewUrl: null });
    } catch {
      setProblem(t('settings.profile.photo.unreadable'));
    }
  };

  return (
    <Field>
      <FieldLabel>{t('settings.profile.photo.label')}</FieldLabel>
      <FieldDescription>{t('settings.profile.photo.description')}</FieldDescription>
      <input
        ref={inputRef}
        type="file"
        accept={AVATAR_INPUT_TYPES.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="avatar-file"
        onChange={(event) => void choose(event)}
      />
      {draft ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <div className="size-20 shrink-0 overflow-hidden rounded-full border bg-muted">
              {draft.previewUrl && (
                <img
                  src={draft.previewUrl}
                  alt={t('settings.profile.photo.preview')}
                  className="size-full object-cover"
                />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="text-[0.8125rem] text-muted-foreground" id={zoomId}>
                {t('settings.profile.photo.zoom')}
              </span>
              <Slider
                min={1}
                max={MAX_ZOOM}
                step={0.05}
                value={[draft.zoom]}
                aria-labelledby={zoomId}
                onValueChange={([next]) =>
                  setDraft((d) => (d && next !== undefined ? { ...d, zoom: next } : d))
                }
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!draft.photo || pending}
              onClick={() => draft.photo && upload.mutate(draft.photo)}
            >
              {t('settings.profile.photo.save')}
            </Button>
            <Button variant="outline" disabled={pending} onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <Avatar className="size-16" data-testid="profile-avatar">
            {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
            <AvatarFallback className="text-xl">
              {user.displayName.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={pending} onClick={() => inputRef.current?.click()}>
              {t(
                user.avatarUrl ? 'settings.profile.photo.change' : 'settings.profile.photo.upload',
              )}
            </Button>
            {user.avatarUrl && (
              <Button variant="outline" disabled={pending} onClick={() => remove.mutate()}>
                {t('settings.profile.photo.remove')}
              </Button>
            )}
            {offerDiscord && (
              <Button variant="outline" disabled={pending} onClick={() => discord.mutate()}>
                {t('settings.profile.photo.discord')}
              </Button>
            )}
          </div>
        </div>
      )}
      {problem && <FieldError>{problem}</FieldError>}
      {failed && <FieldError>{translateError(errorBodyOf(failed), t)}</FieldError>}
    </Field>
  );
}
