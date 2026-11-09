import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Criptografia de campo para dado pessoal (nome, telefone, nascimento).
 *
 * O disco já é criptografado pelo provedor; isto protege o caso em que o dump
 * do banco escapa (backup, réplica, acesso indevido ao SQL): quem lê a tabela
 * não lê o paciente.
 *
 * Formato: [versão da chave (1 byte)][IV (12)][tag (16)][ciphertext].
 * Em produção a chave vem do KMS por envelope encryption; `keyVersion` existe
 * para permitir rotação sem reescrever a base de uma vez.
 */
const KEY_VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

export class FieldCrypto {
  readonly #key: Buffer;
  readonly #pepper: string;

  constructor(keyBase64: string, pepper: string) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) {
      throw new Error('FIELD_ENCRYPTION_KEY deve ter 32 bytes em base64.');
    }
    if (pepper.length < 16) {
      throw new Error('SUBJECT_PHONE_PEPPER deve ter ao menos 16 caracteres.');
    }
    this.#key = key;
    this.#pepper = pepper;
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([KEY_VERSION]), iv, cipher.getAuthTag(), body]);
  }

  decrypt(blob: Buffer): string {
    if (blob.length < 1 + IV_LEN + TAG_LEN) {
      throw new Error('Blob criptografado inválido.');
    }
    const version = blob[0];
    if (version !== KEY_VERSION) {
      throw new Error(`Versão de chave não suportada: ${String(version)}`);
    }
    const iv = blob.subarray(1, 1 + IV_LEN);
    const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
    const body = blob.subarray(1 + IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }

  /**
   * Busca por telefone sem guardar o telefone em claro nem permitir
   * enumeração offline: HMAC com pepper guardado fora do banco.
   */
  phoneHash(phoneE164: string): Buffer {
    const normalized = phoneE164.replace(/[^\d+]/g, '');
    return createHmac('sha256', this.#pepper).update(normalized).digest();
  }
}
