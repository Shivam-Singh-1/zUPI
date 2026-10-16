import { MeshPacket } from '../types/mesh.types.js';

// -----------------------------------------------------------------------------
// Virtual BLE Device Node
// -----------------------------------------------------------------------------

export class VirtualDevice {
  private readonly heldPackets = new Map<string, MeshPacket>();

  constructor(
    public readonly deviceId: string,
    public readonly hasInternet: boolean
  ) {}

  public hold(packet: MeshPacket): void {
    if (!this.heldPackets.has(packet.packetId)) {
      this.heldPackets.set(packet.packetId, { ...packet });
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
  }
}
