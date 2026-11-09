import { describe, expect, it } from 'vitest';
import { Responder } from '../src/responder.ts';
import { reiDoSuco } from '../src/tenants/rei-do-suco.ts';
import { REI_DO_SUCO_ZONES } from '../src/tenants/rei-do-suco-zones.ts';
import { lookupDelivery, formatDelivery } from '../src/delivery.ts';

const r = new Responder(reiDoSuco);
const reply = async (q: string) => r.reply({ text: q }, new Date('2026-11-11T20:00:00-03:00'));
const text = async (q: string) => ((await reply(q)) as { text: string }).text;

describe('tabela de taxas', () => {
  it('traz todos os bairros dos dois PDFs', () => {
    expect(REI_DO_SUCO_ZONES.filter((z) => z.city === 'americana')).toHaveLength(117);
    expect(REI_DO_SUCO_ZONES.filter((z) => z.city === 'santa_barbara')).toHaveLength(115);
  });

  it('valores âncora conferidos nos PDFs', () => {
    const fee = (city: string, name: string) => REI_DO_SUCO_ZONES.find((z) => z.city === city && z.name === name)?.fee;
    expect(fee('americana', 'Ipiranga, Jardim')).toBe(400);
    expect(fee('americana', 'Iate Clube de Campinas')).toBe(1800);
    expect(fee('americana', 'Imperador, Jardim')).toBe(1800);
    expect(fee('santa_barbara', 'Dona Margarida, Residencial')).toBe(1500);
    expect(fee('santa_barbara', 'Firenze, Jardim')).toBe(1500);
    expect(fee('santa_barbara', 'Geriva, Jardim')).toBe(500);
  });

  it('não leva a chave Pix nem CPF do rodapé dos PDFs', () => {
    const all = JSON.stringify(REI_DO_SUCO_ZONES) + JSON.stringify(reiDoSuco);
    expect(all).not.toMatch(/385\.798|Manzo|Ita[uú]/i);
  });

  it('typos do PDF foram corrigidos', () => {
    const names = REI_DO_SUCO_ZONES.map((z) => z.name).join('|');
    expect(names).not.toMatch(/Jarsim|Jardum|Vika|Presboteriano/);
  });
});

describe('abreviações: jd, pq, vl valem jardim, parque, vila', () => {
  it.each([
    ['taxa de entrega para jardim ipiranga', 'R$ 4,00'],
    ['entrega no jd ipiranga', 'R$ 4,00'],
    ['Jd. Ipiranga', 'R$ 4,00'],
    ['jdm ipiranga', 'R$ 4,00'],
    ['entrega pq eldorado', 'R$ 10,00'],
    ['entrega parque eldorado', 'R$ 10,00'],
    ['quanto é a entrega no vl rica?', 'R$ 12,00'],
    ['vila rica', 'R$ 12,00'],
    ['moro no pq das nações', 'R$ 7,00'],
    ['jd imperador', 'R$ 18,00'],
  ])('%s -> %s', async (q, fee) => {
    expect(await text(q)).toContain(fee);
  });

  it('o tipo escrito no formato do PDF ("Brasília, Jardim") também funciona', async () => {
    expect(await text('entrega no brasília jardim')).toContain('R$ 6,00');
  });

  it('o tipo errado não acerta outro bairro: Vila Mariana (Americana) não é Jardim Mariana (Santa Bárbara)', () => {
    const vila = lookupDelivery(REI_DO_SUCO_ZONES, 'entrega vl mariana');
    expect(vila?.kind).toBe('found');
    if (vila?.kind === 'found') {
      expect(vila.fee).toBe(1000);
      expect(vila.zones.every((z) => z.city === 'americana')).toBe(true);
    }
    const jardim = lookupDelivery(REI_DO_SUCO_ZONES, 'entrega jd mariana');
    expect(jardim?.kind).toBe('found');
    if (jardim?.kind === 'found') expect(jardim.fee).toBe(800);
  });
});

describe('mesmo nome em Americana e Santa Bárbara', () => {
  it('sem cidade e com valores diferentes: mostra os dois e pergunta', async () => {
    const t = await text('entrega jardim primavera');
    expect(t).toContain('Americana');
    expect(t).toContain('R$ 6,00');
    expect(t).toContain("Santa Bárbara d'Oeste");
    expect(t).toContain('R$ 12,00');
    expect(t).toContain('Qual é o seu?');
  });

  it('com a cidade, responde só o dela', async () => {
    expect(await text('entrega jardim primavera em americana')).toContain('R$ 6,00');
    expect(await text('entrega jardim primavera santa bárbara')).toContain('R$ 12,00');
    expect(await text('entrega jd primavera sbo')).toContain('R$ 12,00');
  });

  it('valor igual nas duas cidades: responde direto', async () => {
    const t = await text('entrega vila dainese');
    expect(t).toContain('R$ 6,00');
    expect(t).not.toContain('Qual é o seu?');
  });
});

describe('Jardim Mollon e Jardim Ferdinando Mollon são o mesmo bairro (R$ 5,00)', () => {
  it.each([
    'entrega jardim mollon',
    'entrega jd ferdinando mollon',
    'entrega jardim fernando mollon',
    'taxa mollon',
    'entrega jd mollon em santa bárbara',
  ])('%s -> R$ 5,00', async (q) => {
    const rep = await reply(q);
    expect(rep.type).toBe('text');
    expect((rep as { text: string }).text).toContain('R$ 5,00');
  });

  it('não existe mais a linha divergente de R$ 6,00', () => {
    expect(REI_DO_SUCO_ZONES.some((z) => z.name.includes('Fernando Mollon'))).toBe(false);
    const a = lookupDelivery(REI_DO_SUCO_ZONES, 'entrega jardim mollon');
    const b = lookupDelivery(REI_DO_SUCO_ZONES, 'entrega jardim ferdinando mollon');
    expect(a?.kind).toBe('found');
    expect(b?.kind).toBe('found');
    if (a?.kind === 'found' && b?.kind === 'found') expect(a.fee).toBe(b.fee);
  });
});

describe('situações comuns', () => {
  it('bairro desconhecido vai para um humano, sem inventar taxa', async () => {
    const rep = await reply('entrega no jardim das estrelas?');
    expect(rep.type).toBe('handoff');
    expect((rep as { text: string }).text).not.toMatch(/R\$/);
  });

  it('só o nome do bairro, como resposta a "qual seu bairro?"', async () => {
    expect(await text('Jd Brasília')).toContain('R$ 6,00');
  });

  it('bairros cujo nome contém a cidade', async () => {
    expect(await text('entrega terras de santa bárbara')).toContain('R$ 8,00');
    expect(await text('iate clube de americana')).toContain('R$ 15,00');
  });

  it('nomes com número romano distinguem variantes', async () => {
    expect(await text('entrega jd cândido bertini ii')).toContain('R$ 7,00');
    const t = await text('entrega parque santa rosa');
    expect(t).toContain('R$ 6,00');
    expect(t).toContain('R$ 8,00');
  });

  it('frase sobre outra coisa não vira consulta de bairro', async () => {
    expect((await reply('vocês fazem entrega hoje?')).type).toBe('text');
    expect(await text('vocês fazem entrega hoje?')).toContain('bairro e a cidade');
  });

  it('formatDelivery do achado único cita cidade e pagamento na entrega', () => {
    const f = lookupDelivery(REI_DO_SUCO_ZONES, 'jd ipiranga');
    expect(f && formatDelivery(f).text).toBe(
      'A taxa de entrega para Jardim Ipiranga (Americana) é R$ 4,00. O pagamento é feito na entrega.',
    );
  });
});
