import { createHmac, timingSafeEqual } from 'node:crypto';
import { SlotTokenPayload } from '@app/contracts';

/**
 * `slot_id` é um token assinado, não um id de banco. Assim o agente de conversa
 * só consegue reservar um horário que a API realmente ofereceu: ele não tem
 * como montar um slot em cima de um bloqueio, de uma janela reservada a que o
 * pedido não tem direito, ou fora da jornada.
 *
 * Formato: base64url(payload JSON) + "." + base64url(HMAC-SHA256).
 */

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function signSlotToken(payload: SlotTokenPayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

export type SlotTokenResult =
  | { ok: true; payload: SlotTokenPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifySlotToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): SlotTokenResult {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };

  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = b64url(createHmac('sha256', secret).update(body).digest());

  const given = Buffer.from(mac);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const parsed = SlotTokenPayload.safeParse(parsedJson);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  if (parsed.data.x <= now.getTime()) return { ok: false, reason: 'expired' };

  return { ok: true, payload: parsed.data };
}
