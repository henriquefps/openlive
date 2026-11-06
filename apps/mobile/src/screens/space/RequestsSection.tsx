// SPDX-License-Identifier: AGPL-3.0-only
import type { JoinRequest } from '@openlive/client';
import { HandWaving } from 'phosphor-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import { Avatar, Button, Card } from '../../components/ui.tsx';
import { EmptyState } from '../../components/ui/index.ts';
import { Skeleton } from '../../components/ui/Skeleton.tsx';
import { inviteRoomName } from '../../lib/space-view.ts';
import { useRooms } from '../../queries.ts';
import { useJoinRequests, useSpaceActions } from '../../space-queries.ts';
import { font, useTheme } from '../../theme.ts';
import { ErrorLine, QueryFailure, type SectionProps } from './shared.tsx';

/** Pending join requests: approve or reject (owners and admins). */
export function RequestsSection({ origin, space }: SectionProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const requests = useJoinRequests(origin, space.id);
  const rooms = useRooms(origin, space.id);
  if (requests.isPending && requests.fetchStatus !== 'paused') return <Skeleton height={112} />;
  if (requests.data === undefined) {
    return requests.isError ? (
      <QueryFailure error={requests.error} onRetry={() => void requests.refetch()} />
    ) : null;
  }
  if (requests.data.length === 0) {
    return (
      <EmptyState
        icon={<HandWaving size={22} color={colors.mutedForeground} />}
        title={t('space.requests.empty.title')}
        description={t('space.requests.empty.description')}
      />
    );
  }
  return (
    <>
      {requests.data.map((request) => (
        <RequestCard
          key={request.id}
          origin={origin}
          spaceId={space.id}
          request={request}
          roomName={inviteRoomName(request, rooms.data)}
        />
      ))}
    </>
  );
}

const REJECT = 'reject';
const APPROVE = 'approve';

function RequestCard({
  origin,
  spaceId,
  request,
  roomName,
}: {
  origin: string;
  spaceId: string;
  request: JoinRequest;
  roomName: string | null;
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const { decideJoinRequest: decide } = useSpaceActions(origin, spaceId);
  const name = request.displayName ?? t('space.requests.unknown');
  const run = (decision: 'approve' | 'reject') =>
    decide.mutate({ joinRequestId: request.id, decision });
  const reject = () => run(REJECT);
  const approve = () => run(APPROVE);
  return (
    <Card>
      <View style={styles.row}>
        <Avatar name={name} size={40} />
        <View style={styles.grow}>
          <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
            {name}
          </Text>
          <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={2}>
            {t(roomName ? 'space.requests.toRoom' : 'space.requests.toSpace', {
              room: roomName,
              date: new Intl.DateTimeFormat(i18n.language, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(request.createdAt),
            })}
          </Text>
        </View>
      </View>
      <ErrorLine error={decide.error} />
      <View style={styles.buttons}>
        <View style={styles.grow}>
          <Button
            label={t('space.requests.reject')}
            accessibilityLabel={t('space.requests.rejectLabel', { name })}
            variant="outline"
            disabled={decide.isPending}
            onPress={reject}
          />
        </View>
        <View style={styles.grow}>
          <Button
            label={t('space.requests.approve')}
            accessibilityLabel={t('space.requests.approveLabel', { name })}
            disabled={decide.isPending}
            onPress={approve}
          />
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grow: { flex: 1, gap: 1 },
  buttons: { flexDirection: 'row', gap: 8 },
  name: { fontFamily: font.medium, fontSize: 15 },
  meta: { fontFamily: font.regular, fontSize: 13 },
});
