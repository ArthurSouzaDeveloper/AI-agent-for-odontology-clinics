import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import { requireConversation, requireScope } from '../auth.ts';
import { ApiError } from '../errors.ts';
import { withTx } from '../db/pool.ts';

const PhoneE164 = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Telefone deve estar em formato E.164');

export function registerSubjectRoutes(app: FastifyInstance): void {
  /**
   * Busca por telefone é POST, não GET: telefone em query string vai para o
   * log do proxy, do CDN e do servidor. A comparação usa HMAC, não o número.
   * Devolve o mínimo que o agente precisa para cumprimentar a pessoa.
   */
  app.post('/subjects/lookup', async (req) => {
    requireScope(req.principal, 'subjects:lookup');
    const body = z.object({ phone_e164: PhoneE164 }).parse(req.body);
    const hash = req.ctx.crypto.phoneHash(body.phone_e164);

    const { rows } = await req.ctx.db.query<{
      id: string;
      full_name_enc: Buffer;
      is_minor: boolean;
    }>(
      `SELECT id, full_name_enc, is_minor FROM subjects
        WHERE tenant_id = $1 AND phone_hash = $2`,
      [req.principal.tenantId, hash],
    );

    const row = rows[0];
    if (!row) return { found: false };

    const fullName = req.ctx.crypto.decrypt(row.full_name_enc);
    return {
      found: true,
      subject_id: row.id,
      first_name: fullName.split(/\s+/)[0] ?? '',
      is_minor: row.is_minor,
    };
  });

  app.post('/subjects', async (req, reply) => {
    requireScope(req.principal, 'subjects:create');
    const body = z
      .object({
        full_name: z.string().min(2).max(200),
        birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        phone_e164: PhoneE164.optional(),
        guardian_name: z.string().min(2).max(200).optional(),
        /** Vincula a conversa autenticada ao cadastro criado. */
        link_conversation: z.boolean().default(false),
      })
      .parse(req.body);

    const isMinor = ageInYears(body.birth_date) < 18;
    if (isMinor && !body.guardian_name) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'Para menor de 18 anos, o nome do responsável é obrigatório.',
      );
    }

    const id = `sub_${ulid()}`;
    const { crypto: fieldCrypto } = req.ctx;

    const result = await withTx(req.ctx.db, async (tx) => {
      await tx.query(
        `INSERT INTO subjects
           (id, tenant_id, phone_hash, phone_enc, full_name_enc, birth_date_enc,
            is_minor, guardian_name_enc, created_via)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          req.principal.tenantId,
          body.phone_e164 ? fieldCrypto.phoneHash(body.phone_e164) : null,
          body.phone_e164 ? fieldCrypto.encrypt(body.phone_e164) : null,
          fieldCrypto.encrypt(body.full_name),
          fieldCrypto.encrypt(body.birth_date),
          isMinor,
          body.guardian_name ? fieldCrypto.encrypt(body.guardian_name) : null,
          req.principal.kind === 'service' ? 'whatsapp_agent' : 'dashboard',
        ],
      );

      if (body.link_conversation) {
        const conversationId = requireConversation(req.principal);
        const { rowCount } = await tx.query(
          `UPDATE conversations SET subject_id = $1, updated_at = now()
            WHERE id = $2 AND tenant_id = $3 AND subject_id IS NULL`,
          [id, conversationId, req.principal.tenantId],
        );
        if (rowCount === 0) {
          throw new ApiError(
            'CONVERSATION_SUBJECT_MISMATCH',
            'Conversa inexistente ou já vinculada a outro cadastro.',
          );
        }
      }

      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, entity, entity_id, request_id)
              VALUES ($1, $2, $3, 'subject.create', 'subject', $4, $5)`,
        [
          req.principal.tenantId,
          req.principal.kind,
          req.principal.id,
          id,
          String(req.id),
        ],
      );

      return { subject_id: id, is_minor: isMinor };
    });

    return reply.status(201).send(result);
  });

  /** Vincula uma conversa a um cadastro já existente (paciente de retorno). */
  app.post('/conversations/:conversationId/link-subject', async (req) => {
    requireScope(req.principal, 'subjects:lookup');
    const params = z.object({ conversationId: z.string().min(1) }).parse(req.params);
    const body = z.object({ subject_id: z.string().min(1) }).parse(req.body);
    const authorized = requireConversation(req.principal);

    if (params.conversationId !== authorized) {
      throw new ApiError('CONVERSATION_SUBJECT_MISMATCH', 'Token não autoriza esta conversa.');
    }

    const { rowCount } = await req.ctx.db.query(
      `UPDATE conversations c SET subject_id = $1, updated_at = now()
        WHERE c.id = $2 AND c.tenant_id = $3
          AND EXISTS (SELECT 1 FROM subjects s WHERE s.id = $1 AND s.tenant_id = $3)`,
      [body.subject_id, authorized, req.principal.tenantId],
    );
    if (rowCount === 0) throw new ApiError('NOT_FOUND', 'Conversa ou cadastro não encontrado.');
    return { linked: true };
  });
}

function ageInYears(birthDate: string): number {
  const [y, m, d] = birthDate.split('-').map(Number);
  const birth = new Date(Date.UTC(y ?? 1900, (m ?? 1) - 1, d ?? 1));
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - birth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}
