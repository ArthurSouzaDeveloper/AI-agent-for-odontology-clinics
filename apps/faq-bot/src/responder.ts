import { z } from 'zod';
import { BusinessHoursConfig, openStatus, openStatusMessage, weeklySummary } from './hours.ts';

/** Tudo o que o dono edita no painel. Nada disto fica em constante de código. */
export const BusinessConfig = z.object({
  name: z.string(),
  hours: BusinessHoursConfig,
  address: z.string().optional(),
  delivery: z.object({ enabled: z.boolean(), fee: z.string().optional(), notes: z.string().optional() }).default({ enabled: false }),
  payment_methods: z.array(z.string()).default([]),
  menu_url: z.string().url().optional(),
  /** Perguntas e respostas escritas pelo dono. É a ÚNICA fonte para o LLM. */
  faq: z.array(z.object({ question: z.string(), answer: z.string(), keywords: z.array(z.string()).default([]) })).default([]),
});
export type BusinessConfig = z.infer<typeof BusinessConfig>;

export type Intent = 'greeting' | 'hours' | 'open_now' | 'address' | 'menu' | 'delivery' | 'payment' | 'human' | 'unknown';

export type Reply =
  | { type: 'text'; text: string; source: 'rule' | 'faq' | 'llm' }
  | { type: 'buttons'; text: string; buttons: Array<{ id: string; title: string }>; source: 'rule' }
  | { type: 'handoff'; text: string; reason: 'customer_request' | 'not_in_faq' | 'llm_unavailable' };

/** Responde só com base nas FAQs recebidas; devolve null quando não souber. */
export interface FaqAnswerer {
  answer(question: string, faq: BusinessConfig['faq']): Promise<string | null>;
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const RULES: Array<{ intent: Intent; any: RegExp }> = [
  { intent: 'human', any: /\b(atendente|humano|pessoa|dono|gerente|reclamacao|reclamar|falar com alguem)\b/ },
  { intent: 'open_now', any: /\b(aberto|aberta|abertos|abertas|funcionando|fechado|fechada|fechados)\b/ },
  { intent: 'hours', any: /\b(horario|horarios|que horas|ate que horas|funcionamento|funciona|abre|fecha|abrem|fecham|domingo|feriado)\b/ },
  { intent: 'delivery', any: /\b(entrega|entregam|entregar|delivery|frete|taxa)\b/ },
  { intent: 'payment', any: /\b(pix|cartao|dinheiro|pagamento|pagar|credito|debito|aceitam|vale)\b/ },
  { intent: 'address', any: /\b(endereco|onde fica|localizacao|como chegar|local|rua)\b/ },
  { intent: 'menu', any: /\b(cardapio|menu|sabores|sabor|preco|precos|valor|quanto custa|quanto e)\b/ },
  { intent: 'greeting', any: /^(oi+|ola|bom dia|boa tarde|boa noite|e ai|eae|opa|hello)\b/ },
];

/** Classificação determinística. Palavras de "humano" têm prioridade sobre todo o resto. */
export function detectIntent(text: string): Intent {
  const t = normalize(text);
  for (const r of RULES) if (r.any.test(t)) return r.intent;
  return 'unknown';
}

export const MENU_BUTTONS = [
  { id: 'hours', title: 'Horário' },
  { id: 'menu', title: 'Cardápio' },
  { id: 'human', title: 'Falar com atendente' },
];

export class Responder {
  constructor(
    private readonly cfg: BusinessConfig,
    private readonly llm?: FaqAnswerer,
  ) {}

  async reply(input: { text?: string; choiceId?: string }, now: Date = new Date()): Promise<Reply> {
    const intent: Intent =
      input.choiceId && ['hours', 'menu', 'human'].includes(input.choiceId)
        ? (input.choiceId as Intent)
        : detectIntent(input.text ?? '');

    // A FAQ escrita pelo dono vence as regras genéricas (num bar de sucos,
    // "suco" aparece em toda frase), exceto pedido de humano e botões.
    if (intent !== 'human' && !input.choiceId) {
      const faqHit = this.matchFaq(input.text ?? '');
      if (faqHit) return { type: 'text', source: 'faq', text: faqHit };
    }

    switch (intent) {
      case 'human':
        return { type: 'handoff', reason: 'customer_request', text: this.handoffText(now) };

      case 'greeting':
        return {
          type: 'buttons',
          source: 'rule',
          text: `Olá! Eu sou o assistente virtual do ${this.cfg.name}. ${openStatusMessage(openStatus(this.cfg.hours, now))}\n\nComo posso ajudar?`,
          buttons: MENU_BUTTONS,
        };

      case 'open_now':
        return { type: 'text', source: 'rule', text: openStatusMessage(openStatus(this.cfg.hours, now)) };

      case 'hours':
        return {
          type: 'text',
          source: 'rule',
          text: `Nosso horário de funcionamento:\n${weeklySummary(this.cfg.hours).split(' | ').join('\n')}\n\n${openStatusMessage(openStatus(this.cfg.hours, now))}`,
        };

      case 'address':
        return this.cfg.address
          ? { type: 'text', source: 'rule', text: `Estamos em: ${this.cfg.address}` }
          : this.fallback(input.text ?? '', now);

      case 'menu':
        return this.cfg.menu_url
          ? { type: 'text', source: 'rule', text: `Veja nosso cardápio completo e os preços aqui: ${this.cfg.menu_url}` }
          : this.fallback(input.text ?? '', now);

      case 'delivery':
        return this.cfg.delivery.enabled
          ? {
              type: 'text',
              source: 'rule',
              text: ['Sim, fazemos entrega!', this.cfg.delivery.fee && `Taxa: ${this.cfg.delivery.fee}.`, this.cfg.delivery.notes]
                .filter(Boolean)
                .join(' '),
            }
          : { type: 'text', source: 'rule', text: 'No momento não fazemos entrega. Você pode retirar na loja.' };

      case 'payment':
        return this.cfg.payment_methods.length > 0
          ? { type: 'text', source: 'rule', text: `Aceitamos: ${this.cfg.payment_methods.join(', ')}.` }
          : this.fallback(input.text ?? '', now);

      default:
        return this.fallback(input.text ?? '', now);
    }
  }

  /** FAQ do dono por palavra-chave; depois o LLM restrito; por fim, um humano. */
  private async fallback(text: string, now: Date): Promise<Reply> {
    const hit = this.matchFaq(text);
    if (hit) return { type: 'text', source: 'faq', text: hit };

    if (this.llm && this.cfg.faq.length > 0) {
      try {
        const answer = await this.llm.answer(text, this.cfg.faq);
        if (answer && this.isGrounded(answer)) return { type: 'text', source: 'llm', text: answer };
      } catch {
        return { type: 'handoff', reason: 'llm_unavailable', text: this.handoffText(now) };
      }
    }
    return { type: 'handoff', reason: 'not_in_faq', text: this.handoffText(now) };
  }

  private matchFaq(text: string): string | null {
    const t = normalize(text);
    if (t === '') return null;
    const hit = this.cfg.faq.find((f) => f.keywords.some((k) => normalize(k) !== '' && t.includes(normalize(k))));
    return hit ? hit.answer : null;
  }

  /**
   * Barreira de saída: o LLM só pode repetir fatos da base. Bloqueia respostas
   * com preço, telefone ou horário que não estejam em nenhuma FAQ do dono.
   */
  private isGrounded(answer: string): boolean {
    const corpus = normalize(
      [this.cfg.faq.map((f) => `${f.question} ${f.answer}`).join(' '), this.cfg.address, this.cfg.delivery.fee, weeklySummary(this.cfg.hours)]
        .filter(Boolean)
        .join(' '),
    );
    const factual = normalize(answer).match(/\b\d+(?:\s?[a-z]*\d*)?\b/g) ?? [];
    return factual.every((f) => corpus.includes(f.trim()));
  }

  private handoffText(now: Date): string {
    const s = openStatus(this.cfg.hours, now);
    return s.isOpen
      ? 'Certo! Já chamei alguém da equipe para te atender por aqui. Só um instante.'
      : `Anotei sua mensagem e já avisei a equipe. ${openStatusMessage(s)} Assim que abrirmos, respondemos você por aqui.`;
  }
}
