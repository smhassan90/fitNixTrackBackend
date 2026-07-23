import { BadRequestError } from '../utils/errors';
import { toWhatsAppRecipient } from '../utils/phoneNormalize';

export type WhatsAppOtpSendResult = {
  channel: 'whatsapp';
  messageId: string | null;
  to: string;
};

function whatsappConfigured(): boolean {
  return Boolean(
    process.env.WHATSAPP_ACCESS_TOKEN?.trim() &&
      process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() &&
      process.env.WHATSAPP_OTP_TEMPLATE_NAME?.trim()
  );
}

export function isWhatsAppOtpEnabled(): boolean {
  if (process.env.WHATSAPP_OTP_ENABLED === 'false') return false;
  return whatsappConfigured();
}

/**
 * Send a one-time authentication template via Meta WhatsApp Cloud API.
 * Requires an approved Authentication template in Meta Business Manager.
 *
 * Env:
 *   WHATSAPP_ACCESS_TOKEN          — Graph API permanent/system user token
 *   WHATSAPP_PHONE_NUMBER_ID       — From WhatsApp > API Setup
 *   WHATSAPP_OTP_TEMPLATE_NAME     — Approved auth template name
 *   WHATSAPP_OTP_TEMPLATE_LANG     — e.g. en_US (default en)
 *   WHATSAPP_OTP_BUTTON_TYPE       — copy_code | url | none (default copy_code)
 *   WHATSAPP_DEFAULT_COUNTRY_CODE  — default 92 (Pakistan)
 *   WHATSAPP_API_VERSION           — default v21.0
 */
export async function sendWhatsAppOtp(
  phone: string,
  otp: string
): Promise<WhatsAppOtpSendResult> {
  if (!isWhatsAppOtpEnabled()) {
    throw new BadRequestError(
      'WhatsApp OTP is not configured. Set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and WHATSAPP_OTP_TEMPLATE_NAME.'
    );
  }

  const token = process.env.WHATSAPP_ACCESS_TOKEN!.trim();
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!.trim();
  const templateName = process.env.WHATSAPP_OTP_TEMPLATE_NAME!.trim();
  const language = (process.env.WHATSAPP_OTP_TEMPLATE_LANG || 'en').trim();
  const buttonType = (process.env.WHATSAPP_OTP_BUTTON_TYPE || 'copy_code').trim().toLowerCase();
  const apiVersion = (process.env.WHATSAPP_API_VERSION || 'v21.0').trim();
  const countryCode = process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '92';

  let to: string;
  try {
    to = toWhatsAppRecipient(phone, countryCode);
  } catch {
    throw new BadRequestError('Invalid phone number for WhatsApp delivery');
  }

  const components: Array<Record<string, unknown>> = [
    {
      type: 'body',
      parameters: [{ type: 'text', text: otp }],
    },
  ];

  if (buttonType === 'copy_code') {
    // Meta Authentication template with "Copy code" button
    components.push({
      type: 'button',
      sub_type: 'copy_code',
      index: '0',
      parameters: [{ type: 'coupon_code', coupon_code: otp }],
    });
  } else if (buttonType === 'url') {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: otp }],
    });
  }
  // buttonType === 'none' → body parameter only (template must match)

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
      components,
    },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    console.error('[WhatsApp OTP] request failed', { to, message });
    throw new BadRequestError('Failed to reach WhatsApp API. Please try again.', {
      provider: 'whatsapp',
      reason: message,
    });
  }

  const payload = (await response.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
    error?: { message?: string; code?: number; error_user_msg?: string; type?: string };
  };

  if (!response.ok) {
    const providerMessage =
      payload.error?.error_user_msg ||
      payload.error?.message ||
      `WhatsApp API error HTTP ${response.status}`;
    console.error('[WhatsApp OTP] send rejected', {
      to,
      status: response.status,
      error: payload.error,
    });
    throw new BadRequestError('Failed to send OTP on WhatsApp', {
      provider: 'whatsapp',
      status: response.status,
      reason: providerMessage,
      code: payload.error?.code,
    });
  }

  const messageId = payload.messages?.[0]?.id ?? null;
  console.info('[WhatsApp OTP] sent', { to, messageId, template: templateName });

  return { channel: 'whatsapp', messageId, to };
}
