import crypto from 'node:crypto';
import { MeshPacket } from '../types/mesh.types.js';

// -----------------------------------------------------------------------------
// Virtual BLE Device Node (with Seen-Set & Kill-Switch ACKs)
// -----------------------------------------------------------------------------

export class VirtualDevice {
  private readonly heldPackets = new Map<string, MeshPacket>();
  public readonly seenHashes = new Set<string>();
  public readonly settledHashes = new Set<string>();

  constructor(
    public readonly deviceId: string,
    public readonly hasInternet: boolean
  ) {}

  /**
   * Receives an incoming packet with Upgrade 1 Deduplication Rules:
   * Rule 1: If packet already settled on server, drop immediately.
   * Rule 2: If phone has already seen this packet, drop to prevent loop flooding.
   */
  public receivePacket(packet: MeshPacket, packetHash?: string): boolean {
    const hash = packetHash ?? this.computeHash(packet.ciphertext);

    // Rule 1: Kill-Switch check — already settled on backend
    if (this.settledHashes.has(hash)) {
      return false;
    }

    // Rule 2: Loop prevention — already seen by this node
    if (this.seenHashes.has(hash)) {
      return false;
    }

    this.seenHashes.add(hash);

    if (packet.ttl > 0) {
      this.heldPackets.set(packet.packetId, { ...packet });
    }
    return true;
  }

  /**
   * Legacy wrapper for direct injection
   */
  public hold(packet: MeshPacket): void {
    const hash = this.computeHash(packet.ciphertext);
    this.receivePacket(packet, hash);
  }

  /**
   * Upgrade 1 Reverse ACK: Clears packet buffer once confirmed settled.
   */
  public receiveSettlementAck(packetHash: string): void {
    this.settledHashes.add(packetHash);

    // Evict settled packet from local buffer
    for (const [id, pkt] of this.heldPackets.entries()) {
      if (id === packetHash || pkt.packetId === packetHash) {
        this.heldPackets.delete(id);
        continue;
      }

      const hash = this.computeHash(pkt.ciphertext);
      if (hash === packetHash) {
        this.heldPackets.delete(id);
      }
    }
  }

  public getHeldPackets(): MeshPacket[] {
    return Array.from(this.heldPackets.values());
  }

  public holds(packetId: string): boolean {
    return this.heldPackets.has(packetId);
  }

  public packetCount(): number {
    return this.heldPackets.size;
  }

  public clear(): void {
    this.heldPackets.clear();
    this.seenHashes.clear();
    this.settledHashes.clear();
  }

  private computeHash(ciphertext: string): string {
    return crypto.createHash('sha256').update(ciphertext, 'utf8').digest('hex');
  }
}
