// SPDX-License-Identifier: AGPL-3.0-only
// Sending the magic link. The provider sits behind EmailSender so another
// one can be added and tests use a fake; Resend is the default.

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  /** Throws when the provider does not accept the message. */
  send(message: EmailMessage): Promise<void>;
}

// Resend's shared test sender, when an instance sets no EMAIL_FROM (the setup sets one for a
// custom domain): it only delivers to the Resend account owner's own address.
export const DEFAULT_EMAIL_FROM = 'Openlive <onboarding@resend.dev>';
const RESEND_URL = 'https://api.resend.com/emails';

export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });
    // The body may echo the message, which holds the login link: only the status is logged.
    if (!res.ok) throw new Error(`Resend answered ${res.status}`);
  }
}

let testSender: EmailSender | null = null;

/** Replaces the provider in tests (null restores it). Never used by the Worker itself. */
export function setEmailSenderForTests(sender: EmailSender | null): void {
  testSender = sender;
}

/** The configured sender, or null when this instance has no e-mail provider. */
export function emailSender(env: Env): EmailSender | null {
  if (testSender) return testSender;
  if (!env.RESEND_API_KEY) return null;
  return new ResendEmailSender(env.RESEND_API_KEY, env.EMAIL_FROM?.trim() || DEFAULT_EMAIL_FROM);
}

// The message text, per language (e-mails follow the user's language, `en` default).

export const EMAIL_LOCALES = ['en', 'pt-BR'] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];

const TEXT = {
  en: {
    subject: 'Your Openlive sign-in link',
    intro: 'Use the link below to sign in to Openlive.',
    linkIntro: 'Use the link below to sign in to Openlive and connect your Discord account.',
    button: 'Sign in to Openlive',
    expiry: 'The link works once and expires in 15 minutes.',
    ignore: 'If you did not ask for it, you can ignore this e-mail.',
  },
  'pt-BR': {
    subject: 'Seu link de acesso ao Openlive',
    intro: 'Use o link abaixo para entrar no Openlive.',
    linkIntro: 'Use o link abaixo para entrar no Openlive e conectar sua conta do Discord.',
    button: 'Entrar no Openlive',
    expiry: 'O link funciona uma vez e expira em 15 minutos.',
    ignore: 'Se você não pediu este e-mail, pode ignorá-lo.',
  },
} satisfies Record<EmailLocale, Record<string, string>>;

/** The best supported language for a list of BCP 47 tags (exact, then base language). */
export function matchEmailLocale(tags: (string | null | undefined)[]): EmailLocale {
  for (const tag of tags) {
    if (!tag) continue;
    const lower = tag.trim().toLowerCase();
    const exact = EMAIL_LOCALES.find((l) => l.toLowerCase() === lower);
    if (exact) return exact;
    const base = lower.split('-')[0];
    const byBase = EMAIL_LOCALES.find((l) => l.toLowerCase().split('-')[0] === base);
    if (byBase) return byBase;
  }
  return 'en';
}

/** Accept-Language tags in the order given (quality values are ignored). */
export const acceptLanguages = (header: string | null): string[] =>
  (header ?? '').split(',').map((part) => part.split(';')[0]?.trim() ?? '');

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );

export function magicLinkMessage(
  to: string,
  url: string,
  locale: EmailLocale,
  purpose: 'login' | 'link',
): EmailMessage {
  const t = TEXT[locale];
  const intro = purpose === 'link' ? t.linkIntro : t.intro;
  const text = `${intro}\n\n${url}\n\n${t.expiry}\n${t.ignore}\n`;
  const html = `<!doctype html>
<html lang="${locale}"><body style="font-family: Inter, system-ui, sans-serif; color: #1f2317; line-height: 1.5">
<p>${escapeHtml(intro)}</p>
<p><a href="${escapeHtml(url)}" style="display: inline-block; padding: 10px 16px; border-radius: 8px; background: #5b6b2f; color: #ffffff; text-decoration: none; font-weight: 600">${escapeHtml(t.button)}</a></p>
<p style="font-size: 13px; color: #5c604f">${escapeHtml(t.expiry)}<br>${escapeHtml(t.ignore)}</p>
<p style="font-size: 13px; color: #5c604f; word-break: break-all">${escapeHtml(url)}</p>
</body></html>`;
  return { to, subject: t.subject, text, html };
}
