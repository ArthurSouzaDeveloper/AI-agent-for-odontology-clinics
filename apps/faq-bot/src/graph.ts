import type { HandoffNotifier, Sender } from './server.ts';
import { buildTextPayload } from './whatsapp.ts';

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Envia mensagens pela Graph API da Meta (WhatsApp Cloud API). */
export class GraphSender implements Sender {
  constructor(
    private readonly accessToken: string,
    private readonly apiVersion = 'v21.0',
    private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async send(phoneNumberId: string, body: unknown): Promise<void> {
    // phoneNumberId vem do webhook assinado, mas valida o formato mesmo assim:
    // ele entra no caminho da URL.
    if (!/^\d{5,20}$/.test(phoneNumberId)) throw new Error('phone_number_id inválido');

    const res = await this.fetchFn(`https://graph.facebook.com/${this.apiVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // O corpo de erro da Meta não leva dado do cliente, mas não o repassamos ao log inteiro.
      throw new Error(`Graph API respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }
}

/**
 * Avisa o dono por WhatsApp quando um cliente pede atendente ou o bot não sabe.
 * Atenção: mensagem de texto livre só chega se o dono falou com o número nas
 * últimas 24h; fora disso a Meta exige um template aprovado (próximo passo).
 * Por isso a falha aqui é registrada e não derruba o atendimento do cliente.
 */
export class WhatsAppOwnerNotifier implements HandoffNotifier {
  constructor(
    private readonly sender: Sender,
    private readonly phoneNumberId: string,
    private readonly ownerNumber: string,
    private readonly log: (msg: string) => void = console.error,
  ) {}

  async notify(info: { from: string; reason: string; lastMessage?: string }): Promise<void> {
    const motivo =
      info.reason === 'customer_request' ? 'pediu para falar com atendente' : 'fez uma pergunta que o bot não soube responder';
    const trecho = info.lastMessage ? `\n\nMensagem: "${info.lastMessage.slice(0, 300)}"` : '';
    const text = `🔔 Um cliente (${maskPhone(info.from)}) ${motivo}.${trecho}\n\nResponda pelo WhatsApp: wa.me/${info.from}`;
    try {
      await this.sender.send(this.phoneNumberId, buildTextPayload(this.ownerNumber, text));
    } catch (err) {
      this.log(`falha ao avisar o dono: ${(err as Error).message}`);
    }
  }
}

export function maskPhone(phone: string): string {
  return phone.length <= 4 ? '****' : `${phone.slice(0, 4)}…${phone.slice(-2)}`;
}
