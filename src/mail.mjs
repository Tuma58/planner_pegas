// Простой SMTP-клиент без внешних зависимостей (Node ≥ 22).
// Рассчитан на reg.ru и аналоги: implicit TLS :465 или STARTTLS :587.
//
// Секрет пароля: .secrets/smtp_password / SMTP_PASSWORD_FILE / settings.smtp.password.

import net from 'node:net';
import tls from 'node:tls';

function encodeLogin(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      // Многострочный ответ SMTP: последняя строка «NNN text» без «-» после кода.
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      if (!lines.length) return;
      const last = lines[lines.length - 1];
      if (/^\d{3} /.test(last)) {
        socket.off('data', onData);
        socket.off('error', onError);
        resolve({ code: Number(last.slice(0, 3)), text: buffer });
      }
    };
    const onError = error => {
      socket.off('data', onData);
      reject(error);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

async function expect(socket, okCodes) {
  const response = await readResponse(socket);
  const allowed = Array.isArray(okCodes) ? okCodes : [okCodes];
  if (!allowed.includes(response.code)) {
    throw new Error(`SMTP ${response.code}: ${response.text.trim().slice(0, 200)}`);
  }
  return response;
}

async function command(socket, line, okCodes) {
  socket.write(`${line}\r\n`);
  return expect(socket, okCodes);
}

function connectSocket({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, minVersion: 'TLSv1.2' }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));
    socket.setEncoding('utf8');
    socket.setTimeout(20_000);
    socket.once('error', reject);
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('SMTP timeout'));
    });
  });
}

async function upgradeToTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket, servername: host, minVersion: 'TLSv1.2'
    }, () => resolve(secure));
    secure.setEncoding('utf8');
    secure.once('error', reject);
  });
}

function mimeHeaders({ from, to, subject }) {
  const encodedSubject = /[^\x00-\x7F]/.test(subject)
    ? `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
    : subject;
  return [
    `From: ${from}`,
    `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    `Date: ${new Date().toUTCString()}`,
    'Message-ID: <' + Date.now().toString(36) + '@pegasavto.ru>'
  ].join('\r\n');
}

// Отправка письма. to — строка или массив e-mail.
export async function sendMail({
  host = 'mail.hosting.reg.ru', port = 465, secure = true,
  user, password, from, to, subject, text
} = {}) {
  if (!host || !user || !password) return { ok: false, error: 'SMTP: не заданы host/user/password' };
  const recipients = (Array.isArray(to) ? to : String(to || '').split(/[,;]/))
    .map(item => String(item).trim()).filter(item => item.includes('@'));
  if (!recipients.length) return { ok: false, error: 'SMTP: нет получателей' };
  const fromAddr = from || user;
  const bodyText = String(text || '');
  const subjectText = String(subject || 'PegasLogistic').slice(0, 200);

  let socket;
  try {
    socket = await connectSocket({ host, port: Number(port) || (secure ? 465 : 587), secure: Boolean(secure) });
    await expect(socket, 220);
    await command(socket, `EHLO pegas-planner`, 250);
    if (!secure) {
      await command(socket, 'STARTTLS', 220);
      socket.removeAllListeners('data');
      socket = await upgradeToTls(socket, host);
      await command(socket, `EHLO pegas-planner`, 250);
    }
    await command(socket, 'AUTH LOGIN', 334);
    await command(socket, encodeLogin(user), 334);
    await command(socket, encodeLogin(password), 235);
    await command(socket, `MAIL FROM:<${fromAddr}>`, 250);
    for (const rcpt of recipients) {
      await command(socket, `RCPT TO:<${rcpt}>`, [250, 251]);
    }
    await command(socket, 'DATA', 354);
    const payload = mimeHeaders({ from: fromAddr, to: recipients, subject: subjectText })
      + '\r\n\r\n'
      + Buffer.from(bodyText, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
      + '\r\n.';
    socket.write(payload + '\r\n');
    await expect(socket, 250);
    await command(socket, 'QUIT', [221, 250]).catch(() => {});
    socket.end();
    return { ok: true, to: recipients };
  } catch (error) {
    try { socket?.destroy(); } catch { /* ok */ }
    return { ok: false, error: error.message };
  }
}
