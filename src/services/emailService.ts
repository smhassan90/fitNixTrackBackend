/**
 * Lightweight transactional email.
 * Prefer Resend (RESEND_API_KEY). Falls back to console log so API still succeeds.
 */

export type SendEmailInput = {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
};

export type SendEmailResult = { sent: boolean; provider?: string; error?: string };

function fromAddress(): string {
  return (
    process.env.EMAIL_FROM?.trim() ||
    process.env.RESEND_FROM?.trim() ||
    'FitNix Track <onboarding@resend.dev>'
  );
}

async function sendViaResend(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return { sent: false, error: 'RESEND_API_KEY not set' };
  }

  const to = Array.isArray(input.to) ? input.to : [input.to];
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress(),
      to,
      subject: input.subject,
      text: input.text,
      html: input.html ?? `<pre style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(input.text)}</pre>`,
      reply_to: input.replyTo,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { sent: false, provider: 'resend', error: `Resend ${res.status}: ${body}` };
  }
  return { sent: true, provider: 'resend' };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  try {
    const result = await sendViaResend(input);
    if (result.sent) return result;

    console.warn('[email] not sent:', result.error ?? 'no provider', {
      to: input.to,
      subject: input.subject,
    });
    console.info('[email][fallback log]\n', input.text);
    return { sent: false, error: result.error ?? 'No email provider configured' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[email] failed:', message);
    console.info('[email][fallback log]\n', input.text);
    return { sent: false, error: message };
  }
}

export function accountDeletionNotifyTo(): string {
  return (
    process.env.ACCOUNT_DELETION_NOTIFY_TO?.trim() ||
    process.env.ACCOUNT_DELETION_ADMIN_EMAIL?.trim() ||
    'dev.fynals@gmail.com'
  );
}
