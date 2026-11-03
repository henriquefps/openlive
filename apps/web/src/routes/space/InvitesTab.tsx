// SPDX-License-Identifier: AGPL-3.0-only
import { CheckIcon, CopyIcon, EnvelopeSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogForm,
  ResponsiveDialogHeader,
  ResponsiveDialogPanel,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from '@/components/ui/responsive-dialog';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { spaceAbilities } from '@openlive/client';
import {
  type Invite,
  invitesQuery,
  inviteUrl,
  roomsQuery,
  type Space,
  useCreateInvite,
  useRevokeInvite,
} from '../../api/spaces.ts';
import { EmptyState } from '../../components/EmptyState.tsx';
import { ErrorText, QueryError } from '../../components/QueryError.tsx';
import { formatDate } from '../../i18n/format.ts';

export function InvitesTab({ space }: { space: Space }) {
  const { t } = useTranslation();
  const invites = useQuery(invitesQuery(space.id));
  const rooms = useQuery(roomsQuery(space.id));
  const abilities = spaceAbilities(space);
  const canCreate = abilities.inviteGuests || abilities.inviteMembers;
  const roomName = (roomId: string | null) =>
    roomId === null ? null : (rooms.data?.find((r) => r.id === roomId)?.name ?? roomId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.9375rem] text-muted-foreground">{t('space.invites.intro')}</p>
        {canCreate && <CreateInviteDialog space={space} />}
      </div>
      {invites.isPending ? (
        <Skeleton className="h-28 w-full" />
      ) : invites.isError ? (
        <QueryError error={invites.error} onRetry={() => void invites.refetch()} />
      ) : invites.data.length === 0 ? (
        <EmptyState
          icon={EnvelopeSimpleIcon}
          title={t('space.invites.empty.title')}
          description={t('space.invites.empty.description')}
        />
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {invites.data.map((invite) => (
            <InviteRow
              key={invite.id}
              space={space}
              invite={invite}
              roomName={roomName(invite.roomId)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function InviteRow({
  space,
  invite,
  roomName,
}: {
  space: Space;
  invite: Invite;
  roomName: string | null;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const revoke = useRevokeInvite(space.id);
  return (
    <li className="flex items-center gap-3 px-4 py-2 md:px-6">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-2 text-[0.9375rem]">
          <span className="font-medium">
            {roomName
              ? t('space.invites.toRoom', { room: roomName })
              : t(`space.invites.toSpace.${invite.role}`)}
          </span>
          {invite.canStream && <Badge variant="outline">{t('space.invites.canStream')}</Badge>}
          {invite.requiresApproval && (
            <Badge variant="outline">{t('space.invites.approval')}</Badge>
          )}
        </span>
        <span className="text-[0.8125rem] text-muted-foreground">
          {t('space.invites.meta', {
            uses: invite.uses,
            maxUses: invite.maxUses,
            date: formatDate(invite.expiresAt, locale, { dateStyle: 'medium', timeStyle: 'short' }),
          })}
        </span>
        <ErrorText error={revoke.error} />
      </div>
      <Button
        variant="outline"
        disabled={revoke.isPending}
        onClick={() => revoke.mutate(invite.id)}
      >
        {t('space.invites.revoke')}
      </Button>
    </li>
  );
}

const EXPIRY_HOURS = [1, 24, 168, 720] as const;

const asInviteRole = (value: string): 'member' | 'guest' =>
  value === 'member' ? 'member' : 'guest';

export function CreateInviteDialog({ space }: { space: Space }) {
  const { t } = useTranslation();
  const abilities = spaceAbilities(space);
  const rooms = useQuery(roomsQuery(space.id));
  const create = useCreateInvite(space.id);
  const [open, setOpen] = useState(false);
  const [roomId, setRoomId] = useState<string>('');
  const [role, setRole] = useState<'member' | 'guest'>('guest');
  const [canStream, setCanStream] = useState(false);
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [maxUses, setMaxUses] = useState('1');
  const [expiresInHours, setExpiresInHours] = useState('168');
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const roomInvite = roomId !== '';
  const uses = Number(maxUses);
  const usesValid = Number.isInteger(uses) && uses >= 1 && uses <= 1000;

  const reset = () => {
    setRoomId('');
    setRole('guest');
    setCanStream(false);
    setRequiresApproval(false);
    setMaxUses('1');
    setExpiresInHours('168');
    setToken(null);
    setCopied(false);
    create.reset();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      {
        roomId: roomInvite ? roomId : null,
        role: roomInvite ? 'guest' : role,
        canStream: roomInvite && canStream,
        requiresApproval,
        maxUses: uses,
        expiresInHours: Number(expiresInHours),
      },
      { onSuccess: (result) => setToken(result.token) },
    );
  };

  const link = token ? inviteUrl(token) : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success(t('space.invites.copied'));
    } catch {
      toast.error(t('space.invites.copyFailed'));
    }
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
        <Button>
          <PlusIcon data-icon="inline-start" />
          {t('space.invites.create.action')}
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        {token ? (
          <ResponsiveDialogPanel className="flex flex-col gap-6">
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>{t('space.invites.created.title')}</ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                {t('space.invites.created.description')}
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
            <ResponsiveDialogBody>
              <InputGroup>
                <InputGroupInput
                  readOnly
                  value={link}
                  aria-label={t('space.invites.created.link')}
                  className="font-mono"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton onClick={() => void copy()}>
                    {copied ? (
                      <CheckIcon data-icon="inline-start" />
                    ) : (
                      <CopyIcon data-icon="inline-start" />
                    )}
                    {t('space.invites.copy')}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              <Alert>
                <AlertTitle>{t('space.invites.created.onceTitle')}</AlertTitle>
                <AlertDescription>{t('space.invites.created.once')}</AlertDescription>
              </Alert>
            </ResponsiveDialogBody>
            <ResponsiveDialogFooter cancel={false}>
              <Button onClick={() => setOpen(false)}>{t('common.done')}</Button>
            </ResponsiveDialogFooter>
          </ResponsiveDialogPanel>
        ) : (
          <ResponsiveDialogForm onSubmit={submit} className="flex flex-col gap-6">
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>{t('space.invites.create.title')}</ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                {t('space.invites.create.description')}
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
            <ResponsiveDialogBody>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="invite-target">
                    {t('space.invites.create.target')}
                  </FieldLabel>
                  <Select
                    value={roomId === '' ? 'space' : roomId}
                    onValueChange={(value) => setRoomId(value === 'space' ? '' : value)}
                  >
                    <SelectTrigger id="invite-target" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="space">
                          {t('space.invites.create.wholeSpace')}
                        </SelectItem>
                        {rooms.data
                          ?.filter((room) => room.kind === 'fixed')
                          .map((room) => (
                            <SelectItem key={room.id} value={room.id}>
                              {t('space.invites.toRoom', { room: room.name })}
                            </SelectItem>
                          ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {roomInvite
                      ? t('space.invites.create.roomHint')
                      : t('space.invites.create.spaceHint')}
                  </FieldDescription>
                </Field>
                {!roomInvite && (
                  <Field>
                    <FieldLabel htmlFor="invite-role">{t('space.invites.create.role')}</FieldLabel>
                    <Select value={role} onValueChange={(value) => setRole(asInviteRole(value))}>
                      <SelectTrigger id="invite-role" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="guest">{t('roles.guest')}</SelectItem>
                          {abilities.inviteMembers && (
                            <SelectItem value="member">{t('roles.member')}</SelectItem>
                          )}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      {t(`space.invites.create.roleHint.${role}`)}
                    </FieldDescription>
                  </Field>
                )}
                {roomInvite && (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="invite-stream">
                        {t('space.invites.create.canStream')}
                      </FieldLabel>
                      <FieldDescription>{t('space.invites.create.canStreamHint')}</FieldDescription>
                    </FieldContent>
                    <Switch id="invite-stream" checked={canStream} onCheckedChange={setCanStream} />
                  </Field>
                )}
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="invite-approval">
                      {t('space.invites.create.approval')}
                    </FieldLabel>
                    <FieldDescription>{t('space.invites.create.approvalHint')}</FieldDescription>
                  </FieldContent>
                  <Switch
                    id="invite-approval"
                    checked={requiresApproval}
                    onCheckedChange={setRequiresApproval}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field data-invalid={usesValid ? undefined : true}>
                    <FieldLabel htmlFor="invite-uses">
                      {t('space.invites.create.maxUses')}
                    </FieldLabel>
                    <Input
                      id="invite-uses"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={1000}
                      value={maxUses}
                      onChange={(event) => setMaxUses(event.target.value)}
                      aria-invalid={!usesValid}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="invite-expiry">
                      {t('space.invites.create.expiry')}
                    </FieldLabel>
                    <Select value={expiresInHours} onValueChange={setExpiresInHours}>
                      <SelectTrigger id="invite-expiry" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {EXPIRY_HOURS.map((hours) => (
                            <SelectItem key={hours} value={String(hours)}>
                              {t(`space.invites.create.expiryOption.${hours}`)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
              </FieldGroup>
              <ErrorText error={create.error} />
            </ResponsiveDialogBody>
            <ResponsiveDialogFooter>
              <Button type="submit" disabled={!usesValid || create.isPending}>
                {create.isPending && <Spinner data-icon="inline-start" />}
                {t('space.invites.create.submit')}
              </Button>
            </ResponsiveDialogFooter>
          </ResponsiveDialogForm>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
