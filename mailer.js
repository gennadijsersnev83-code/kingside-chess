'use strict';
const { BrevoClient } = require('@getbrevo/brevo');

const brevo = new BrevoClient({ apiKey: process.env.BREVO_API_KEY });
const BASE_URL = 'https://kingside-chess-production-ba12.up.railway.app';

async function sendVerificationEmail(toEmail, username, token) {
  const link = `${BASE_URL}/#/verify?token=${token}`;
  try {
    await brevo.transactionalEmails.sendTransacEmail({
      subject: 'Подтвердите аккаунт Kingside',
      htmlContent: `
        <div style="font-family: sans-serif; color: #333; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
          <h2 style="color: #629924;">Добро пожаловать в Kingside!</h2>
          <p>Привет, <b>${username}</b>!</p>
          <p>Чтобы активировать аккаунт и начать играть, подтвердите свой email:</p>
          <p style="text-align: center; margin: 30px 0;">
            <a href="${link}" style="padding: 12px 24px; background: #629924; color: #fff; text-decoration: none; border-radius: 6px; font-weight: bold;">Подтвердить аккаунт</a>
          </p>
          <p style="font-size: 12px; color: #777;">Если кнопка не работает, скопируйте ссылку: <br> ${link}</p>
          <p style="font-size: 12px; color: #777;">Ссылка действует 24 часа. Если вы не регистрировались, просто проигнорируйте письмо.</p>
        </div>
      `,
      sender: { name: process.env.BREVO_SENDER_NAME || 'Kingside', email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: toEmail }]
    });
    console.log(`[Mail] Письмо отправлено на ${toEmail}`);
  } catch (e) {
    console.error('[Mail] Ошибка отправки:', e);
  }
}

async function sendPasswordResetEmail(toEmail, username, token) {
  const link = `${BASE_URL}/#/reset?token=${token}`;
  try {
    await brevo.transactionalEmails.sendTransacEmail({
      subject: 'Сброс пароля Kingside',
      htmlContent: `
        <div style="font-family: sans-serif; color: #333; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
          <h2 style="color: #bf811d;">Сброс пароля</h2>
          <p>Привет, <b>${username}</b>.</p>
          <p>Вы запросили сброс пароля для аккаунта Kingside. Для смены пароля перейдите по ссылке:</p>
          <p style="text-align: center; margin: 30px 0;">
            <a href="${link}" style="padding: 12px 24px; background: #bf811d; color: #161512; text-decoration: none; border-radius: 6px; font-weight: bold;">Сбросить пароль</a>
          </p>
          <p style="font-size: 12px; color: #777;">Если кнопка не работает, скопируйте ссылку: <br> ${link}</p>
          <p style="font-size: 12px; color: #777;">Ссылка действует 1 час. Если вы не запрашивали сброс — просто проигнорируйте письмо.</p>
        </div>
      `,
      sender: { name: process.env.BREVO_SENDER_NAME || 'Kingside', email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: toEmail }]
    });
    console.log(`[Mail] Письмо для сброса пароля отправлено на ${toEmail}`);
  } catch (e) {
    console.error('[Mail] Ошибка отправки:', e);
  }
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
