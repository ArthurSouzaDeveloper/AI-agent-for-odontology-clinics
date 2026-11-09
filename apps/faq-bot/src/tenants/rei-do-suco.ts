import { BusinessConfig } from '../responder.ts';
import { MENU } from '../menu.ts';

/**
 * Configuração do Rei do Suco (Americana-SP). Fonte: horário, endereço,
 * entrega e pagamento informados pelo dono; cardápio R/2026 em imagem.
 * Ainda sem dado: taxa de entrega, região atendida e feriados. O bot não
 * inventa: encaminha esses casos para um humano.
 */
export const reiDoSuco = BusinessConfig.parse({
  name: 'Rei do Suco',
  hours: {
    timezone: 'America/Sao_Paulo',
    // Quarta a domingo (ISO: 3 a 7), das 18h às 23h30.
    weekly: [3, 4, 5, 6, 7].map((weekday) => ({ weekday, ranges: [{ open: '18:00', close: '23:30' }] })),
    holidays: [],
  },
  address: 'Praça Luís de Boni, 57 - Jardim Ipiranga, Americana - SP, 13468-579',
  // Entrega feita por motoboy próprio. A taxa e a área não foram informadas:
  // o bot não cita valor, só confirma que entrega e encaminha o resto.
  delivery: { enabled: true, notes: 'A entrega é feita por motoboy próprio. Para taxa e região atendida, a equipe confirma com você.' },
  // Pagamento somente na entrega.
  payment_note: 'O pagamento é feito somente na entrega.',
  payment_methods: ['cartão de débito', 'cartão de crédito', 'dinheiro', 'Pix'],
  phones: ['(19) 3405-4361', '(19) 99746-1854'],
  instagram: '@oreidosucoamericana',
  menu: MENU,
  faq: [],
});
