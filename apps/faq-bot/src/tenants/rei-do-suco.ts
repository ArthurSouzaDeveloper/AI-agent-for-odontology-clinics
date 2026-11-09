import { BusinessConfig } from '../responder.ts';
import { MENU } from '../menu.ts';

/**
 * Configuração do Rei do Suco (Americana-SP). Fonte: horário informado pelo
 * dono e cardápio R/2026 enviado em imagem. Endereço, entrega e formas de
 * pagamento NÃO constam nos materiais: ficam vazios de propósito e o bot
 * encaminha para um humano em vez de inventar. Preencher no painel do dono.
 */
export const reiDoSuco = BusinessConfig.parse({
  name: 'Rei do Suco',
  hours: {
    timezone: 'America/Sao_Paulo',
    // Quarta a domingo (ISO: 3 a 7), das 18h às 23h30.
    weekly: [3, 4, 5, 6, 7].map((weekday) => ({ weekday, ranges: [{ open: '18:00', close: '23:30' }] })),
    holidays: [],
  },
  phones: ['(19) 3405-4361', '(19) 99746-1854'],
  instagram: '@oreidosucoamericana',
  menu: MENU,
  faq: [],
});
