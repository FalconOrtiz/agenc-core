/** Local management contract. Never sent to an unauthenticated browser. */
export const REMOTE_METHODS = [
  "remote.capabilities", "remote.status", "remote.start", "remote.stop",
  "remote.pair.begin", "remote.pair.refresh", "remote.pair.cancel",
  "remote.devices", "remote.pending", "remote.approve", "remote.revoke",
] as const;
export type RemoteMethod = (typeof REMOTE_METHODS)[number];
export type RemoteRole = "view" | "control";
export interface RemotePairParams {
  readonly workspacePath: string;
  readonly sessionIds: readonly string[];
  readonly role: RemoteRole;
  readonly allowFiles?: boolean;
  readonly allowApprovals?: boolean;
}
export interface RemoteDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly role: RemoteRole;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly sessionIds: readonly string[];
  readonly allowFiles: boolean;
  readonly allowApprovals: boolean;
  readonly connected: boolean;
  readonly approvedAt: string;
}
export interface RemotePairing {
  readonly pairingId: string;
  readonly code: string;
  readonly pairUrl: string;
  readonly qrDataUrl: string;
  readonly expiresAt: string;
  readonly status: "pending" | "claimed";
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly sessionIds: readonly string[];
  readonly role: RemoteRole;
  readonly allowFiles: boolean;
  readonly allowApprovals: boolean;
  readonly deviceId?: string;
  readonly deviceLabel?: string;
}
export interface RemoteStatus {
  readonly enabled: boolean;
  readonly state: "stopped" | "idle" | "pairing" | "connecting" | "connected" | "reconnecting" | "error";
  readonly connectedDevices: number;
  readonly devices: readonly RemoteDevice[];
  readonly pairing: RemotePairing | null;
  /** Stable public code; never raw backend errors, credentials, or URLs with tickets. */
  readonly error: string | null;
}
export interface RemoteCapabilities {
  readonly available: true;
  readonly contractVersion: 1;
  readonly browserProtocol: "agenc-browser-v2";
  readonly roles: readonly RemoteRole[];
  readonly workspaceScope: "explicit-sessions";
  readonly supportsFiles: true;
  readonly supportsApprovals: true;
  readonly supportsSessionCreate: boolean;
  readonly supportsPendingApprovals: true;
  readonly requiresLocalApproval: true;
  readonly requiresSignIn: true;
}
export interface RemoteBackendPair {
  readonly pairingId: string;
  readonly hostSecret: string;
  readonly code: string;
  readonly pairUrl: string;
  readonly expiresAt: string;
  readonly relayUrl: string;
}
export interface RemoteBackendPoll {
  readonly pairingId: string;
  readonly status: "pending" | "claimed" | "active" | "revoked" | "expired";
  readonly device: { readonly deviceId: string; readonly label: string; readonly role: RemoteRole; readonly workspaceIds: readonly string[] } | null;
  readonly hostTicket?: string;
  readonly ticketExpiresAt?: string;
}
export interface RemoteBackend {
  start(params: { machineName: string; role: RemoteRole; workspaceIds: string[] }, signal: AbortSignal): Promise<RemoteBackendPair>;
  poll(pair: RemoteBackendPair, signal: AbortSignal): Promise<RemoteBackendPoll>;
  approve(pair: RemoteBackendPair, deviceId: string, signal: AbortSignal): Promise<RemoteBackendPoll>;
  revoke(pair: RemoteBackendPair, signal: AbortSignal): Promise<void>;
}
export class RemoteError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "RemoteError"; }
}
