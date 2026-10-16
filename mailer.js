'use strict';

const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 465,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

transporter.verify((error) => {
  if (error) console.error('[Mailer] Ошибка SMTP:', error.message);
  else       console.log('[Mailer] SMTP готов');
});

async function sendVerificationEmail(to, code, username) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#1a1a1a;color:#e0e0e0;border-radius:8px;">
      <h2 style="color:#4a9eff;margin-top:0;">Kingside — подтверждение почты</h2>
      <p>Привет, <b>${username}</b>!</p>
      <p>Твой код подтверждения:</p>
      <div style="font-size:32px;font-weight:bold;letter-spacing:6px;text-align:center;padding:16px;background:#2a2a2a;border-radius:6px;color:#4a9eff;margin:16px 0;">${code}</div>
      <p style="color:#888;font-size:13px;">Код действителен 15 минут.</p>
    </div>`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to, subject: 'Kingside — код подтверждения', html,
  });
}

async function sendPasswordResetEmail(to, token) {
  const resetUrl = `${process.env.APP_URL}/#/reset-password/${token}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#1a1a1a;color:#e0e0e0;border-radius:8px;">
      <h2 style="color:#4a9eff;margin-top:0;">Kingside — сброс пароля</h2>
      <p><a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#4a9eff;color:#fff;text-decoration:none;border-radius:6px;">Сбросить пароль</a></p>
      <p style="color:#888;font-size:13px;">Ссылка действительна 1 час.</p>
    </div>`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to, subject: 'Kingside — сброс пароля', html,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
