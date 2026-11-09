import { describe, expect, it } from 'vitest';
import { Responder } from '../src/responder.ts';
import { reiDoSuco } from '../src/tenants/rei-do-suco.ts';
import { MENU } from '../src/menu.ts';
import { openStatus } from '../src/hours.ts';

const r = new Responder(reiDoSuco);
const ask = async (text: string, now = new Date('2026-11-11T20:00:00-03:00')) => {
  const reply = await r.reply({ text }, now);
  return reply.type === 'buttons' || reply.type === 'text' || reply.type === 'handoff' ? reply : reply;
};
const text = async (q: string, now?: Date) => ((await ask(q, now)) as { text: string }).text;

describe('horário real: quarta a domingo, 18h às 23h30', () => {
  const cfg = reiDoSuco.hours;
  it.each([
    ['2026-11-09T20:00:00-03:00', false], // segunda
    ['2026-11-10T20:00:00-03:00', false], // terça
    ['2026-11-11T17:59:00-03:00', false], // quarta, 1 min antes
    ['2026-11-11T18:00:00-03:00', true], // quarta, abre
    ['2026-11-11T23:29:00-03:00', true],
    ['2026-11-11T23:30:00-03:00', false], // fecha
    ['2026-11-15T21:00:00-03:00', true], // domingo
    ['2026-11-16T21:00:00-03:00', false], // segunda de novo
  ])('%s -> aberto=%s', (iso, open) => {
    expect(openStatus(cfg, new Date(iso)).isOpen).toBe(open);
  });

  it('na segunda diz que volta na quarta às 18h', async () => {
    expect(await text('vocês estão abertos?', new Date('2026-11-09T20:00:00-03:00'))).toBe(
      'No momento estamos fechados. Voltamos a atender quarta-feira às 18h.',
    );
  });

  it('resumo da semana', async () => {
    const t = await text('qual o horário de funcionamento?', new Date('2026-11-09T20:00:00-03:00'));
    expect(t).toContain('Seg e Ter: fechado');
    expect(t).toContain('Qua a Dom: 18h às 23h30');
  });
});

describe('preços do cardápio', () => {
  it('suco com todas as bases', async () => {
    expect(await text('quanto é o suco de morango?')).toBe(
      'Suco de morango (500ml): na água R$ 14,50 · na laranja R$ 17,00 · no leite R$ 17,00 · frapê R$ 19,50 · no vinho R$ 22,50.',
    );
  });

  it('suco com base escolhida', async () => {
    expect(await text('suco de morango na laranja')).toBe('Suco de morango (500ml) na laranja: R$ 17,00.');
    expect(await text('quanto custa o de maracujá no leite?')).toBe('Suco de maracujá (500ml) no leite: R$ 15,50.');
  });

  it('salada de frutas não existe na água', async () => {
    const t = await text('suco salada de frutas');
    expect(t).not.toContain('na água');
    expect(t).toContain('na laranja R$ 17,50');
  });

  it('pastel salgado simples', async () => {
    expect(await text('quanto é o pastel de frango?')).toBe('Pastel de frango: R$ 14,50.');
    expect(await text('tem pastel de camarão?')).toBe('Pastel de camarão: R$ 19,00.');
    expect(await text('pastel de salmão')).toBe('Pastel de salmão: R$ 29,00.');
  });

  it('pastel doce e sugestão da casa', async () => {
    expect(await text('pastel doce de nutella')).toContain('R$ 19,00');
    expect(await text('quanto é o pastemaki?')).toContain('R$ 39,00');
    expect(await text('X-tudo')).toContain('R$ 25,00');
  });

  it('açaí no copo por tamanho', async () => {
    expect(await text('açaí 500ml')).toBe('Açaí 500ml (puro): R$ 19,00.');
    expect(await text('açaí 300 ml no copo')).toBe('Açaí 300ml (puro): R$ 16,00.');
  });

  it('bebidas', async () => {
    expect(await text('coca 2l')).toBe('Coca-Cola 2L: R$ 15,00.');
    expect(await text('tem heineken?')).toBe('Heineken: R$ 8,00.');
  });

  it('mini pizza', async () => {
    expect(await text('mini pizza de quatro queijos')).toContain('R$ 16,00');
  });

  it('item inexistente nunca recebe preço inventado: vai para humano', async () => {
    const reply = await ask('quanto é o pastel de dinossauro?');
    expect(reply.type).toBe('handoff');
  });

  it('pergunta genérica de cardápio lista as categorias', async () => {
    expect(await text('qual o cardápio?')).toContain('sucos, açaí e cupuaçu no copo, pastéis');
  });
});

describe('integridade do cardápio transcrito', () => {
  it('todos os preços são positivos e múltiplos de 5 centavos (exceto orégano)', () => {
    for (const item of MENU) {
      const prices = item.variants ? Object.values(item.variants) : [item.price ?? 0];
      for (const p of prices) {
        expect(p, item.name).toBeGreaterThan(0);
        if (!item.name.startsWith('Orégano')) expect(p % 50, item.name).toBe(0);
      }
    }
  });

  it('preços-âncora conferidos na imagem', () => {
    const price = (name: string, base?: string) => {
      const it = MENU.find((m) => m.name === name);
      return base ? it?.variants?.[base] : it?.price;
    };
    expect(price('Suco de detox', 'vinho')).toBe(2000);
    expect(price('Suco de framboesa', 'laranja')).toBe(2050);
    expect(price('Suco de limão', 'água')).toBe(1200);
    expect(price('Suco de uva', 'frapê')).toBe(1750);
    expect(price('Pastel de salmão')).toBe(2900);
    expect(price('Pastemaki')).toBe(3900);
    expect(price('Pastel doce de Ferrero Rocher')).toBe(2500);
    expect(price('Coca-Cola 2L zero')).toBe(1600);
  });

  it('tem a quantidade de itens esperada por categoria', () => {
    const count = (cat: string) => MENU.filter((m) => m.category === cat).length;
    expect(count('suco')).toBe(27 + 3);
    expect(count('pastel_salgado')).toBe(22);
    expect(count('pastel_sugestao')).toBe(30);
    expect(count('pastel_doce')).toBe(42);
    expect(count('mini_pizza_salgada')).toBe(12);
    expect(count('bebida')).toBe(16);
  });
});
