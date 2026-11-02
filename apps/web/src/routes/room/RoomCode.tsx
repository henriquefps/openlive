// SPDX-License-Identifier: AGPL-3.0-only
import { CopyIcon, LinkIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { joinUrl } from '../../api/spaces.ts';

/** A quick room's code, with buttons to copy it or its /join link for sharing. */
export function RoomCode({ code }: { code: string }) {
  const { t } = useTranslation();
  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(done);
    } catch {
      toast.error(t('room.code.copyFailed'));
    }
  };
  return (
    <div className="flex items-center gap-1 rounded-lg border py-0.5 pr-0.5 pl-2.5">
      <span className="sr-only">{t('room.code.label')}</span>
      <span className="font-mono text-[0.875rem] select-all">{code}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('room.code.copy')}
        title={t('room.code.copy')}
        onClick={() => void copy(code, t('room.code.copied'))}
      >
        <CopyIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('room.code.copyLink')}
        title={t('room.code.copyLink')}
        onClick={() => void copy(joinUrl(code), t('room.code.linkCopied'))}
      >
        <LinkIcon />
      </Button>
    </div>
  );
}
