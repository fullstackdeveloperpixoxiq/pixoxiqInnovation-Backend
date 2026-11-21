import crypto from 'crypto';
import env from '../config/env.js';

// Transactional / newsletter email through Resend or Brevo (configured with env variables).
// Uses the HTTP APIs directly (Node 18+ fetch), so no extra dependency is needed.

export const isEmailConfigured = () => {
  const { provider, resendApiKey, brevoApiKey, fromEmail } = env.email;
  if (!fromEmail) return false;
  if (provider === 'resend') return Boolean(resendApiKey);
  if (provider === 'brevo') return Boolean(brevoApiKey);
  return false;
};

export const emailStatus = () => ({
  configured: isEmailConfigured(),
  provider: env.email.provider || null,
  fromEmail: env.email.fromEmail || null,
});

const TIMEOUT_MS = 15000;

const post = async (url, headers, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text;
    let code;
    try {
      const parsed = JSON.parse(text);
      message = parsed.message || text;
      code = parsed.code;
    } catch {
      /* not JSON */
    }
    const err = new Error(`Email provider error (${res.status}${code ? ` ${code}` : ''}): ${String(message).slice(0, 300)}`);
    err.status = res.status;
    err.providerCode = code;
    err.providerMessage = String(message).slice(0, 300);
    throw err;
  }
  return res.json().catch(() => ({}));
};

/**
 * Sends one email. Throws when delivery fails or no provider is configured.
 * @param {{ to: string, subject: string, html: string, text?: string, headers?: object }} message
 */
export const sendEmail = async ({ to, subject, html, text, headers = {} }) => {
  if (!isEmailConfigured()) throw new Error('Email service is not configured');
  const { provider, fromEmail, fromName } = env.email;
  // Brevo rejects an empty `headers` object ("headers is blank"), so only send it when set
  const extra = Object.keys(headers).length ? { headers } : {};

  if (provider === 'resend') {
    return post(
      'https://api.resend.com/emails',
      { Authorization: `Bearer ${env.email.resendApiKey}` },
      { from: `${fromName} <${fromEmail}>`, to: [to], subject, html, text, ...extra }
    );
  }
  return post(
    'https://api.brevo.com/v3/smtp/email',
    { 'api-key': env.email.brevoApiKey },
    {
      sender: { name: fromName, email: fromEmail },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
      ...extra,
    }
  );
};

// ---------- Tokens and links ----------

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('hex');

// Stateless unsubscribe token: HMAC of the subscriber id, so every email can carry a working link
export const unsubscribeToken = (subscriberId) =>
  crypto.createHmac('sha256', env.jwtSecret).update(`unsubscribe:${subscriberId}`).digest('hex');

export const isValidUnsubscribeToken = (subscriberId, token) => {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  return crypto.timingSafeEqual(Buffer.from(unsubscribeToken(subscriberId)), Buffer.from(token));
};

export const verifyLink = (token) => `${env.siteUrl}/newsletter/verify?token=${token}`;
export const unsubscribeLink = (id) => `${env.siteUrl}/newsletter/unsubscribe?id=${id}&token=${unsubscribeToken(id)}`;
// RFC 8058 one-click unsubscribe (mail clients POST here directly)
const oneClickLink = (id) => `${env.apiPublicUrl}/api/public/newsletter/unsubscribe?id=${id}&token=${unsubscribeToken(id)}`;

export const unsubscribeHeaders = (id) => ({
  'List-Unsubscribe': `<${oneClickLink(id)}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
});

// ---------- Templates ----------

export const escapeHtml = (value = '') =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const BRAND = '#74b800';

const layout = ({ title, bodyHtml, footerHtml = '' }) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#0a0a0a;font-family:Inter,Segoe UI,Arial,sans-serif;color:#e5e5e5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#121212;border:1px solid #262626;border-radius:16px;overflow:hidden">
<tr><td style="padding:24px 32px;border-bottom:3px solid ${BRAND}">
<span style="font-size:20px;font-weight:700;letter-spacing:1px;color:#fff">PIXOXIQ</span>
<span style="font-size:12px;color:${BRAND};margin-left:8px;letter-spacing:2px;text-transform:uppercase">Innovations</span>
</td></tr>
<tr><td style="padding:32px;font-size:15px;line-height:1.65;color:#d4d4d4">${bodyHtml}</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #262626;font-size:12px;line-height:1.6;color:#8a8a8a">
Pixoxiq Innovations Pvt. Ltd. · Kerala, India<br>${footerHtml}
</td></tr>
</table></td></tr></table></body></html>`;

const button = (href, label) =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;background:${BRAND};color:#050505;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:10px">${escapeHtml(label)}</a>`;

export const verificationEmail = (token) => {
  const link = verifyLink(token);
  return {
    subject: 'Confirm your PIXOXIQ newsletter subscription',
    html: layout({
      title: 'Confirm your subscription',
      bodyHtml: `<h1 style="margin:0 0 12px;font-size:22px;color:#fff">Confirm your subscription</h1>
<p style="margin:0 0 24px">Thanks for subscribing to the PIXOXIQ newsletter. Please confirm your email address to start receiving updates.</p>
<p style="margin:0 0 24px">${button(link, 'Confirm subscription')}</p>
<p style="margin:0;font-size:13px;color:#8a8a8a">This link expires in 48 hours. If you did not subscribe, ignore this email and you will not hear from us.</p>`,
    }),
    text: `Confirm your PIXOXIQ newsletter subscription: ${link}\n\nThis link expires in 48 hours. If you did not subscribe, ignore this email.`,
  };
};

export const registrationOtpEmail = ({ name, otp, minutes }) => ({
  subject: `${otp} is your PIXOXIQ verification code`,
  html: layout({
    title: 'Verify your email',
    bodyHtml: `<h1 style="margin:0 0 12px;font-size:22px;color:#fff">Verify your email</h1>
<p style="margin:0 0 20px">Hi ${escapeHtml(name)}, use this code to finish creating your PIXOXIQ account:</p>
<p style="margin:0 0 24px;font-size:32px;font-weight:700;letter-spacing:8px;color:${BRAND}">${escapeHtml(otp)}</p>
<p style="margin:0;font-size:13px;color:#8a8a8a">This code expires in ${minutes} minutes. If you did not sign up, ignore this email.</p>`,
  }),
  text: `Your PIXOXIQ verification code is ${otp}. It expires in ${minutes} minutes. If you did not sign up, ignore this email.`,
});

// Turns a plain-text newsletter body into safe HTML paragraphs (links become clickable)
const textToHtml = (text) =>
  text
    .split(/\n{2,}/)
    .map((para) => {
      const safe = escapeHtml(para.trim()).replace(/\n/g, '<br>');
      const linked = safe.replace(/(https?:\/\/[^\s<]+)/g, `<a href="$1" style="color:${BRAND}">$1</a>`);
      return `<p style="margin:0 0 16px">${linked}</p>`;
    })
    .join('');

export const newsletterEmail = ({ subject, content, subscriberId, imageUrl, ctaLabel, ctaUrl }) => {
  const unsub = unsubscribeLink(subscriberId);
  const absoluteCta = ctaUrl && ctaUrl.startsWith('/') ? `${env.siteUrl}${ctaUrl}` : ctaUrl;
  return {
    subject,
    html: layout({
      title: subject,
      bodyHtml: `${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" width="536" style="width:100%;max-width:536px;border-radius:12px;margin:0 0 24px;display:block">` : ''}
<h1 style="margin:0 0 16px;font-size:22px;color:#fff">${escapeHtml(subject)}</h1>
${textToHtml(content)}
${ctaLabel && absoluteCta && /^https?:\/\//i.test(absoluteCta) ? `<p style="margin:24px 0 0">${button(absoluteCta, ctaLabel)}</p>` : ''}`,
      footerHtml: `You receive this because you subscribed on pixoxiq.com. <a href="${escapeHtml(unsub)}" style="color:#a3a3a3">Unsubscribe</a>`,
    }),
    text: `${subject}\n\n${content}\n\n${ctaLabel && absoluteCta ? `${ctaLabel}: ${absoluteCta}\n\n` : ''}Unsubscribe: ${unsub}`,
    headers: unsubscribeHeaders(subscriberId),
  };
};
