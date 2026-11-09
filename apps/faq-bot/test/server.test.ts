import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MemorySeenStore, buildServer, type HandoffNotifier, type Sender } from '../src/server.ts';
import { BusinessConfig } from '../src/responder.ts';

const SECRET = 'app-secret-123456';
const config = BusinessConfig.parse({
  name: 'Rei do Suco',
  hours: {
    timezone: 'America/Sao_Paulo',
    weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, ranges: [{ open: '08:00', close: '18:00' }] })),
  },
});

function setup(opts: { maxPerMinute?: number; apiToken?: string } = {}) {
  const sent: Array<{ phoneNumberId: string; body: any }> = [];
  const sender: Sender = { send: async (phoneNumberId, body) => void sent.push({ phoneNumberId, body }) };
  const notify = vi.fn(async () => {});
  const notifier: HandoffNotifier = { notify };
  const app = buildServer({
    appSecret: SECRET,
    verifyToken: 'verify-me',
    config: async () => config,
    sender,
    seen: new MemorySeenStore(),
    notifier,
    now: () => new Date('2026-11-09T22:00:00-03:00'),
    ...opts,
  });
  return { app, sent, notify };
}

const payload = (id: string, text: string, from = '5511999990000') =>
  JSON.stringify({
    entry: [
      {
        changes: [
          { value: { metadata: { phone_number_id: 'PN1' }, messages: [{ id, from, type: 'text', text: { body: text } }] } },
        ],
      },
    ],
  });
const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
const post = (app: ReturnType<typeof buildServer>, body: string, signature = sign(body)) =>
  app.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    payload: body,
  });
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('webhook', () => {
  it('GET de verificação devolve o challenge só com o token certo', async () => {
    const { app } = setup();
    const ok = await app.inject({ method: 'GET', url: '/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=777' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('777');
    const bad = await app.inject({ method: 'GET', url: '/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=777' });
    expect(bad.statusCode).toBe(403);
  });

  it('assinatura inválida é recusada e nada é enviado', async () => {
    const { app, sent } = setup();
    const body = payload('m1', 'oi');
    expect((await post(app, body, 'sha256=00')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/webhook', headers: { 'content-type': 'application/json' }, payload: body })).statusCode).toBe(401);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('responde horário fora do expediente, com o texto montado por código', async () => {
    const { app, sent } = setup();
    expect((await post(app, payload('m1', 'que horas vocês abrem?'))).statusCode).toBe(200);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.phoneNumberId).toBe('PN1');
    expect(sent[0]?.body.text.body).toContain('Voltamos a atender amanhã às 8h');
  });

  it('reenvio do mesmo webhook da Meta não gera resposta duplicada', async () => {
    const { app, sent } = setup();
    const body = payload('dup-1', 'oi');
    await post(app, body);
    await post(app, body);
    await post(app, body);
    await settle();
    expect(sent).toHaveLength(1);
  });

  it('pedido de atendente avisa o dono', async () => {
    const { app, notify } = setup();
    await post(app, payload('m2', 'quero falar com o dono'));
    await settle();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ reason: 'customer_request' }));
  });

  it('limita mensagens por cliente por minuto', async () => {
    const { app, sent } = setup({ maxPerMinute: 3 });
    for (let i = 0; i < 6; i++) await post(app, payload(`r${i}`, 'oi'));
    await settle();
    expect(sent).toHaveLength(3);
  });

  it('áudio recebe pedido de texto em vez de silêncio', async () => {
    const { app, sent } = setup();
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PN1' }, messages: [{ id: 'a1', from: '5511', type: 'audio', audio: { id: 'media1' } }] } }] }],
    });
    await post(app, body);
    await settle();
    expect(sent[0]?.body.text.body).toContain('Pode escrever');
  });
});

describe('POST /api/reply (canal genérico)', () => {
  const TOKEN = 'token-bem-longo-1234567890abc';
  const call = (app: ReturnType<typeof buildServer>, body: unknown, auth?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/reply',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      payload: JSON.stringify(body),
    });

  it('não existe sem API_TOKEN', async () => {
    const { app } = setup();
    expect((await call(app, { text: 'oi' }, `Bearer ${TOKEN}`)).statusCode).toBe(404);
  });

  it('exige o token certo', async () => {
    const { app } = setup({ apiToken: TOKEN });
    expect((await call(app, { text: 'oi' })).statusCode).toBe(401);
    expect((await call(app, { text: 'oi' }, 'Bearer errado')).statusCode).toBe(401);
  });

  it('responde o texto do cliente e rejeita corpo vazio', async () => {
    const { app } = setup({ apiToken: TOKEN });
    const ok = await call(app, { text: 'vocês estão abertos?' }, `Bearer ${TOKEN}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().handoff).toBe(false);
    expect((await call(app, {}, `Bearer ${TOKEN}`)).statusCode).toBe(400);
  });

  it('pedido de atendente volta com handoff e avisa o dono', async () => {
    const { app, notify } = setup({ apiToken: TOKEN });
    const res = await call(app, { text: 'quero falar com o dono', customerId: 'c1' }, `Bearer ${TOKEN}`);
    expect(res.json().handoff).toBe(true);
    expect(notify).toHaveBeenCalled();
  });
});
