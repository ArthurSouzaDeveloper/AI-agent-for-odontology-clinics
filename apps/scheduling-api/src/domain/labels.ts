/**
 * Rótulos em português montados pela API, não pelo LLM: assim a mensagem que
 * chega ao paciente tem a data que está no banco, e não a que o modelo achou
 * que era. O agente só repassa `label_pt` / `confirmation_label_pt`.
 */

const SHORT_WEEKDAY = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const LONG_WEEKDAY = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
];

interface LocalParts {
  weekday: number;
  day: number;
  month: number;
  hour: number;
  minute: number;
}

function localParts(date: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    parts.weekday ?? 'Sun',
  );

  return {
    weekday: weekdayIndex < 0 ? 0 : weekdayIndex,
    day: Number(parts.day),
    month: Number(parts.month),
    // Intl com hour12:false pode devolver "24" para a meia-noite.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function timeLabel(hour: number, minute: number): string {
  return minute === 0 ? `${hour}h00` : `${hour}h${String(minute).padStart(2, '0')}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "Ter, 10/11 às 9h00" — usado na lista de horários oferecidos. */
export function slotLabel(start: Date, timeZone: string): string {
  const p = localParts(start, timeZone);
  const weekday = SHORT_WEEKDAY[p.weekday] ?? '';
  const capitalized = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return `${capitalized}, ${pad2(p.day)}/${pad2(p.month)} às ${timeLabel(p.hour, p.minute)}`;
}

/** "terça-feira, 10/11, às 9h00" — usado na confirmação do agendamento. */
export function confirmationLabel(start: Date, timeZone: string): string {
  const p = localParts(start, timeZone);
  return `${LONG_WEEKDAY[p.weekday] ?? ''}, ${pad2(p.day)}/${pad2(p.month)}, às ${timeLabel(
    p.hour,
    p.minute,
  )}`;
}
