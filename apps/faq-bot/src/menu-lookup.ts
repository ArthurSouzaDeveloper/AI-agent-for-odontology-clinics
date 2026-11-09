import { SUCO_BASES, brl, type Category, type MenuItem } from './menu.ts';

export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Palavras que não identificam um item. */
const STOP = new Set([
  'de', 'da', 'do', 'das', 'dos', 'com', 'e', 'ou', 'a', 'o', 'as', 'os', 'um', 'uma', 'no', 'na', 'em', 'para', 'por',
  'lata', 'extra', 'ingrediente', 'adicional', 'copo', 'unidades', 'sabores', 'ml', 'l', 'puro', 'novidade',
  // categorias (viram dica de filtro, não parte do nome)
  'suco', 'sucos', 'pastel', 'pasteis', 'doce', 'doces', 'salgado', 'salgados', 'mini', 'pizza', 'pizzas',
]);

const BASE_WORDS: Record<string, (typeof SUCO_BASES)[number]> = {
  agua: 'água',
  laranja: 'laranja',
  leite: 'leite',
  frape: 'frapê',
  vinho: 'vinho',
};

interface Indexed {
  item: MenuItem;
  tokens: Set<string>;
}

function indexMenu(menu: MenuItem[]): Indexed[] {
  return menu.map((item) => ({
    item,
    // Tira o texto entre parênteses do nome (é explicação, não identificação),
    // exceto em itens que dependem dele para diferenciar (Casadinho, Açaí 500ml).
    tokens: new Set(norm(item.name.replace(/\([^)]*\)/g, (m) => (/(açaí|puro|2 unidades)/i.test(m) ? m : ''))).split(' ').filter((t) => t && !STOP.has(t))),
  }));
}

function categoriesFromHints(q: string): Set<Category> | null {
  const has = (re: RegExp) => re.test(q);
  const doce = has(/\bdoces?\b/);
  const salgado = has(/\bsalgados?\b/);

  if (has(/\b(copo|copos)\b/)) return new Set<Category>(['acai_copo', 'adicional_copo']);
  if (has(/\b(adicional|adicionais|extra|ingrediente|ingredientes)\b/))
    return new Set<Category>(['adicional_suco', 'adicional_copo', 'adicional_pastel']);
  if (has(/\b(bebida|bebidas|refri|refrigerante|cerveja|lata|agua mineral)\b/)) return new Set<Category>(['bebida']);
  if (has(/\bpast(el|eis)\b/)) {
    if (doce) return new Set<Category>(['pastel_doce']);
    if (salgado) return new Set<Category>(['pastel_salgado', 'pastel_sugestao']);
    return new Set<Category>(['pastel_salgado', 'pastel_sugestao', 'pastel_doce']);
  }
  if (has(/\bpizzas?\b/)) {
    if (doce) return new Set<Category>(['mini_pizza_doce']);
    if (salgado) return new Set<Category>(['mini_pizza_salgada']);
    return new Set<Category>(['mini_pizza_salgada', 'mini_pizza_doce']);
  }
  if (has(/\bsucos?\b/)) return new Set<Category>(['suco']);
  return null;
}

export interface LookupResult {
  items: MenuItem[];
  base?: (typeof SUCO_BASES)[number];
}

/**
 * Procura itens do cardápio citados na mensagem. Só reconhece palavras que
 * existem no cardápio: o que o cliente escrever fora disso é ignorado, e uma
 * pergunta sem nenhum item reconhecível devolve `null` (vai para a FAQ/humano
 * em vez de chutar um preço).
 */
export function lookupMenu(menu: MenuItem[], text: string): LookupResult | null {
  const q = norm(text);
  const index = indexMenu(menu);
  const vocabulary = new Set(index.flatMap((i) => [...i.tokens]));

  const hint = categoriesFromHints(q);
  const pool = hint ? index.filter((i) => hint.has(i.item.category)) : index;

  const qTokens = q.split(' ').filter((t) => t && !STOP.has(t) && vocabulary.has(t));
  if (qTokens.length === 0) return null;

  const attempt = (tokens: string[]): MenuItem[] => {
    if (tokens.length === 0) return [];
    const candidates = pool
      .filter((i) => tokens.every((t) => i.tokens.has(t)))
      .map((i) => ({ item: i.item, extra: i.tokens.size - tokens.length }));
    if (candidates.length === 0) return [];
    const min = Math.min(...candidates.map((c) => c.extra));
    return candidates.filter((c) => c.extra === min).map((c) => c.item);
  };

  let items = attempt(qTokens);
  if (items.length > 0) return { items };

  // "suco de morango na laranja": tira a base e procura só a fruta.
  const baseToken = qTokens.find((t) => t in BASE_WORDS);
  if (baseToken) {
    const base = BASE_WORDS[baseToken];
    items = attempt(qTokens.filter((t) => t !== baseToken)).filter((i) => i.variants && base && base in i.variants);
    if (items.length > 0) return base ? { items, base } : { items };
  }
  return null;
}

const MAX_LIST = 5;

/** Texto pronto para o cliente: tudo vem da tabela, nada do modelo. */
export function formatLookup(result: LookupResult): string {
  const line = (it: MenuItem): string => {
    if (it.variants) {
      if (result.base && it.variants[result.base] !== undefined) {
        return `${it.name} (500ml) ${baseLabel(result.base)}: ${brl(it.variants[result.base] as number)}`;
      }
      const parts = SUCO_BASES.filter((b) => it.variants?.[b] !== undefined).map(
        (b) => `${baseLabel(b)} ${brl(it.variants?.[b] as number)}`,
      );
      return `${it.name} (500ml): ${parts.join(' · ')}`;
    }
    const desc = it.description ? ` (${it.description})` : '';
    return `${it.name}${desc}: ${brl(it.price ?? 0)}`;
  };

  const { items } = result;
  if (items.length === 1) return `${line(items[0] as MenuItem)}.`;
  const shown = items.slice(0, MAX_LIST).map((i) => `• ${line(i)}`);
  const more = items.length > MAX_LIST ? `\n…e mais ${items.length - MAX_LIST} opções. Me diga qual você quer e eu confirmo o valor.` : '';
  return `Encontrei estas opções:\n${shown.join('\n')}${more}`;
}

function baseLabel(base: (typeof SUCO_BASES)[number]): string {
  return { água: 'na água', laranja: 'na laranja', leite: 'no leite', frapê: 'frapê', vinho: 'no vinho' }[base];
}
