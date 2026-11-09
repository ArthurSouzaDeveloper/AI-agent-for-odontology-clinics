import { z } from 'zod';

/**
 * Horário de funcionamento calculado por código, nunca pelo LLM: o bot não
 * pode dizer "estamos abertos" num feriado ou depois de fechar.
 */

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** 1 = segunda ... 7 = domingo (ISO-8601). */
export const DayHours = z.object({
  weekday: z.number().int().min(1).max(7),
  /** Mais de uma faixa por dia cobre o intervalo de almoço. */
  ranges: z.array(z.object({ open: Time, close: Time })).min(1),
});

export const Holiday = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name: z.string(),
  /** Ausente = fechado o dia todo. */
  ranges: z.array(z.object({ open: Time, close: Time })).optional(),
});

export const BusinessHoursConfig = z.object({
  timezone: z.string().default('America/Sao_Paulo'),
  weekly: z.array(DayHours),
  holidays: z.array(Holiday).default([]),
});
export type BusinessHoursConfig = z.infer<typeof BusinessHoursConfig>;

export interface OpenStatus {
  isOpen: boolean;
  /** Fecha às (hora local HH:MM), quando aberto. */
  closesAt?: string;
  /** Próxima abertura, quando fechado. */
  next?: { date: string; weekday: number; open: string; isToday: boolean; isTomorrow: boolean };
  holidayName?: string;
}

interface LocalNow {
  date: string;
  weekday: number;
  minutes: number;
}

function localNow(now: Date, timeZone: string): LocalNow {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday ?? '') + 1;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function addDays(date: string, days: number): { date: string; weekday: number } {
  const [y, m, d] = date.split('-').map(Number);
  const out = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return {
    date: out.toISOString().slice(0, 10),
    weekday: ((out.getUTCDay() + 6) % 7) + 1,
  };
}

function rangesFor(cfg: BusinessHoursConfig, date: string, weekday: number) {
  const holiday = cfg.holidays.find((h) => h.date === date);
  if (holiday) return { ranges: holiday.ranges ?? [], holiday };
  return { ranges: cfg.weekly.find((w) => w.weekday === weekday)?.ranges ?? [], holiday: undefined };
}

export function openStatus(cfg: BusinessHoursConfig, now: Date = new Date()): OpenStatus {
  const local = localNow(now, cfg.timezone);
  const today = rangesFor(cfg, local.date, local.weekday);

  for (const r of today.ranges) {
    if (local.minutes >= toMinutes(r.open) && local.minutes < toMinutes(r.close)) {
      return { isOpen: true, closesAt: r.close };
    }
  }

  // Fechado agora: procura a próxima faixa, hoje ainda ou nos próximos dias.
  const laterToday = today.ranges
    .filter((r) => toMinutes(r.open) > local.minutes)
    .sort((a, b) => toMinutes(a.open) - toMinutes(b.open))[0];
  const base: OpenStatus = { isOpen: false };
  if (today.holiday) base.holidayName = today.holiday.name;

  if (laterToday) {
    return {
      ...base,
      next: { date: local.date, weekday: local.weekday, open: laterToday.open, isToday: true, isTomorrow: false },
    };
  }

  for (let i = 1; i <= 14; i++) {
    const day = addDays(local.date, i);
    const found = rangesFor(cfg, day.date, day.weekday).ranges
      .slice()
      .sort((a, b) => toMinutes(a.open) - toMinutes(b.open))[0];
    if (found) {
      return {
        ...base,
        next: { date: day.date, weekday: day.weekday, open: found.open, isToday: false, isTomorrow: i === 1 },
      };
    }
  }
  return base;
}

const WEEKDAY_PT = [
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
  'domingo',
];

function human(hhmm: string): string {
  const [h, m] = hhmm.split(':');
  return m === '00' ? `${Number(h)}h` : `${Number(h)}h${m}`;
}

/** Frase pronta para o cliente, montada por código. */
export function openStatusMessage(status: OpenStatus): string {
  if (status.isOpen) {
    return `Estamos abertos agora! Hoje atendemos até as ${human(status.closesAt ?? '')}.`;
  }
  const prefix = status.holidayName ? `Hoje é ${status.holidayName} e estamos fechados. ` : 'No momento estamos fechados. ';
  if (!status.next) return `${prefix}Em breve a equipe informa nosso próximo horário.`;
  const when = status.next.isToday
    ? `hoje às ${human(status.next.open)}`
    : status.next.isTomorrow
      ? `amanhã às ${human(status.next.open)}`
      : `${WEEKDAY_PT[status.next.weekday - 1]} às ${human(status.next.open)}`;
  return `${prefix}Voltamos a atender ${when}.`;
}

/** Resumo da semana, ex.: "Seg a sex: 8h às 18h | Sáb: 8h às 14h | Dom: fechado". */
export function weeklySummary(cfg: BusinessHoursConfig): string {
  const parts = [1, 2, 3, 4, 5, 6, 7].map((wd) => {
    const r = cfg.weekly.find((w) => w.weekday === wd)?.ranges ?? [];
    return r.length === 0 ? 'fechado' : r.map((x) => `${human(x.open)} às ${human(x.close)}`).join(' e ');
  });
  const names = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

  const groups: Array<{ from: number; to: number; text: string }> = [];
  parts.forEach((text, i) => {
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.to = i;
    else groups.push({ from: i, to: i, text });
  });
  return groups
    .map((g) => {
      const label =
        g.from === g.to ? names[g.from] : g.to === g.from + 1 ? `${names[g.from]} e ${names[g.to]}` : `${names[g.from]} a ${names[g.to]}`;
      return `${label}: ${g.text}`;
    })
    .join(' | ');
}
