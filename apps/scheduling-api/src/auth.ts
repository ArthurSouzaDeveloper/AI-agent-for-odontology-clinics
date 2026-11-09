import type { FastifyRequest } from 'fastify';
import { ApiError } from './errors.ts';

export const SCOPES = [
  'availability:read',
  'holds:write',
  'appointments:create',
  'appointments:read:own_conversation',
  'appointments:read',
  'appointments:update',
  'subjects:lookup',
  'subjects:create',
  'subjects:read',
  'schedule:manage',
] as const;
export type Scope = (typeof SCOPES)[number];

export interface Principal {
  kind: 'service' | 'user';
  id: string;
  tenantId: string;
  scopes: Set<Scope>;
  /** Presente quando o chamador é o agente de conversa. */
  conversationId?: string;
}

/**
 * Slice 1: token de desenvolvimento no formato
 *   Bearer dev.<kind>.<actorId>.<tenantId>.<escopo,escopo>
 *
 * A verificação real (OAuth2 client credentials + JWKS para o bot, OIDC para o
 * painel) entra antes de qualquer ambiente com dado real. O importante aqui é
 * que o resto do código já dependa de `Principal` e dos escopos, e não do
 * formato do token — trocar a verificação não mexe nas rotas.
 */
export function authenticate(req: FastifyRequest, nodeEnv: string): Principal {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new ApiError('UNAUTHORIZED', 'Token ausente.');
  }
  const token = header.slice('Bearer '.length).trim();

  if (!token.startsWith('dev.')) {
    throw new ApiError('UNAUTHORIZED', 'Verificação de token OAuth2/OIDC ainda não configurada.');
  }
  if (nodeEnv === 'production') {
    throw new ApiError('UNAUTHORIZED', 'Token de desenvolvimento recusado em produção.');
  }

  const [, kind, actorId, tenantId, scopeList] = token.split('.');
  if (
    (kind !== 'service' && kind !== 'user') ||
    !actorId ||
    !tenantId ||
    scopeList === undefined
  ) {
    throw new ApiError('UNAUTHORIZED', 'Token de desenvolvimento malformado.');
  }

  const scopes = new Set<Scope>();
  for (const raw of scopeList.split(',')) {
    const s = raw.trim();
    if (s === '') continue;
    if (!(SCOPES as readonly string[]).includes(s)) {
      throw new ApiError('UNAUTHORIZED', `Escopo desconhecido: ${s}`);
    }
    scopes.add(s as Scope);
  }

  const principal: Principal = { kind, id: actorId, tenantId, scopes };

  const conversationId = req.headers['x-conversation-id'];
  if (typeof conversationId === 'string' && conversationId.trim() !== '') {
    principal.conversationId = conversationId.trim();
  }
  return principal;
}

export function requireScope(principal: Principal, scope: Scope): void {
  if (!principal.scopes.has(scope)) {
    throw new ApiError('FORBIDDEN', `Escopo necessário: ${scope}.`);
  }
}

/**
 * O agente nunca informa de quem é o agendamento: a identidade vem da conversa
 * autenticada. É isto que faz com que uma injeção de prompt não alcance os
 * dados de outro paciente.
 */
export function requireConversation(principal: Principal): string {
  if (!principal.conversationId) {
    throw new ApiError('FORBIDDEN', 'Header X-Conversation-Id obrigatório para esta operação.');
  }
  return principal.conversationId;
}
