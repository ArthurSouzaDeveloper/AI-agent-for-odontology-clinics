import { describe, expect, it, vi } from 'vitest';
import { GraphSender, WhatsAppOwnerNotifier, maskPhone } from '../src/graph.ts';

describe('GraphSender', () => {
  it('envia para a URL certa com Bearer e corpo JSON', async () => {
    const fetchFn = vi.fn(async (_url: string, _init: { method: string; headers: Record<string, string>; body: string }) => ({ ok: true, status: 200, text: async () => '' }));
    await new GraphSender('tok-123456', 'v21.0', fetchFn).send('1234567890', { hello: 'world' });
    const [url, init] = fetchFn.mock.calls[0]!;
    if (!init) throw new Error('sem init');
    expect(url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(init.headers.authorization).toBe('Bearer tok-123456');
    expect(JSON.parse(init.body)).toEqual({ hello: 'world' });
  });

  it('erro da Graph API vira exceção sem vazar o token', async () => {
    const fetchFn = vi.fn(async (_url: string, _init: { method: string; headers: Record<string, string>; body: string }) => ({ ok: false, status: 401, text: async () => '{"error":"bad token"}' }));
    const p = new GraphSender('tok-secret-xyz', 'v21.0', fetchFn).send('1234567890', {});
    await expect(p).rejects.toThrow('401');
    await expect(p).rejects.not.toThrow('tok-secret-xyz');
  });

  it('recusa phone_number_id que não seja numérico (vai no caminho da URL)', async () => {
    const fetchFn = vi.fn();
    await expect(new GraphSender('tok-123456', 'v21.0', fetchFn as never).send('../admin', {})).rejects.toThrow('inválido');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('WhatsAppOwnerNotifier', () => {
  it('avisa o dono com o telefone mascarado e um link para responder', async () => {
    const sent: unknown[] = [];
    const n = new WhatsAppOwnerNotifier({ send: async (_id, body) => void sent.push(body) }, '999', '5519988887777');
    await n.notify({ from: '5511999990000', reason: 'customer_request', lastMessage: 'quero falar com o dono' });
    const text = (sent[0] as { text: { body: string } }).text.body;
    expect(text).toContain('5511…00');
    expect(text).not.toContain('5511999990000)');
    expect(text).toContain('wa.me/5511999990000');
    expect(text).toContain('quero falar com o dono');
  });

  it('falha no aviso não derruba o atendimento', async () => {
    const log = vi.fn();
    const n = new WhatsAppOwnerNotifier({ send: async () => { throw new Error('fora da janela de 24h'); } }, '999', '55', log);
    await expect(n.notify({ from: '5511', reason: 'not_in_faq' })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it('maskPhone', () => {
    expect(maskPhone('5511999990000')).toBe('5511…00');
    expect(maskPhone('12')).toBe('****');
  });
});
