import { z } from 'zod';
import { brl } from './menu.ts';
import { norm } from './menu-lookup.ts';

export const DeliveryZoneSchema = z.object({
  city: z.enum(['americana', 'santa_barbara']),
  /** Como está na tabela do dono, ex.: "Brasília, Jardim". */
  name: z.string(),
  /** Centavos. */
  fee: z.number().int().nonnegative(),
  /** Outras grafias do mesmo bairro, ex.: "ferdinando mollon". */
  aliases: z.array(z.string()).optional(),
  /** Entradas do mesmo grupo são o mesmo lugar; valores diferentes = conflito. */
  group: z.string().optional(),
});
export type DeliveryZone = z.infer<typeof DeliveryZoneSchema>;

const CITY_LABEL = { americana: 'Americana', santa_barbara: "Santa Bárbara d'Oeste" } as const;

/** Tipo de logradouro e suas abreviações ("jd" vale "jardim"). */
const TYPE_ALIASES: Record<string, string> = {
  jardim: 'jardim', jd: 'jardim', jdm: 'jardim', jard: 'jardim',
  parque: 'parque', pq: 'parque', parq: 'parque', pque: 'parque',
  vila: 'vila', vl: 'vila', vla: 'vila',
  residencial: 'residencial', res: 'residencial', resid: 'residencial',
  loteamento: 'loteamento', lot: 'loteamento',
};
const TYPE_DISPLAY: Record<string, string> = {
  jardim: 'Jardim', parque: 'Parque', vila: 'Vila', residencial: 'Residencial', loteamento: 'Loteamento',
};

/** Palavras que não identificam um bairro. */
const NOISE = new Set([
  'bairro', 'taxa', 'entrega', 'entregas', 'entregam', 'entregar', 'delivery', 'frete', 'valor', 'quanto', 'custa', 'fica', 'sai',
  'qual', 'quais', 'como', 'e', 'o', 'a', 'os', 'as', 'um', 'uma', 'no', 'na', 'nos', 'nas', 'em', 'para', 'pra', 'pro', 'por',
  'favor', 'pf', 'pfv', 'vcs', 'voces', 'voce', 'fazem', 'faz', 'fazer', 'tem', 'tenho', 'queria', 'quero', 'gostaria', 'saber',
  'sera', 'possivel', 'pode', 'podem', 'hoje', 'agora', 'amanha', 'moro', 'sou', 'estou', 'mora', 'casa', 'rua', 'cidade', 'la',
  'aqui', 'ai', 'ae', 'meu', 'minha', 'ate', 'oi', 'ola', 'bom', 'dia', 'tarde', 'noite', 'obrigado', 'obrigada', 'de', 'do', 'da',
  'dos', 'das', 'ou', 'que', 'se', 'eu', 'ir', 'mandar', 'levar', 'leva', 'manda', 'motoboy', 'cobram', 'cobra', 'cobrado',
]);

const CITY_WORDS: Array<{ re: RegExp; city: DeliveryZone['city'] }> = [
  { re: /\b(santa|sta|sta\.) barbara( d ?oeste| doeste)?\b|\bsbo\b|\bs b o\b|\bsb\b/, city: 'santa_barbara' },
  { re: /\bamericana\b/, city: 'americana' },
];

interface Indexed {
  zone: DeliveryZone;
  types: Set<string>;
  /** Conjuntos de tokens alternativos que identificam o bairro. */
  nameSets: string[][];
  label: string;
}

function tokenize(s: string): string[] {
  return norm(s).split(' ').filter(Boolean);
}

function splitTypes(tokens: string[]): { types: Set<string>; rest: string[] } {
  const types = new Set<string>();
  const rest: string[] = [];
  for (const t of tokens) {
    const type = TYPE_ALIASES[t];
    if (type) types.add(type);
    else rest.push(t);
  }
  return { types, rest };
}

/** "Brasília, Jardim" vira "Jardim Brasília" para o cliente ler. */
function displayName(name: string): string {
  const m = name.match(/^(.*),\s*([^,]+)$/);
  if (m) {
    const tailTokens = tokenize(m[2] ?? '');
    if (tailTokens.length > 0 && tailTokens.every((t) => TYPE_ALIASES[t])) return `${m[2]} ${m[1]}`.trim();
  }
  return name;
}

function indexZones(zones: DeliveryZone[]): Indexed[] {
  return zones.map((zone) => {
    const { types, rest } = splitTypes(tokenize(zone.name));
    const nameSets = [rest, ...(zone.aliases ?? []).map((a) => splitTypes(tokenize(a)).rest)];
    return { zone, types, nameSets, label: displayName(zone.name) };
  });
}

export type DeliveryLookup =
  | { kind: 'found'; zones: DeliveryZone[]; fee: number; labels: string[] }
  | { kind: 'ambiguous'; options: Array<{ label: string; city: DeliveryZone['city']; fee: number }> }
  | { kind: 'conflict' }
  | { kind: 'not_found'; mentioned: boolean };

/** Resultado do pedido: `null` quando a mensagem não fala de bairro. */
export function lookupDelivery(zones: DeliveryZone[], text: string): DeliveryLookup | null {
  const q = norm(text);
  if (zones.length === 0 || q === '') return null;
  const index = indexZones(zones);

  const vocab = new Set(index.flatMap((i) => i.nameSets.flat()));

  const run = (allowCity: boolean): DeliveryLookup | null => {
    let rest = q;
    let city: DeliveryZone['city'] | undefined;
    if (allowCity) {
      for (const c of CITY_WORDS) {
        if (c.re.test(rest)) {
          city = c.city;
          rest = rest.replace(c.re, ' ');
          break;
        }
      }
    }
    const { types, rest: tokens } = splitTypes(rest.split(' ').filter(Boolean));
    const nameTokens = tokens.filter((t) => !NOISE.has(t) && vocab.has(t));
    const cue = types.size > 0 || /\b(bairro|moro|mora)\b/.test(q);

    if (nameTokens.length === 0) {
      return cue || city ? { kind: 'not_found', mentioned: cue && types.size + tokens.length > 0 } : null;
    }

    const pool = index.filter((i) => !city || i.zone.city === city);
    const candidates: Array<{ it: Indexed; extra: number }> = [];
    for (const it of pool) {
      if (types.size > 0 && it.types.size > 0 && ![...types].every((t) => it.types.has(t))) continue;
      let best = Infinity;
      for (const set of it.nameSets) {
        if (nameTokens.every((t) => set.includes(t))) best = Math.min(best, set.length - nameTokens.length);
      }
      if (best < Infinity) candidates.push({ it, extra: best });
    }
    if (candidates.length === 0) return { kind: 'not_found', mentioned: true };

    const min = Math.min(...candidates.map((c) => c.extra));
    const top = candidates.filter((c) => c.extra === min).map((c) => c.it);

    // Mesmo lugar com dois valores na tabela: não chuta.
    const groups = new Map<string, Set<number>>();
    for (const t of top) if (t.zone.group) groups.set(t.zone.group, (groups.get(t.zone.group) ?? new Set()).add(t.zone.fee));
    if ([...groups.values()].some((fees) => fees.size > 1)) return { kind: 'conflict' };

    const fees = new Set(top.map((t) => t.zone.fee));
    if (fees.size === 1) {
      return { kind: 'found', zones: top.map((t) => t.zone), fee: top[0]!.zone.fee, labels: top.map((t) => t.label) };
    }
    return {
      kind: 'ambiguous',
      options: top.map((t) => ({ label: t.label, city: t.zone.city, fee: t.zone.fee })),
    };
  };

  // Primeiro tenta reconhecer a cidade; se não achar nada, trata tudo como nome
  // do bairro (há bairros como "Terras de Santa Bárbara" e "Iate Clube de Americana").
  const first = run(true);
  if (first && first.kind !== 'not_found') return first;
  const second = run(false);
  return second && second.kind !== 'not_found' ? second : (first ?? second);
}

export function formatDelivery(result: DeliveryLookup): { text: string; handoff?: boolean } {
  switch (result.kind) {
    case 'found': {
      const cities = [...new Set(result.zones.map((z) => z.city))];
      const where = cities.length === 2 ? 'Americana e Santa Bárbara d\'Oeste' : CITY_LABEL[cities[0] as DeliveryZone['city']];
      const label = [...new Set(result.labels)][0] ?? '';
      return { text: `A taxa de entrega para ${label} (${where}) é ${brl(result.fee)}. O pagamento é feito na entrega.` };
    }
    case 'ambiguous': {
      const lines = result.options.slice(0, 6).map((o) => `• ${o.label} (${CITY_LABEL[o.city]}): ${brl(o.fee)}`);
      return { text: `Encontrei mais de um bairro com esse nome:\n${lines.join('\n')}\n\nQual é o seu? Se puder, me diga também a cidade.` };
    }
    case 'conflict':
      return {
        text: 'Vou confirmar o valor da entrega para esse bairro com a equipe e já te respondo por aqui.',
        handoff: true,
      };
    case 'not_found':
      return {
        text: 'Não encontrei esse bairro na minha lista de entrega. Pode me dizer o nome do bairro e a cidade? Se ele não estiver na lista, a equipe confirma se conseguimos atender.',
        handoff: true,
      };
  }
}
