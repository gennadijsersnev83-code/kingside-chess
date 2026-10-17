'use strict';

const BASE_URL = 'https://kingside-chess-production-ba12.up.railway.app';

async function sendEmail(payload) {
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[Mail Error] Brevo API вернул ${res.status}:`, errorText);
    } else {
      console.log(`[Mail] Письмо успешно отправлено на ${payload.to[0].email}`);
    }
  } catch (e) {
    console.error('[Mail Error] Сетевая ошибка:', e.message);
  }
}

async function sendVerificationEmail(toEmail, username, token) {
  const link = `${BASE_URL}/#/verify?token=${token}`;
  await sendEmail({
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
        <p style="font-size: 12px; color: #777;">Ссылка действует 24 часа.</p>
      </div>
    `,
    sender: { name: process.env.BREVO_SENDER_NAME || 'Kingside', email: process.env.BREVO_SENDER_EMAIL },
    to: [{ email: toEmail }]
  });
}

async function sendPasswordResetEmail(toEmail, username, token) {
  const link = `${BASE_URL}/#/reset?token=${token}`;
  await sendEmail({
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
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
