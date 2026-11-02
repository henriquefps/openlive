// SPDX-License-Identifier: AGPL-3.0-only
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { errorBodyOf } from '../../api/client.ts';
import { spaceAbilities } from '../../api/permissions.ts';
import {
  type SettingsPatch,
  type Space,
  type SpaceSettings,
  useDeleteSpace,
  useRemoveMember,
  useUpdateSpace,
} from '../../api/spaces.ts';
import { CapabilityFields } from '../../components/capabilities/CapabilityFields.tsx';
import { ErrorText } from '../../components/QueryError.tsx';
import { translateError } from '../../i18n/errors.ts';
import {
  aboveCeiling,
  ALL_CAPABILITIES,
  ceilingOf,
  isValidCapabilities,
  sameCapabilities,
} from '../../lib/capabilities.ts';

const LIMITS = ['maxStreams', 'maxViewersPerStream', 'maxBitrateKbps', 'quickRoomHours'] as const;
type LimitKey = (typeof LIMITS)[number];

/** Defaults when the space sets nothing (apps/api/src/api/settings.ts). */
const QUICK_ROOM_DEFAULT_HOURS = 12;

const toField = (value: number | undefined) => (value === undefined ? '' : String(value));

/**
 * Space settings: name and limits, each only lowering the platform's. An empty
 * limit follows the platform; a value above it is refused by the API with the ceiling.
 */
export function SettingsTab({ space, selfId }: { space: Space; selfId: string }) {
  const { t } = useTranslation();
  const abilities = spaceAbilities(space);
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <SettingsForm key={JSON.stringify(space.settings) + space.name} space={space} />
      {abilities.deleteSpace ? (
        <DeleteSpaceCard space={space} />
      ) : (
        space.role !== null && <LeaveSpaceCard space={space} selfId={selfId} />
      )}
      {!abilities.updateSettings && (
        <p className="text-[0.8125rem] text-muted-foreground">{t('space.settings.readOnly')}</p>
      )}
    </div>
  );
}

function SettingsForm({ space }: { space: Space }) {
  const { t } = useTranslation();
  const editable = spaceAbilities(space).updateSettings;
  const update = useUpdateSpace(space.id);
  const [name, setName] = useState(space.name);
  const [limits, setLimits] = useState<Record<LimitKey, string>>({
    maxStreams: toField(space.settings.maxStreams),
    maxViewersPerStream: toField(space.settings.maxViewersPerStream),
    maxBitrateKbps: toField(space.settings.maxBitrateKbps),
    quickRoomHours: toField(space.settings.quickRoomHours),
  });
  const [membersInvite, setMembersInvite] = useState(
    space.settings.membersCanInviteGuests !== false,
  );
  // What the space's rooms may have, within what the platform allows.
  const allowedNow = ceilingOf(space.effectiveSettings);
  const platformCapabilities = space.platformCapabilities ?? ALL_CAPABILITIES;
  const [allowed, setAllowed] = useState(allowedNow);
  const allowedValid =
    isValidCapabilities(allowed) && aboveCeiling(allowed, platformCapabilities).length === 0;
  const invalid = LIMITS.filter((key) => {
    const value = limits[key];
    if (value === '') return false;
    const n = Number(value);
    return !Number.isInteger(n) || n < (key === 'quickRoomHours' ? 1 : 0);
  });

  const current: Record<LimitKey, number> = {
    maxStreams: space.effectiveSettings.maxStreams,
    maxViewersPerStream: space.effectiveSettings.maxViewersPerStream,
    maxBitrateKbps: space.effectiveSettings.maxBitrateKbps,
    quickRoomHours: space.settings.quickRoomHours ?? QUICK_ROOM_DEFAULT_HOURS,
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const settings: SettingsPatch<SpaceSettings> = {
      membersCanInviteGuests: membersInvite ? null : false,
    };
    for (const key of LIMITS) {
      settings[key] = limits[key] === '' ? null : Number(limits[key]);
    }
    if (!sameCapabilities(allowed, allowedNow)) settings.capabilities = allowed;
    update.mutate(
      { ...(name.trim() !== space.name ? { name: name.trim() } : {}), settings },
      { onSuccess: () => toast.success(t('space.settings.saved')) },
    );
  };

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-6">
        <CardHeader>
          <CardTitle>{t('space.settings.title')}</CardTitle>
          <CardDescription>{t('space.settings.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-disabled={editable ? undefined : true}>
              <FieldLabel htmlFor="space-settings-name">{t('space.settings.name')}</FieldLabel>
              <Input
                id="space-settings-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                disabled={!editable}
                required
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              {LIMITS.map((key) => (
                <Field
                  key={key}
                  data-invalid={invalid.includes(key) ? true : undefined}
                  data-disabled={editable ? undefined : true}
                >
                  <FieldLabel htmlFor={`space-settings-${key}`}>
                    {t(`space.settings.limits.${key}`)}
                  </FieldLabel>
                  <Input
                    id={`space-settings-${key}`}
                    type="number"
                    inputMode="numeric"
                    min={key === 'quickRoomHours' ? 1 : 0}
                    max={key === 'quickRoomHours' ? 24 : undefined}
                    value={limits[key]}
                    placeholder={String(current[key])}
                    onChange={(event) => setLimits({ ...limits, [key]: event.target.value })}
                    aria-invalid={invalid.includes(key)}
                    disabled={!editable}
                    className="tabular-nums"
                  />
                  <FieldDescription>
                    {t('space.settings.limits.current', { value: current[key] })}
                  </FieldDescription>
                </Field>
              ))}
            </div>
            <Field orientation="horizontal" data-disabled={editable ? undefined : true}>
              <FieldContent>
                <FieldLabel htmlFor="space-settings-invite">
                  {t('space.settings.membersCanInviteGuests')}
                </FieldLabel>
                <FieldDescription>
                  {t('space.settings.membersCanInviteGuestsHint')}
                </FieldDescription>
              </FieldContent>
              <Switch
                id="space-settings-invite"
                checked={membersInvite}
                onCheckedChange={setMembersInvite}
                disabled={!editable}
              />
            </Field>
            <FieldSeparator />
            <FieldSet data-tour="space-capabilities">
              <FieldLegend>{t('space.settings.capabilities.title')}</FieldLegend>
              <FieldDescription>{t('space.settings.capabilities.description')}</FieldDescription>
              <CapabilityFields
                value={allowed}
                onChange={setAllowed}
                ceiling={platformCapabilities}
                disabled={!editable}
                allowList
              />
            </FieldSet>
          </FieldGroup>
        </CardContent>
        {editable && (
          <CardFooter className="flex flex-col items-start gap-2">
            <p className="text-[0.8125rem] text-muted-foreground">
              {t('space.settings.limits.hint')}
            </p>
            <ErrorText error={update.error} />
            <Button
              type="submit"
              disabled={!name.trim() || invalid.length > 0 || !allowedValid || update.isPending}
            >
              {update.isPending && <Spinner data-icon="inline-start" />}
              {t('common.save')}
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}

function DeleteSpaceCard({ space }: { space: Space }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const remove = useDeleteSpace(space.id);
  const confirm = () =>
    remove.mutate(undefined, {
      onSuccess: () => void navigate({ to: '/spaces' }),
      onError: (error) => toast.error(translateError(errorBodyOf(error), t)),
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('space.settings.delete.title')}</CardTitle>
        <CardDescription>{t('space.settings.delete.description')}</CardDescription>
      </CardHeader>
      <CardFooter>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">{t('space.settings.delete.action')}</Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('space.settings.delete.confirmTitle', { name: space.name })}
              </AlertDialogTitle>
              <AlertDialogDescription>{t('space.settings.delete.confirm')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={confirm}>
                {t('space.settings.delete.action')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardFooter>
    </Card>
  );
}

function LeaveSpaceCard({ space, selfId }: { space: Space; selfId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const leave = useRemoveMember(space.id);
  const confirm = () =>
    leave.mutate(selfId, {
      onSuccess: () => void navigate({ to: '/spaces' }),
      onError: (error) => toast.error(translateError(errorBodyOf(error), t)),
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('space.settings.leave.title')}</CardTitle>
        <CardDescription>{t('space.settings.leave.description')}</CardDescription>
      </CardHeader>
      <CardFooter>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline">{t('space.settings.leave.action')}</Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('space.settings.leave.confirmTitle', { name: space.name })}
              </AlertDialogTitle>
              <AlertDialogDescription>{t('space.settings.leave.confirm')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={confirm}>
                {t('space.settings.leave.action')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardFooter>
    </Card>
  );
}
