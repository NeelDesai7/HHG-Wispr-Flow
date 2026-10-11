// Data minimisation for app events (phone notifications, messages you send).
// Runs before the model sees anything. An event is either withheld (only the reason is
// counted, never the text) or passed on with card numbers masked. The phone also filters
// before sending; this is the same check again on the laptop, so nothing sensitive is read
// even if a raw event slips through.

// Password managers: nothing they show is ever read.
const PASSWORD_APPS = /(1password|bitwarden|keepass|lastpass|dashlane|nordpass|enpass|roboform|proton\s*pass)/i;

const OTP = /\b(otp|one[\s-]?time\s*(password|pin|code)|verification\s+code|security\s+code|auth(entication)?\s+code|login\s+code|sign[\s-]?in\s+code|passcode|2fa|two[\s-]factor)\b/i;
const CODE_NEAR_DIGITS = /\b(code|pin|otp)\b[^.\n]{0,40}\b\d{3,8}\b|\b\d{3,8}\b[^.\n]{0,40}\b(code|pin|otp)\b/i;
const SECRET_WORDS = /\b(password|passwd|pwd|cvv|cvc|upi\s*pin|atm\s*pin|m[\s-]?pin|secret\s*key|private\s*key|recovery\s*(phrase|code)|seed\s*phrase)\b/i;
// API keys and tokens: known prefixes.
const TOKEN = /\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/;

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// "4111 1111 1111 1111" → "card ending 1111", only for numbers that pass the card checksum.
export function maskCards(text) {
  return text.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? `card ending ${digits.slice(-4)}` : m;
  });
}

// Returns { withheld: reason } or { event } with text cleaned and clamped.
// The protections default ON, so by default OTPs, passwords and keys are withheld and cards are
// masked. The user can turn any protection off in Settings to let that kind through.
// Password-manager content is always dropped.
export function screen(event, { hideOtp = true, hidePasswords = true, hideKeys = true, maskCards: mask = true } = {}) {
  const app = event.app ?? '';
  if (PASSWORD_APPS.test(app)) return { withheld: 'password manager' };
  const text = [event.title, event.body].filter(Boolean).join('\n');
  if (!text.trim()) return { withheld: 'empty' };
  if (hideOtp && (OTP.test(text) || CODE_NEAR_DIGITS.test(text))) return { withheld: 'one-time code' };
  if (hidePasswords && SECRET_WORDS.test(text)) return { withheld: 'password or PIN' };
  if (hideKeys && TOKEN.test(text)) return { withheld: 'key or token' };
  const clean = (s) => {
    if (!s) return '';
    const masked = mask ? maskCards(s) : s;
    return masked.replace(/\s+/g, ' ').trim().slice(0, 400);
  };
  return { event: { app: String(app).slice(0, 60), kind: event.kind, title: clean(event.title), body: clean(event.body), at: event.at } };
}
