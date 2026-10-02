export type RecoveryProvider = "google" | "apple";

export interface RecoveryProviderSession {
  provider: RecoveryProvider;
  subject: string;
  accessToken?: string;
  expiresAt?: number;
}

export interface RecoveryBackup {
  id: string;
  name: string;
  modifiedTime?: string;
}

export interface RecoveryProviderAdapter {
  readonly provider: RecoveryProvider;
  readonly subject: string;
  listBackups(): Promise<RecoveryBackup[]>;
  downloadBackup(id: string): Promise<string>;
  uploadBackup(payload: string): Promise<RecoveryBackup>;
  deleteBackup(id: string): Promise<void>;
}
