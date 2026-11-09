import { describe, expect, it } from 'vitest';
import { BusinessHoursConfig, openStatus, openStatusMessage, weeklySummary } from '../src/hours.ts';

const cfg = BusinessHoursConfig.parse({
  timezone: 'America/Sao_Paulo',
  weekly: [
    ...[1, 2, 3, 4, 5].map((weekday) => ({
      weekday,
      ranges: [
        { open: '08:00', close: '12:00' },
        { open: '14:00', close: '19:00' },
      ],
    })),
    { weekday: 6, ranges: [{ open: '08:00', close: '14:00' }] },
  ],
  holidays: [
    { date: '2026-11-20', name: 'Consciência Negra' },
    { date: '2026-12-24', name: 'véspera de Natal', ranges: [{ open: '08:00', close: '12:00' }] },
  ],
});

// 2026-11-09 é segunda-feira. São Paulo = UTC-3 (sem horário de verão).
const at = (iso: string) => new Date(iso);

describe('openStatus', () => {
  it('aberto no meio da manhã', () => {
    const s = openStatus(cfg, at('2026-11-09T10:00:00-03:00'));
    expect(s.isOpen).toBe(true);
    expect(s.closesAt).toBe('12:00');
    expect(openStatusMessage(s)).toBe('Estamos abertos agora! Hoje atendemos até as 12h.');
  });

  it('fechado no almoço, volta hoje às 14h', () => {
    const s = openStatus(cfg, at('2026-11-09T12:30:00-03:00'));
    expect(s.isOpen).toBe(false);
    expect(s.next?.isToday).toBe(true);
    expect(openStatusMessage(s)).toBe('No momento estamos fechados. Voltamos a atender hoje às 14h.');
  });

  it('exatamente na hora de fechar já está fechado; exatamente na de abrir já está aberto', () => {
    expect(openStatus(cfg, at('2026-11-09T12:00:00-03:00')).isOpen).toBe(false);
    expect(openStatus(cfg, at('2026-11-09T14:00:00-03:00')).isOpen).toBe(true);
  });

  it('fora do horário à noite: abre amanhã', () => {
    const s = openStatus(cfg, at('2026-11-09T22:00:00-03:00'));
    expect(openStatusMessage(s)).toBe('No momento estamos fechados. Voltamos a atender amanhã às 8h.');
  });

  it('de madrugada abre hoje cedo', () => {
    const s = openStatus(cfg, at('2026-11-09T02:30:00-03:00'));
    expect(openStatusMessage(s)).toBe('No momento estamos fechados. Voltamos a atender hoje às 8h.');
  });

  it('sábado à tarde: domingo fechado, volta segunda-feira', () => {
    const s = openStatus(cfg, at('2026-11-14T16:00:00-03:00'));
    expect(s.isOpen).toBe(false);
    expect(openStatusMessage(s)).toBe('No momento estamos fechados. Voltamos a atender segunda-feira às 8h.');
  });

  it('feriado fecha o dia todo e avisa o motivo', () => {
    const s = openStatus(cfg, at('2026-11-20T10:00:00-03:00')); // sexta, feriado
    expect(s.isOpen).toBe(false);
    expect(s.holidayName).toBe('Consciência Negra');
    expect(openStatusMessage(s)).toBe(
      'Hoje é Consciência Negra e estamos fechados. Voltamos a atender amanhã às 8h.',
    );
  });

  it('feriado com horário reduzido prevalece sobre a semana', () => {
    expect(openStatus(cfg, at('2026-12-24T10:00:00-03:00')).isOpen).toBe(true);
    expect(openStatus(cfg, at('2026-12-24T15:00:00-03:00')).isOpen).toBe(false);
  });

  it('usa o fuso do negócio, não o do servidor (UTC)', () => {
    // 02:00 UTC de segunda = 23:00 de domingo em São Paulo.
    const s = openStatus(cfg, at('2026-11-09T02:00:00Z'));
    expect(s.isOpen).toBe(false);
    expect(s.next?.weekday).toBe(1);
  });
});

describe('weeklySummary', () => {
  it('agrupa dias iguais', () => {
    expect(weeklySummary(cfg)).toBe('Seg a Sex: 8h às 12h e 14h às 19h | Sáb: 8h às 14h | Dom: fechado');
  });
});
