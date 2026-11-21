// HTML for transactional mail. Pure functions (no SMTP) so they can be tested
// and previewed. Email clients ignore <style> blocks and most modern CSS, so
// the layout is tables with inline styles, and the brand mark is HTML rather
// than an image: Gmail and Outlook often block images and never show SVG.

const BRAND = '#059669';
const BRAND_MARK = '#1EA38C';
const INK = '#111827';
const MUTED = '#4b5563';
const PAGE_BG = '#f4f4f5';
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const escapeHtml = (text) =>
  String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

export const pickLang = (language) => (language === 'en' ? 'en' : 'es');

const appUrl = () => (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
const appHost = () => appUrl().replace(/^https?:\/\//, '');

const LAYOUT_COPY = {
  es: { openApp: 'Abrir Goals' },
  en: { openApp: 'Open Goals' },
};

/** A bulletproof-ish button: a padded link inside a table cell. */
export const button = (href, label) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td style="border-radius:6px;background:${BRAND};">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;

/**
 * Wraps a message in the shared frame: brand header, white card, footer.
 * `bodyHtml` must already be escaped; `preheader` is the inbox preview line.
 */
export function renderLayout({ lang, title, preheader = '', bodyHtml, footerNote = '' }) {
  const copy = LAYOUT_COPY[pickLang(lang)];
  const home = appUrl();
  return `<!doctype html>
<html lang="${pickLang(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr>
          <td style="padding:0 4px 16px;">
            <a href="${escapeHtml(home)}" style="text-decoration:none;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="width:28px;height:28px;border-radius:14px;background:${BRAND_MARK};font-size:0;line-height:0;">&nbsp;</td>
                  <td style="padding-left:10px;font-family:${FONT};font-size:20px;font-weight:700;color:${INK};letter-spacing:-0.2px;">Goals</td>
                </tr>
              </table>
            </a>
          </td>
        </tr>
        <tr>
          <td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:32px 28px;font-family:${FONT};font-size:15px;line-height:1.6;color:${INK};">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 4px 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${MUTED};">
            ${footerNote ? `<p style="margin:0 0 8px;">${footerNote}</p>` : ''}
            <p style="margin:0;"><a href="${escapeHtml(home)}" style="color:${MUTED};">${escapeHtml(appHost() || copy.openApp)}</a></p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

const h1 = (text) =>
  `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:700;color:${INK};">${text}</h1>`;
const p = (text, extra = '') => `<p style="margin:0 0 12px;${extra}">${text}</p>`;
const small = (text) => p(text, `font-size:13px;color:${MUTED};`);
const linkFallback = (intro, url) =>
  small(`${intro}<br><a href="${escapeHtml(url)}" style="color:${BRAND};word-break:break-all;">${escapeHtml(url)}</a>`);

const VERIFY_COPY = {
  es: {
    subject: 'Confirma tu correo para empezar a usar Goals',
    preheader: 'Un clic y ya puedes iniciar sesión.',
    greeting: (name) => `Hola, ${name}`,
    body: 'Gracias por crear tu cuenta. Confirma tu correo para poder iniciar sesión.',
    cta: 'Confirmar mi correo',
    fallback: 'Si el botón no funciona, copia este enlace en tu navegador:',
    footer: 'Si no creaste una cuenta en Goals, ignora este correo.',
  },
  en: {
    subject: 'Confirm your email to start using Goals',
    preheader: 'One click and you can sign in.',
    greeting: (name) => `Hi ${name}`,
    body: 'Thanks for creating your account. Confirm your email so you can sign in.',
    cta: 'Confirm my email',
    fallback: "If the button doesn't work, paste this link into your browser:",
    footer: "If you didn't create a Goals account, you can ignore this email.",
  },
};

export function verificationEmail({ name, token, language }) {
  const lang = pickLang(language);
  const c = VERIFY_COPY[lang];
  const url = `${appUrl()}/verify-email/${encodeURIComponent(token)}`;
  const greeting = c.greeting(escapeHtml(name));
  return {
    subject: c.subject,
    html: renderLayout({
      lang,
      title: c.subject,
      preheader: c.preheader,
      bodyHtml: h1(greeting) + p(c.body) + button(url, c.cta) + linkFallback(c.fallback, url),
      footerNote: c.footer,
    }),
    text: `${c.greeting(name)}\n\n${c.body}\n\n${c.cta}: ${url}\n\n${c.footer}\n`,
  };
}

const RESET_COPY = {
  es: {
    subject: 'Restablece tu contraseña de Goals',
    preheader: 'El enlace vence en 1 hora.',
    greeting: (name) => `Hola, ${name}`,
    body: 'Recibimos una solicitud para cambiar la contraseña de tu cuenta.',
    cta: 'Elegir una contraseña nueva',
    expiry: 'El enlace vence en 1 hora y solo sirve una vez.',
    fallback: 'Si el botón no funciona, copia este enlace en tu navegador:',
    footer: 'Si no fuiste tú, ignora este correo: tu contraseña no cambia.',
  },
  en: {
    subject: 'Reset your Goals password',
    preheader: 'The link expires in 1 hour.',
    greeting: (name) => `Hi ${name}`,
    body: 'We received a request to change the password for your account.',
    cta: 'Choose a new password',
    expiry: 'The link expires in 1 hour and works only once.',
    fallback: "If the button doesn't work, paste this link into your browser:",
    footer: "If this wasn't you, ignore this email: your password stays the same.",
  },
};

export function resetPasswordEmail({ name, token, language }) {
  const lang = pickLang(language);
  const c = RESET_COPY[lang];
  const url = `${appUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const greeting = c.greeting(escapeHtml(name));
  return {
    subject: c.subject,
    html: renderLayout({
      lang,
      title: c.subject,
      preheader: c.preheader,
      bodyHtml:
        h1(greeting) + p(c.body) + button(url, c.cta) + small(c.expiry) + linkFallback(c.fallback, url),
      footerNote: c.footer,
    }),
    text: `${c.greeting(name)}\n\n${c.body}\n\n${c.cta}: ${url}\n\n${c.expiry}\n\n${c.footer}\n`,
  };
}

const BUDGET_ALERT_COPY = {
  es: {
    subject80: (cat) => `Ya usaste el 80% del presupuesto de ${cat}`,
    subject100: (cat) => `Llegaste al límite del presupuesto de ${cat}`,
    greeting: (name) => `Hola, ${name}`,
    body: (cat, spent, budget, pct) =>
      `Este mes llevas <strong>${spent}</strong> de <strong>${budget}</strong> en ${cat} (${pct}%).`,
    hint80: 'Todavía te queda margen, pero conviene revisar los próximos gastos.',
    hint100: 'Los gastos que sumes en esta categoría ya quedan por encima de lo planeado.',
    cta: 'Ver mi presupuesto',
    footer: 'Puedes desactivar estos avisos en tu perfil de Goals.',
  },
  en: {
    subject80: (cat) => `You've used 80% of your ${cat} budget`,
    subject100: (cat) => `You've reached your ${cat} budget`,
    greeting: (name) => `Hi ${name}`,
    body: (cat, spent, budget, pct) =>
      `This month you've spent <strong>${spent}</strong> of <strong>${budget}</strong> on ${cat} (${pct}%).`,
    hint80: "There's still some room, but it's worth keeping an eye on upcoming expenses.",
    hint100: 'Anything else you add to this category goes over what you planned.',
    cta: 'See my budget',
    footer: 'You can turn these alerts off in your Goals profile.',
  },
};

export function budgetAlertEmail({ name, language, categoryName, threshold, spent, budget, percent }) {
  const lang = pickLang(language);
  const c = BUDGET_ALERT_COPY[lang];
  const url = `${appUrl()}/transactions/budget`;
  const reached = threshold >= 100;
  const subject = reached ? c.subject100(categoryName) : c.subject80(categoryName);
  const hint = reached ? c.hint100 : c.hint80;
  const body = c.body(escapeHtml(categoryName), escapeHtml(spent), escapeHtml(budget), escapeHtml(percent));
  return {
    subject,
    html: renderLayout({
      lang,
      title: subject,
      preheader: hint,
      bodyHtml: h1(c.greeting(escapeHtml(name))) + p(body) + p(hint) + button(url, c.cta),
      footerNote: c.footer,
    }),
    text: `${c.greeting(name)}\n\n${c.body(categoryName, spent, budget, percent).replace(/<\/?strong>/g, '')}\n\n${hint}\n\n${c.cta}: ${url}\n\n${c.footer}\n`,
  };
}
