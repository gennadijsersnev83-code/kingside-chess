'use strict';
const { Resend } = require('resend');
const crypto = require('crypto');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendVerificationEmail({ to, username, token }) {
  const url = `${process.env.APP_URL}/verify-email?token=${token}`;

  const { data, error } = await resend.emails.send({
    from: process.env.MAIL_FROM || 'onboarding@resend.dev',
    to,
    subject: 'Подтверждение аккаунта Kingside',
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#1f1e1b;color:#e8e6e3;padding:24px;border-radius:8px">
        <h2 style="color:#bf811d;margin:0 0 12px">Привет, ${username}!</h2>
        <p>Нажми на кнопку ниже, чтобы подтвердить email и активировать аккаунт Kingside.</p>
        <p style="margin:28px 0">
          <a href="${url}" style="display:inline-block;padding:14px 28px;background:#629924;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">Подтвердить аккаунт</a>
        </p>
        <p style="color:#7d7a72;font-size:12px">Ссылка действует 24 часа. Если ты не регистрировался — просто проигнорируй письмо.</p>
      </div>
    `
  });

  if (error) {
    console.error('[Resend] Ошибка:', error);
    throw new Error(error.message || 'Resend send failed');
  }
  console.log('[Resend] Письмо отправлено, id:', data.id);
  return data;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { sendVerificationEmail, generateToken };
