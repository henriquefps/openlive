// SPDX-License-Identifier: AGPL-3.0-only
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useNow } from '../hooks/use-now.ts';
import type { IdleState } from './brakes.ts';

/** Brake 6: "Still watching?", with the seconds left before watching stops. */
export function StillWatchingDialog({
  idle,
  onContinue,
  onStop,
}: {
  idle: IdleState;
  onContinue: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open={idle.kind === 'asking'}
      onOpenChange={(open) => {
        // Escape or a click outside is an answer too: someone is there.
        if (!open) onContinue();
      }}
    >
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('player.stillWatching.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {idle.kind === 'asking' && <Countdown deadline={idle.deadline} />}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onStop}>{t('player.stillWatching.stop')}</AlertDialogCancel>
          <AlertDialogAction onClick={onContinue}>
            {t('player.stillWatching.continue')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Ticks only while the question is open. */
function Countdown({ deadline }: { deadline: number }) {
  const { t } = useTranslation();
  const now = useNow(1000);
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return t('player.stillWatching.description', { seconds });
}
