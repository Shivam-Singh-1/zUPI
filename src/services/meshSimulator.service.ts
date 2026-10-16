import { MeshPacket, GossipResponse } from '../types/mesh.types.js';
import { VirtualDevice } from './virtualDevice.js';

export interface BridgeUpload {
  bridgeNodeId: string;
  packet: MeshPacket;
}

export class MeshSimulatorService {
  private readonly devices = new Map<string, VirtualDevice>();

  constructor() {
    this.seedDefaultDevices();
  }

  private seedDefaultDevices(): void {
    this.devices.set('phone-alice', new VirtualDevice('phone-alice', false));
    this.devices.set('phone-stranger1', new VirtualDevice('phone-stranger1', false));
    this.devices.set('phone-stranger2', new VirtualDevice('phone-stranger2', false));
    this.devices.set('phone-stranger3', new VirtualDevice('phone-stranger3', false));
    this.devices.set('phone-bridge', new VirtualDevice('phone-bridge', true));
  }

  public getDevices(): VirtualDevice[] {
    return Array.from(this.devices.values());
  }

  public getDevice(id: string): VirtualDevice | undefined {
    return this.devices.get(id);
  }

  public inject(senderDeviceId: string, packet: MeshPacket): void {
    const sender = this.devices.get(senderDeviceId);
    if (!sender) {
      throw new Error(`Unknown device: ${senderDeviceId}`);
    }
    sender.hold(packet);
    console.info(
      { packetId: packet.packetId.substring(0, 8), senderDeviceId, ttl: packet.ttl },
      'Packet injected into mesh'
    );
  }

  /**
   * One round of Bluetooth gossip. Every device shares held packets with every
   * other device, decrementing TTL per hop.
   */
  public gossipOnce(): GossipResponse {
    let transfers = 0;
    const deviceList = Array.from(this.devices.values());

    // Snapshot state before round starts to avoid multi-hop cascade in a single round
    const snapshot = new Map<string, MeshPacket[]>();
    for (const d of deviceList) {
      snapshot.set(d.deviceId, d.getHeldPackets());
    }

    for (const src of deviceList) {
      const srcPackets = snapshot.get(src.deviceId) ?? [];
      for (const pkt of srcPackets) {
        if (pkt.ttl <= 0) {
          continue;
        }

        for (const dst of deviceList) {
          if (dst.deviceId === src.deviceId) {
            continue;
          }
          if (dst.holds(pkt.packetId)) {
            continue;
          }

          const copy: MeshPacket = {
            packetId: pkt.packetId,
            ttl: pkt.ttl - 1,
            createdAt: pkt.createdAt,
            ciphertext: pkt.ciphertext,
          };

          dst.hold(copy);
          transfers++;
        }
      }
    }

    console.info({ transfers }, 'Gossip round complete');
    return {
      transfers,
      deviceCounts: this.snapshotMap(),
    };
  }

  public snapshotMap(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const d of this.devices.values()) {
      counts[d.deviceId] = d.packetCount();
    }
    return counts;
  }

  public collectBridgeUploads(): BridgeUpload[] {
    const uploads: BridgeUpload[] = [];
    for (const d of this.devices.values()) {
      if (!d.hasInternet) {
        continue;
      }
      for (const pkt of d.getHeldPackets()) {
        uploads.push({
          bridgeNodeId: d.deviceId,
          packet: { ...pkt },
        });
      }
    }
    return uploads;
  }

  public resetMesh(): void {
    for (const d of this.devices.values()) {
      d.clear();
    }
  }
}

export const meshSimulatorService = new MeshSimulatorService();
