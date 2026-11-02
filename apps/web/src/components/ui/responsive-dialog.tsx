// SPDX-License-Identifier: AGPL-3.0-only
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';

/**
 * A form dialog: the centered `Dialog` from 768px up, a bottom `Sheet` below it (phones). One
 * wrapper picks the primitive, so call sites keep the same shape. Desktop rendering is exactly
 * the plain `Dialog`: Body and Panel/Form add no layout there (`display: contents`).
 *
 * Both primitives are the same Radix Dialog, so Root, Trigger and Close are shared and focus
 * returns to the opener on close.
 */
const ResponsiveDialog = Dialog;
const ResponsiveDialogTrigger = DialogTrigger;
const ResponsiveDialogClose = DialogClose;

/** The on-screen keyboard's height and the visible height, from `visualViewport` (0 / null if none). */
function useKeyboard(enabled: boolean): { inset: number; height: number | null } {
  const [state, setState] = React.useState<{ inset: number; height: number | null }>({
    inset: 0,
    height: null,
  });
  React.useEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) return;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      // Only react to a real keyboard, not to the browser bar sliding away.
      setState(inset > 80 ? { inset, height: viewport.height } : { inset: 0, height: null });
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, [enabled]);
  return state;
}

function ResponsiveDialogContent({
  className,
  children,
  style,
  mobileClassName,
  closeLabel,
  ...props
}: React.ComponentProps<typeof DialogContent> & {
  /** Extra classes on phones only. */
  mobileClassName?: string;
  /** Accessible name of the sheet's close button; defaults to the translated "Close". */
  closeLabel?: string;
}) {
  const mobile = useIsMobile();
  const { t } = useTranslation();
  const keyboard = useKeyboard(mobile);
  if (!mobile) {
    return (
      <DialogContent className={className} style={style} {...props}>
        {children}
      </DialogContent>
    );
  }
  const { showCloseButton: _ignored, ...sheetProps } = props;
  void _ignored;
  return (
    <SheetContent
      side="bottom"
      closeLabel={closeLabel ?? t('common.close')}
      data-slot="responsive-dialog-content"
      className={cn(
        'max-h-[92dvh] gap-0 overflow-hidden rounded-t-xl p-0 outline-none',
        mobileClassName,
      )}
      style={{
        ...style,
        // Above the on-screen keyboard: lift the sheet and shrink it to the visible height.
        ...(keyboard.inset > 0 && keyboard.height !== null
          ? { bottom: keyboard.inset, maxHeight: `${Math.round(keyboard.height * 0.92)}px` }
          : {}),
      }}
      onFocusCapture={(event: React.FocusEvent<HTMLDivElement>) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.matches('input, textarea, [contenteditable]')) {
          // Wait for the keyboard to open, then keep the field in view inside the body.
          setTimeout(() => target.scrollIntoView?.({ block: 'nearest' }), 300);
        }
      }}
      {...sheetProps}
    >
      <div
        aria-hidden="true"
        data-slot="responsive-dialog-handle"
        className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/30"
      />
      {children}
    </SheetContent>
  );
}

/** A `<form>` filling the sheet on phones (header fixed, body scrolls, footer pinned). */
function ResponsiveDialogForm({ className, ...props }: React.ComponentProps<'form'>) {
  return (
    <form
      data-slot="responsive-dialog-form"
      className={cn(className, 'max-md:flex max-md:min-h-0 max-md:flex-1 max-md:flex-col')}
      {...props}
    />
  );
}

/** Same as the form, for a dialog step without one. */
function ResponsiveDialogPanel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="responsive-dialog-panel"
      className={cn(className, 'max-md:flex max-md:min-h-0 max-md:flex-1 max-md:flex-col')}
      {...props}
    />
  );
}

function ResponsiveDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  const mobile = useIsMobile();
  if (!mobile) return <DialogHeader className={className} {...props} />;
  return <SheetHeader className={cn('shrink-0 px-4 pt-3 pr-12 pb-2', className)} {...props} />;
}

/** The scrolling part on phones; layout-neutral (`display: contents`) on desktop. */
function ResponsiveDialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  const mobile = useIsMobile();
  return (
    <div
      data-slot="responsive-dialog-body"
      className={
        mobile
          ? cn(
              'flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-4 py-2',
              className,
            )
          : 'contents'
      }
      {...props}
    />
  );
}

/**
 * Pinned at the bottom on phones with full-width 44px buttons, primary first and then a Cancel
 * (unless `cancel={false}`). Desktop: the plain `DialogFooter`.
 */
function ResponsiveDialogFooter({
  className,
  children,
  cancel = true,
  ...props
}: React.ComponentProps<'div'> & { cancel?: boolean }) {
  const mobile = useIsMobile();
  const { t } = useTranslation();
  if (!mobile) {
    return (
      <DialogFooter className={className} {...props}>
        {children}
      </DialogFooter>
    );
  }
  return (
    <SheetFooter
      className={cn(
        'mt-0 shrink-0 border-t pb-[max(1rem,env(safe-area-inset-bottom))] [&_button]:h-11 [&_button]:w-full',
        className,
      )}
      {...props}
    >
      {children}
      {cancel && (
        <SheetClose asChild>
          <Button type="button" variant="outline">
            {t('common.cancel')}
          </Button>
        </SheetClose>
      )}
    </SheetFooter>
  );
}

function ResponsiveDialogTitle({ className, ...props }: React.ComponentProps<typeof DialogTitle>) {
  const mobile = useIsMobile();
  return mobile ? (
    <SheetTitle className={cn('text-base', className)} {...props} />
  ) : (
    <DialogTitle className={className} {...props} />
  );
}

function ResponsiveDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogDescription>) {
  const mobile = useIsMobile();
  return mobile ? (
    <SheetDescription className={className} {...props} />
  ) : (
    <DialogDescription className={className} {...props} />
  );
}

export {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogForm,
  ResponsiveDialogHeader,
  ResponsiveDialogPanel,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
};
