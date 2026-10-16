import crypto, { KeyObject } from 'node:crypto';
import { PaymentInstruction, PaymentInstructionSchema } from '../types/mesh.types.js';
import { ServerKeyHolder, serverKeyHolder } from './serverKeyHolder.js';

// -----------------------------------------------------------------------------
// Constants matching wire-format byte layout
// -----------------------------------------------------------------------------
const RSA_ENCRYPTED_KEY_BYTES = 256; // 2048-bit RSA modulus
const GCM_IV_BYTES = 12; // Standard 96-bit AES-GCM IV
const GCM_TAG_BYTES = 16; // 128-bit authentication tag
const MIN_PACKET_BYTES = RSA_ENCRYPTED_KEY_BYTES + GCM_IV_BYTES + GCM_TAG_BYTES;

export class HybridCryptoService {
  constructor(private readonly serverKey: ServerKeyHolder = serverKeyHolder) {}

  /**
   * Encrypts a payment instruction with the server's RSA public key using a hybrid scheme:
   * 1. Generates a one-time 256-bit AES key.
   * 2. Encrypts JSON payload with AES-256-GCM.
   * 3. Encrypts the AES key with RSA-OAEP (SHA-256).
   * 4. Packs into: [256B Encrypted Key | 12B IV | Ciphertext | 16B GCM Tag]
   * 5. Returns as Base64 string.
   */
  public encrypt(instruction: PaymentInstruction, serverPublicKey: KeyObject): string {
    const jsonString = JSON.stringify(instruction);
    const plaintext = Buffer.from(jsonString, 'utf8');

    // 1. Generate one-time 256-bit AES key
    const aesKey = crypto.randomBytes(32);

    // 2. Encrypt payload with AES-256-GCM
    const iv = crypto.randomBytes(GCM_IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const aesCiphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // 3. Encrypt AES key with RSA-OAEP (SHA-256)
    const encryptedAesKey = crypto.publicEncrypt(
      {
        key: serverPublicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      aesKey
    );

    // 4. Pack: [256B Encrypted Key | 12B IV | Ciphertext | 16B Tag]
    const packed = Buffer.concat([encryptedAesKey, iv, aesCiphertext, authTag]);
    return packed.toString('base64');
  }

  /**
   * Decrypts the Base64 ciphertext using the server's RSA private key.
   * Throws an error if tampered, truncated, or forged.
   */
  public decrypt(base64Ciphertext: string): PaymentInstruction {
    const all = Buffer.from(base64Ciphertext, 'base64');

    if (all.length < MIN_PACKET_BYTES) {
      throw new Error(`Ciphertext too short: ${all.length} bytes (minimum ${MIN_PACKET_BYTES})`);
    }

    const encryptedAesKey = all.subarray(0, RSA_ENCRYPTED_KEY_BYTES);
    const iv = all.subarray(RSA_ENCRYPTED_KEY_BYTES, RSA_ENCRYPTED_KEY_BYTES + GCM_IV_BYTES);
    const aesCiphertext = all.subarray(
      RSA_ENCRYPTED_KEY_BYTES + GCM_IV_BYTES,
      all.length - GCM_TAG_BYTES
    );
    const authTag = all.subarray(all.length - GCM_TAG_BYTES);

    // 1. RSA-OAEP decrypt the AES key
    const aesKey = crypto.privateDecrypt(
      {
        key: this.serverKey.getPrivateKey(),
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      encryptedAesKey
    );

    // 2. AES-256-GCM decrypt and authenticate
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(aesCiphertext), decipher.final()]);

    const parsed = JSON.parse(plaintext.toString('utf8'));
    return PaymentInstructionSchema.parse(parsed);
  }

  /**
   * Computes SHA-256 hex digest of the base64 ciphertext string.
   * Used as the globally unique idempotency key.
   */
  public hashCiphertext(base64Ciphertext: string): string {
    return crypto.createHash('sha256').update(base64Ciphertext, 'utf8').digest('hex');
  }
}

export const hybridCryptoService = new HybridCryptoService();
