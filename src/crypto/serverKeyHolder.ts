import crypto, { KeyObject } from 'node:crypto';

// -----------------------------------------------------------------------------
// Server Key Holder — In-Memory RSA-2048 Keypair Lifecycle
// -----------------------------------------------------------------------------

export class ServerKeyHolder {
  private publicKey!: KeyObject;
  private privateKey!: KeyObject;
  private publicKeyBase64!: string;

  constructor() {
    this.init();
  }

  public init(): void {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });

    this.publicKey = publicKey;
    this.privateKey = privateKey;

    const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
    this.publicKeyBase64 = spkiDer.toString('base64');

    const fingerprint = crypto.createHash('sha256').update(spkiDer).digest('hex').substring(0, 16);
    // Structured log with stable message string
    console.info({ fingerprint, keySize: 2048 }, 'Server RSA keypair generated (2048-bit)');
  }

  public getPublicKey(): KeyObject {
    return this.publicKey;
  }

  public getPrivateKey(): KeyObject {
    return this.privateKey;
  }

  public getPublicKeyBase64(): string {
    return this.publicKeyBase64;
  }
}

export const serverKeyHolder = new ServerKeyHolder();
