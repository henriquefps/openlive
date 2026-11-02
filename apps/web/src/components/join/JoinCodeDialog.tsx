// SPDX-License-Identifier: AGPL-3.0-only
import { useTranslation } from 'react-i18next';
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog';
import { JoinCodeForm } from './JoinCodeForm.tsx';

/** The join form in a dialog, for the user menu (open from anywhere in the app). */
export function JoinCodeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{t('join.title')}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>{t('join.intro')}</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          {open && <JoinCodeForm id="join-dialog" autoFocus onJoined={() => onOpenChange(false)} />}
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
