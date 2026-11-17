import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import {
  llmCredentialWriteSchema,
  llmSealedCredentialSchema,
  LlmConfigurationError,
  type LlmCredentialPort,
} from '@trinity-harness/contracts';
/** Envelope encryption: random AES-GCM data key wrapped by an infrastructure AES-GCM key. */
export class EncryptedLlmCredentials implements LlmCredentialPort {
  private readonly keys: Map<string, Buffer>;
  constructor(
    private readonly currentKeyId: string,
    keys: Record<string, string>,
  ) {
    this.keys = new Map(
      Object.entries(keys).map(([id, encoded]) => {
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length !== 32 || bytes.toString('base64') !== encoded)
          throw new Error('LLM encryption keys must be canonical base64 32-byte keys');
        return [id, bytes];
      }),
    );
    if (!this.keys.has(currentKeyId)) throw new Error('Current LLM encryption key unavailable');
  }
  async seal(
    tenantId: string,
    connectionId: string,
    versionId: string,
    secret: string,
  ): Promise<string> {
    llmCredentialWriteSchema.shape.secret.parse(secret);
    const key = this.keys.get(this.currentKeyId)!;
    const aad = JSON.stringify([tenantId, connectionId, versionId]);
    const dataKey = randomBytes(32);
    try {
      const iv = randomBytes(12),
        wrapIv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
      cipher.setAAD(Buffer.from(aad));
      const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      const wrap = createCipheriv('aes-256-gcm', key, wrapIv);
      wrap.setAAD(Buffer.from(`key:${aad}`));
      const wrappedKey = Buffer.concat([wrap.update(dataKey), wrap.final()]);
      return JSON.stringify({
        version: 1,
        keyId: this.currentKeyId,
        wrappedKey: wrappedKey.toString('base64'),
        wrapIv: wrapIv.toString('base64'),
        wrapTag: wrap.getAuthTag().toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        body: body.toString('base64'),
        digest: createHmac('sha256', key).update(aad).update(secret).digest('hex'),
      });
    } finally {
      dataKey.fill(0);
    }
  }

  async open(
    tenantId: string,
    connectionId: string,
    versionId: string,
    sealed: string,
  ): Promise<string> {
    try {
      const data = llmSealedCredentialSchema.parse(JSON.parse(sealed));
      const key = this.keys.get(data.keyId);
      if (!key) throw new Error('key unavailable');
      const aad = JSON.stringify([tenantId, connectionId, versionId]);
      const wrap = createDecipheriv('aes-256-gcm', key, Buffer.from(data.wrapIv, 'base64'));
      wrap.setAAD(Buffer.from(`key:${aad}`));
      wrap.setAuthTag(Buffer.from(data.wrapTag, 'base64'));
      const dataKey = Buffer.concat([
        wrap.update(Buffer.from(data.wrappedKey, 'base64')),
        wrap.final(),
      ]);
      try {
        const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(data.iv, 'base64'));
        decipher.setAAD(Buffer.from(aad));
        decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
        return Buffer.concat([
          decipher.update(Buffer.from(data.body, 'base64')),
          decipher.final(),
        ]).toString('utf8');
      } finally {
        dataKey.fill(0);
      }
    } catch {
      throw new LlmConfigurationError('UNAVAILABLE', 'Provider credential unavailable');
    }
  }
}
