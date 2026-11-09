import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildButtonsPayload,
  parseInbound,
  verifyMetaSignature,
  verifyWebhookChallenge,
} from '../src/whatsapp.ts';

const SECRET = 'app-secret-123456';
const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

describe('assinatura do webhook', () => {
  const body = JSON.stringify({ entry: [] });

  it('aceita a assinatura correta', () => {
    expect(verifyMetaSignature(body, sign(body), SECRET)).toBe(true);
  });
  it('recusa corpo adulterado, header ausente, prefixo errado e segredo errado', () => {
    expect(verifyMetaSignature(body + ' ', sign(body), SECRET)).toBe(false);
    expect(verifyMetaSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(body, sign(body).replace('sha256=', 'sha1='), SECRET)).toBe(false);
    expect(verifyMetaSignature(body, sign(body), 'outro-segredo-123456')).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=zz', SECRET)).toBe(false);
  });
});

describe('verificação inicial do webhook', () => {
  it('devolve o challenge só com o token certo', () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '12345' };
    expect(verifyWebhookChallenge(q, 'tok')).toBe('12345');
    expect(verifyWebhookChallenge(q, 'errado')).toBeNull();
    expect(verifyWebhookChallenge({ ...q, 'hub.mode': 'x' }, 'tok')).toBeNull();
  });
});

describe('parseInbound', () => {
  const wrap = (messages: unknown[]) => ({
    entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PN1' }, messages } }] }],
  });

  it('lê texto, áudio e resposta de botão', () => {
    const msgs = parseInbound(
      wrap([
        { id: 'm1', from: '5511999990000', type: 'text', text: { body: 'que horas abre?' } },
        { id: 'm2', from: '5511999990000', type: 'audio', audio: { id: 'media1' } },
        { id: 'm3', from: '5511999990000', type: 'interactive', interactive: { button_reply: { id: 'hours', title: 'Horário' } } },
        { id: 'm4', from: '5511999990000', type: 'image' },
      ]),
    );
    expect(msgs.map((m) => m.kind)).toEqual(['text', 'audio', 'choice', 'unsupported']);
    expect(msgs[0]).toMatchObject({ text: 'que horas abre?', phoneNumberId: 'PN1' });
  });

  it('ignora notificações de status (sem messages) e payload inválido', () => {
    expect(parseInbound({ entry: [{ changes: [{ value: { statuses: [{ id: 'x' }] } }] }] })).toEqual([]);
    expect(parseInbound('lixo')).toEqual([]);
    expect(parseInbound(null)).toEqual([]);
  });
});

describe('botões', () => {
  it('limita a 3 botões e corta títulos em 20 caracteres', () => {
    const p = buildButtonsPayload('55', {
      text: 'Como posso ajudar?',
      buttons: [{ id: 'a', title: 'Um título muito mais longo que vinte' }],
    });
    expect(p.interactive.action.buttons[0]?.reply.title).toHaveLength(20);
    expect(() =>
      buildButtonsPayload('55', { text: 'x', buttons: [1, 2, 3, 4].map((n) => ({ id: String(n), title: 'x' })) }),
    ).toThrow();
  });
});
