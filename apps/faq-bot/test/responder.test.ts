import { describe, expect, it } from 'vitest';
import { BusinessConfig, Responder, detectIntent, type FaqAnswerer } from '../src/responder.ts';

const cfg = BusinessConfig.parse({
  name: 'Rei do Suco',
  hours: {
    timezone: 'America/Sao_Paulo',
    weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, ranges: [{ open: '08:00', close: '18:00' }] })),
  },
  address: 'Rua das Frutas, 123',
  delivery: { enabled: true, fee: 'R$ 5,00', notes: 'Entregamos em até 40 minutos.' },
  payment_methods: ['Pix', 'cartão', 'dinheiro'],
  menu_url: 'https://example.com/cardapio',
  faq: [
    { question: 'Tem suco sem açúcar?', answer: 'Sim, todos os sucos podem ser feitos sem açúcar.', keywords: ['sem acucar', 'diet'] },
    { question: 'Tem vaga de emprego?', answer: 'Mande seu currículo para vagas@example.com.', keywords: ['vaga', 'emprego'] },
  ],
});

const MON_10H = new Date('2026-11-09T10:00:00-03:00');
const MON_22H = new Date('2026-11-09T22:00:00-03:00');

describe('detectIntent', () => {
  it.each([
    ['que horas vocês abrem?', 'hours'],
    ['Vcs estão abertos hoje?', 'open_now'],
    ['qual o endereço', 'address'],
    ['Tem cardápio?', 'menu'],
    ['fazem entrega?', 'delivery'],
    ['aceita pix', 'payment'],
    ['quero falar com o dono', 'human'],
    ['Bom dia!', 'greeting'],
    ['blablabla', 'unknown'],
  ])('%s -> %s', (text, intent) => {
    expect(detectIntent(text)).toBe(intent);
  });

  it('pedido de humano ganha de qualquer outra intenção', () => {
    expect(detectIntent('quero reclamar da entrega')).toBe('human');
  });
});

describe('Responder (regras)', () => {
  const r = new Responder(cfg);

  it('horário usa o relógio do negócio e diz se está aberto', async () => {
    const reply = await r.reply({ text: 'qual o horário?' }, MON_10H);
    expect(reply).toMatchObject({ type: 'text', source: 'rule' });
    expect((reply as { text: string }).text).toContain('Seg a Sáb: 8h às 18h');
    expect((reply as { text: string }).text).toContain('Estamos abertos agora');
  });

  it('fora do horário nunca diz que está aberto', async () => {
    const reply = await r.reply({ text: 'vocês estão abertos?' }, MON_22H);
    expect((reply as { text: string }).text).toBe('No momento estamos fechados. Voltamos a atender amanhã às 8h.');
  });

  it('saudação traz botões e o estado atual', async () => {
    const reply = await r.reply({ text: 'oi' }, MON_22H);
    expect(reply.type).toBe('buttons');
    expect((reply as { text: string }).text).toContain('fechados');
  });

  it('botão de atendente vira handoff', async () => {
    expect((await r.reply({ choiceId: 'human' }, MON_10H)).type).toBe('handoff');
  });

  it('entrega e pagamento vêm da configuração', async () => {
    expect(((await r.reply({ text: 'entregam?' })) as { text: string }).text).toContain('R$ 5,00');
    expect(((await r.reply({ text: 'aceitam pix?' })) as { text: string }).text).toContain('Pix, cartão, dinheiro');
  });

  it('endereço ausente na config não é inventado: cai no handoff', async () => {
    const semEndereco = new Responder(BusinessConfig.parse({ ...cfg, address: undefined }));
    expect((await semEndereco.reply({ text: 'onde fica?' })).type).toBe('handoff');
  });
});

describe('Responder (FAQ e LLM restrito)', () => {
  it('responde pela FAQ do dono por palavra-chave, sem chamar o LLM', async () => {
    let called = false;
    const llm: FaqAnswerer = { answer: async () => ((called = true), 'x') };
    const reply = await new Responder(cfg, llm).reply({ text: 'tem suco diet?' });
    expect(reply).toMatchObject({ type: 'text', source: 'faq' });
    expect(called).toBe(false);
  });

  it('usa o LLM quando a pergunta não bate com palavra-chave', async () => {
    const llm: FaqAnswerer = { answer: async () => 'Sim, todos os sucos podem ser feitos sem açúcar.' };
    const reply = await new Responder(cfg, llm).reply({ text: 'dá pra pedir o de laranja sem adoçar?' });
    expect(reply).toMatchObject({ type: 'text', source: 'llm' });
  });

  it('bloqueia resposta do LLM com número que não está na base (preço inventado)', async () => {
    const llm: FaqAnswerer = { answer: async () => 'O suco de laranja custa R$ 12,50.' };
    const reply = await new Responder(cfg, llm).reply({ text: 'quanto sai o de laranja grande?' });
    expect(reply.type).toBe('handoff');
  });

  it('LLM fora do ar -> handoff, nunca silêncio', async () => {
    const llm: FaqAnswerer = { answer: async () => { throw new Error('timeout'); } };
    const reply = await new Responder(cfg, llm).reply({ text: 'vocês têm açaí?' });
    expect(reply).toMatchObject({ type: 'handoff', reason: 'llm_unavailable' });
  });

  it('LLM que não sabe (null) -> handoff', async () => {
    const llm: FaqAnswerer = { answer: async () => null };
    expect((await new Responder(cfg, llm).reply({ text: 'têm açaí?' })).type).toBe('handoff');
  });

  it('sem LLM configurado, pergunta fora da base vai para humano', async () => {
    const reply = await new Responder(cfg).reply({ text: 'posso levar meu cachorro?' }, MON_22H);
    expect(reply.type).toBe('handoff');
    expect((reply as { text: string }).text).toContain('Voltamos a atender amanhã às 8h');
  });
});
