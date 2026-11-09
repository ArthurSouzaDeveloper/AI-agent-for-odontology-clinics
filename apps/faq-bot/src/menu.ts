/**
 * Cardápio estruturado. Os preços respondidos ao cliente vêm DAQUI, por código,
 * e nunca do LLM: uma tabela errada é um erro que o dono corrige no painel; um
 * preço inventado pelo modelo é uma discussão no balcão.
 *
 * Valores em centavos para não somar ponto flutuante.
 */

import { z } from 'zod';

export const MenuItemSchema = z.object({
  name: z.string(),
  category: z.enum([
    'suco', 'acai_copo', 'bebida', 'pastel_salgado', 'pastel_sugestao', 'pastel_doce',
    'mini_pizza_salgada', 'mini_pizza_doce', 'adicional_suco', 'adicional_copo', 'adicional_pastel',
  ]),
  price: z.number().int().nonnegative().optional(),
  variants: z.record(z.number().int().nonnegative()).optional(),
  description: z.string().optional(),
});

export type Category =
  | 'suco'
  | 'acai_copo'
  | 'bebida'
  | 'pastel_salgado'
  | 'pastel_sugestao'
  | 'pastel_doce'
  | 'mini_pizza_salgada'
  | 'mini_pizza_doce'
  | 'adicional_suco'
  | 'adicional_copo'
  | 'adicional_pastel';

export interface MenuItem {
  name: string;
  category: Category;
  /** Preço único. Sucos usam `variants`. */
  price?: number;
  /** Ex.: { água: 1450, laranja: 1700 }. */
  variants?: Record<string, number>;
  description?: string;
}

export const SUCO_BASES = ['água', 'laranja', 'leite', 'frapê', 'vinho'] as const;

const c = (reais: number) => Math.round(reais * 100);

/** [nome, água, laranja, leite, frapê, vinho]; null = não existe nessa base. */
type SucoRow = [string, number | null, number | null, number | null, number | null, number | null, string?];

const SUCOS: SucoRow[] = [
  ['Detox', 14, 15, 15, 18, 20],
  ['Salada de frutas', null, 17.5, 18.5, 22, 23, 'mamão, morango, abacaxi, banana e laranja'],
  ['Salada mista', 15.5, 17.5, 18, 22, 24, 'morango, mamão, banana, beterraba e abacaxi'],
  ['Abacaxi', 12.5, 14, 14, 17.5, 19.5],
  ['Abacaxi com hortelã', 12.5, 14.5, 14.5, 17.5, 19.5],
  ['Açaí', 15.5, 17.5, 17.5, 20.5, 22.5],
  ['Acerola', 12.5, 13.5, 13.5, 17, 22.5],
  ['Amora', 16.5, 18.5, 18.5, 23, 24.5],
  ['Banana', 12.5, 13.5, 13.5, 16.5, 18.5],
  ['Cajá', 13.5, 14.5, 14.5, 17, 18],
  ['Caju', 13, 14, 14, 15.5, 18],
  ['Coco', 13.5, 14.5, 14.5, 17, 18.5],
  ['Cupuaçu', 13.5, 14.5, 14.5, 18, 19.5],
  ['Framboesa', 18.5, 20.5, 20.5, 22.5, 23.5],
  ['Goiaba', 13.5, 14.5, 14.5, 16.5, 20.5],
  ['Graviola', 13.5, 14.5, 14.5, 17.5, 19.5],
  ['Limão', 12, 13.5, 13.5, 16.5, 18],
  ['Mamão', 13.5, 15, 15, 17.5, 19.5],
  ['Manga', 13.5, 14.5, 14.5, 17, 18.5],
  ['Maracujá', 14, 15.5, 15.5, 19.5, 20.5],
  ['Melancia', 13.5, 14.5, 14.5, 17.5, 19.5],
  ['Melão', 13.5, 14.5, 14.5, 17.5, 18.5],
  ['Morango', 14.5, 17, 17, 19.5, 22.5],
  ['Pêssego', 13.5, 14.5, 14.5, 17.5, 18],
  ['Tamarindo', 13.5, 14.5, 14.5, 17.5, 18.5],
  ['Tangerina', 13.5, 14.5, 14.5, 17.5, 18.5],
  ['Uva', 13.5, 14.5, 14.5, 17.5, 18.5],
];

function sucoItem(row: SucoRow): MenuItem {
  const [name, ...prices] = row;
  const variants: Record<string, number> = {};
  SUCO_BASES.forEach((base, i) => {
    const p = prices[i];
    if (typeof p === 'number') variants[base] = c(p);
  });
  const item: MenuItem = { name: `Suco de ${name.toLowerCase()}`, category: 'suco', variants };
  const description = prices[5];
  if (typeof description === 'string') item.description = description;
  return item;
}

function list(category: Category, rows: Array<[string, number] | [string, number, string]>): MenuItem[] {
  return rows.map(([name, price, description]) => {
    const item: MenuItem = { name, category, price: c(price) };
    if (description) item.description = description;
    return item;
  });
}

export const MENU: MenuItem[] = [
  ...SUCOS.map(sucoItem),
  { name: 'Frapê doce de leite', category: 'suco', price: c(18), description: 'novidade' },
  { name: 'Frappuccino', category: 'suco', price: c(18), description: 'frapê de cappuccino, novidade' },
  { name: 'Frapê de ovomaltine', category: 'suco', price: c(18), description: 'novidade' },

  ...list('adicional_suco', [
    ['Bis (2 unidades)', 3, 'preto ou branco'],
    ['Bombom (2 unidades)', 4, 'ouro branco ou sonho de valsa'],
    ['Groselha', 2],
    ['Frutas', 1, 'incluindo cenoura e beterraba'],
    ['Paçoquita', 2],
  ]),

  ...list('bebida', [
    ['Água mineral 500ml', 3],
    ['Água com gás 500ml', 4],
    ['Água tônica', 6],
    ['Fanta laranja lata', 6],
    ['Fanta uva lata', 6],
    ['Guaraná lata', 6],
    ['Coca-Cola 290ml', 6],
    ['Coca-Cola lata', 6],
    ['Coca-Cola lata zero', 6],
    ['Coca-Cola 600ml', 9],
    ['Coca-Cola 2L', 15],
    ['Coca-Cola 2L zero', 16],
    ['Skol lata', 6],
    ['Brahma lata', 6],
    ['H2O (sabores)', 7],
    ['Heineken', 8],
  ]),

  ...list('acai_copo', [
    ['Açaí 500ml (puro)', 19],
    ['Açaí 300ml (puro)', 16],
    ['Cupuaçu 500ml (puro)', 19],
    ['Cupuaçu 300ml (puro)', 16],
    ['Casadinho (açaí e cupuaçu) 500ml', 19.5],
    ['Casadinho (açaí e cupuaçu) 300ml', 16.5],
  ]),

  ...list('adicional_copo', [
    ['Banana (adicional do copo)', 2.5],
    ['Morango (adicional do copo)', 3.5],
    ['Granola (adicional do copo)', 2.5],
    ['Leite condensado (adicional do copo)', 2.5],
    ['Leite em pó (adicional do copo)', 3],
    ['Sucrilhos (adicional do copo)', 2.5],
    ['Confete (adicional do copo)', 3.5],
    ['Nutella (adicional do copo)', 7],
    ['Ovomaltine (adicional do copo)', 6],
    ['Sorvete napolitano ou creme (adicional do copo)', 4],
    ['Paçoca (adicional do copo)', 2.5],
    ['Bombom (adicional do copo)', 4],
    ['Bis (adicional do copo)', 3.5],
    ['Cobertura (adicional do copo)', 1.5],
    ['Mel (adicional do copo)', 3.5],
  ]),

  ...list('pastel_salgado', [
    ['Pastel de salmão', 29],
    ['Pastel de linguiça', 13.5],
    ['Pastel de atum', 16],
    ['Pastel de pepperoni', 15],
    ['Pastel de brócolis', 13.5],
    ['Pastel de costela', 16.5],
    ['Pastel de calabresa', 14.5],
    ['Pastel de carne', 14.5],
    ['Pastel de carne seca', 16.5],
    ['Pastel de camarão', 19],
    ['Pastel de frango', 14.5],
    ['Pastel de lombo', 14.5],
    ['Pastel de picanha', 18.5],
    ['Pastel de palmito', 14.5],
    ['Pastel de peito de peru', 14.5],
    ['Pastel de pernil', 14.5],
    ['Pastel de pizza', 14.5],
    ['Pastel de presunto', 13.5],
    ['Pastel de mussarela', 14.5],
    ['Pastel de salame', 14.5],
    ['Pastel de salsicha', 13.5],
    ['Pastel de escarola', 13],
  ]),

  ...list('pastel_sugestao', [
    ['Pastemaki', 39, '140g de salmão, cream cheese, cebolinha, molho tarê e gergelim'],
    ['Marguerita', 16.5, 'mussarela, tomate, orégano e manjericão'],
    ['Caipira', 19, 'frango, creme de milho, queijo, catupiry, milho, ervilha e ovo'],
    ['Churrasco do Rei', 25, 'picanha, mussarela, molho de alho e vinagrete'],
    ['Parmegiana do Rei', 23, 'frango empanado, presunto, queijo, molho de tomate e catupiry'],
    ['Medalhão de frango', 19, 'medalhão de frango enrolado no bacon com queijo duplo'],
    ['Churrasco do Rei 2', 18, 'linguiça nobre, rúcula, molho de alho, queijo e vinagrete'],
    ['Escarola da casa', 16, 'escarola, mussarela, alho frito e bacon'],
    ['Atum do Rei', 18, 'atum em pedaços, mussarela e cebola'],
    ['Nobre', 17, 'linguiça nobre, mussarela e molho de alho'],
    ['Clássico', 18, 'peito de peru, mussarela e cream cheese'],
    ['Catupeperoni', 17.5, 'pepperoni, mussarela e catupiry'],
    ['À moda da casa', 20, 'carne, mussarela, milho, ervilha, tomate e ovo'],
    ['Costela do Rei', 22, 'carne de costela, queijo branco e cebola defumada'],
    ['Cocoricó', 18, 'frango, ervilha, milho, ovo e catupiry'],
    ['Especial vegetariano', 20, 'mussarela, brócolis, tomate, milho, ervilha, azeitona e cebola'],
    ['Estrogonofe de frango', 18, 'frango em cubos, mussarela, batata palha e champignon'],
    ['Especial do chefe', 21, 'peito de peru, mussarela, catupiry, cebola, orégano, alho frito, mostarda e azeitona preta'],
    ['Especial da casa', 25, 'carne, cheddar, tomate, presunto, mussarela, ovo, bacon e parmesão (servido no prato com talheres)'],
    ['Escondidinho', 21, 'carne seca, purê de batata, mussarela e molho de tomate'],
    ['Frango especial', 17.5, 'frango desfiado, cebola, molho barbecue, parmesão e mussarela'],
    ['Hot dog', 17.5, 'salsicha, mussarela, milho, ervilha e batata palha'],
    ['Nacho com queijo', 17, 'doritos, mussarela e catupiry'],
    ['Pastel X Burguer', 27, 'hambúrguer, ovo frito, presunto, mussarela, bacon, tomate e catupiry'],
    ['2 queijos', 18, 'mussarela, catupiry e azeitona'],
    ['3 queijos', 19.5, 'mussarela, parmesão e catupiry'],
    ['4 queijos', 23, 'mussarela, parmesão, provolone e catupiry'],
    ['5 queijos', 26, 'mussarela, parmesão, provolone, gorgonzola e catupiry'],
    ['X-Tudo', 25, 'frango, carne, pizza, calabresa, palmito e catupiry'],
    ['Xadrez', 17, 'frango, cebola, tomate, pimentão, mussarela e shoyu'],
  ]),

  ...list('pastel_doce', [
    ['Pastel doce de pistache', 20],
    ['Pastel doce de maçã com banana, leite condensado e canela', 15.5],
    ['Pastel doce de doce de leite com nozes', 18],
    ['Pastel doce especial de banana com açaí', 20, 'banana, granola, leite em pó, leite condensado e 3 bolas de açaí em cima do pastel'],
    ['Pastel doce meio amargo', 17],
    ['Pastel doce cappuccino', 16, 'chocolate ao leite com cappuccino'],
    ['Pastel doce Galak com morango', 19],
    ['Pastel doce de ovomaltine com ninho', 17.5],
    ['Pastel doce Trento maracujá', 15.5, 'com chocolate branco'],
    ['Pastel doce Trento torta de limão', 15.5, 'com chocolate branco'],
    ['Pastel doce de banana, canela e leite condensado', 15],
    ['Pastel doce de banana, queijo e canela', 15],
    ['Pastel doce de banana, queijo e goiabada', 16],
    ['Pastel doce Mineirinho', 18, 'queijo branco fresco selado ao fogo com goiabada'],
    ['Pastel doce de bis branco ou preto', 16],
    ['Pastel doce de bombom ouro branco ou sonho de valsa', 16],
    ['Pastel doce de brigadeiro', 15],
    ['Pastel doce Caribe', 15.5, 'chocolate preto, banana e canela'],
    ['Pastel doce Charge', 16, 'chocolate preto, doce de leite e amendoim'],
    ['Pastel doce Choco Ninho', 16, 'chocolate preto com leite em pó'],
    ['Pastel doce Chocoim', 16, 'paçoca, chocolate preto e branco'],
    ['Pastel doce de chocolate branco, leite em pó e morango', 19],
    ['Pastel doce de chocolate preto com paçoca', 15.5],
    ['Pastel doce de chocolate preto com confetes de chocolate', 15.5],
    ['Pastel doce Chocomisto', 15.5, 'chocolate branco, chocolate preto'],
    ['Pastel doce Choquito', 15.5, 'chocolate preto, flocos crocantes'],
    ['Pastel doce de doce de leite com coco', 15.5],
    ['Pastel doce de doce de leite com queijo', 16],
    ['Pastel doce de Ferrero Rocher', 25],
    ['Pastel doce Floresta Negra', 18, 'chocolate preto com cereja'],
    ['Pastel doce de Kit Kat', 16],
    ['Pastel doce de merengue', 15, 'morango, leite condensado e suspiro'],
    ['Pastel doce de Negresco', 16],
    ['Pastel doce de Nutella', 19],
    ['Pastel doce de Nutella com ninho', 19],
    ['Pastel doce de Prestígio', 16.5],
    ['Pastel doce Romeu e Julieta', 16, 'mussarela e goiabada'],
    ['Pastel doce Sensação', 17.5],
    ['Pastel doce de Suflair com doce de leite', 17.5],
    ['Pastel doce de Suflair', 17],
    ['Pastel doce de Talento', 19, 'avelã ou castanha do Pará'],
    ['Sorvete adicional no pastel doce', 9, '2 bolas de sorvete de creme ou napolitano, com calda de chocolate ou morango, servido no prato'],
  ]),

  ...list('mini_pizza_salgada', [
    ['Mini pizza de peito de peru, alho poró, mussarela e cream cheese', 16.5],
    ['Mini pizza de pepperoni, mussarela e catupiry', 16],
    ['Mini pizza de atum em pedaços, cebola, orégano e mussarela', 16],
    ['Mini pizza de calabresa, cebola, mussarela e tomate', 16],
    ['Mini pizza de frango, catupiry e mussarela', 16],
    ['Mini pizza de frango, mussarela, milho e ervilha', 16],
    ['Mini pizza de palmito com mussarela', 16],
    ['Mini pizza de peito de peru, catupiry, tomate e mussarela', 16],
    ['Mini pizza de presunto, mussarela, tomate, ovo e orégano', 16],
    ['Mini pizza de quatro queijos', 16],
    ['Mini pizza de mussarela, bacon e tomate', 16],
    ['Mini pizza de salame com mussarela', 16],
  ]),

  ...list('mini_pizza_doce', [
    ['Mini pizza doce de chocolate preto com paçoca', 14.5],
    ['Mini pizza doce de chocolate branco com Negresco', 14.5],
    ['Mini pizza doce de Ferrero Rocher com Nutella', 23],
    ['Mini pizza doce de brigadeiro', 14.5],
    ['Mini pizza doce de chocolate preto com confete', 14.5],
    ['Mini pizza doce de Prestígio', 14.5],
    ['Mini pizza doce Sensação', 15.5],
    ['Mini pizza doce Banoffe', 16, 'banana, doce de leite, canela e chantilly'],
    ['Dica do chefe: bola de sorvete na mini pizza doce (Grand Gateau)', 6],
  ]),

  ...list('adicional_pastel', [
    ['Guacamole apimentada 200ml (ingrediente extra)', 8],
    ['Purê de batata (ingrediente extra)', 3],
    ['Molho de alho (ingrediente extra)', 2],
    ['Cream cheese (ingrediente extra)', 4.5],
    ['Cebola caramelizada (ingrediente extra)', 2.5],
    ['Cebola defumada (ingrediente extra)', 2.5],
    ['Alho poró (ingrediente extra)', 2],
    ['Pepperoni (ingrediente extra)', 4],
    ['Alho frito (ingrediente extra)', 1],
    ['Azeitona preta (ingrediente extra)', 3],
    ['Azeitona verde (ingrediente extra)', 2.5],
    ['Bacon (ingrediente extra)', 3],
    ['Batata palha (ingrediente extra)', 1],
    ['Catupiry (ingrediente extra)', 3.5],
    ['Cebola (ingrediente extra)', 1],
    ['Champignon (ingrediente extra)', 3.5],
    ['Cheddar (ingrediente extra)', 3.5],
    ['Ervilha (ingrediente extra)', 1],
    ['Gorgonzola (ingrediente extra)', 3.5],
    ['Milho (ingrediente extra)', 1],
    ['Mussarela (ingrediente extra)', 3.5],
    ['Orégano (ingrediente extra)', 0.8],
    ['Ovo cozido (ingrediente extra)', 2.5],
    ['Parmesão (ingrediente extra)', 3.5],
    ['Pimentão (ingrediente extra)', 2],
    ['Provolone (ingrediente extra)', 3.5],
    ['Pimenta biquinho (ingrediente extra)', 2],
    ['Tomate (ingrediente extra)', 1],
    ['Tomate seco (ingrediente extra)', 3],
    ['Queijo branco (ingrediente extra)', 4.5],
    ['Vinagrete 200ml (ingrediente extra)', 4],
  ]),
];

export const brl = (cents: number): string =>
  `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
