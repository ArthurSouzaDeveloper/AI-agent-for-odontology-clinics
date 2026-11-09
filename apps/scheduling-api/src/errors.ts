import { HTTP_STATUS_BY_CODE, type ErrorCode, type ProblemDetails } from '@app/contracts';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fieldErrors?: Array<{ path: string; message: string }>;

  constructor(
    code: ErrorCode,
    message: string,
    fieldErrors?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = HTTP_STATUS_BY_CODE[code];
    if (fieldErrors) this.fieldErrors = fieldErrors;
  }
}

const TITLES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'Dados inválidos',
  UNAUTHORIZED: 'Não autenticado',
  FORBIDDEN: 'Sem permissão',
  NOT_FOUND: 'Não encontrado',
  SLOT_TAKEN: 'Horário indisponível',
  SLOT_INVALID: 'Horário inválido',
  SLOT_TOKEN_EXPIRED: 'Oferta de horário expirada',
  HOLD_EXPIRED: 'Reserva expirada',
  HOLD_ALREADY_USED: 'Reserva já utilizada',
  HOLD_LIMIT_REACHED: 'Limite de reservas simultâneas',
  SERVICE_NOT_BOOKABLE_BY_AGENT: 'Serviço não agendável pelo agente',
  PRIORITY_TOO_LOW_FOR_SLOT: 'Prioridade insuficiente para o horário',
  CONVERSATION_SUBJECT_MISMATCH: 'Conversa não corresponde ao cadastro',
  SUBJECT_ALREADY_BOOKED_SAME_DAY: 'Já existe agendamento no mesmo dia',
  IDEMPOTENCY_KEY_REUSED: 'Chave de idempotência reutilizada',
  VERSION_MISMATCH: 'Registro alterado por outra pessoa',
  RATE_LIMITED: 'Muitas requisições',
  INTERNAL: 'Erro interno',
};

export function toProblem(err: ApiError, requestId?: string): ProblemDetails {
  const problem: ProblemDetails = {
    type: `https://api.example/errors/${err.code.toLowerCase().replaceAll('_', '-')}`,
    title: TITLES[err.code],
    status: err.status,
    code: err.code,
  };
  if (err.message) problem.detail = err.message;
  if (requestId) problem.request_id = requestId;
  if (err.fieldErrors) problem.errors = err.fieldErrors;
  return problem;
}
