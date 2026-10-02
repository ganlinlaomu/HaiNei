import { signInWithGoogle } from "@/services/recovery/googleAuth";
import { GoogleDriveBackupService } from "@/services/recovery/googleDriveBackup";
import type { RecoveryProvider, RecoveryProviderAdapter } from "@/services/recovery/types";

export async function beginRecovery(
  provider: RecoveryProvider,
  options: { googleClientId?: string } = {},
): Promise<RecoveryProviderAdapter> {
  if (provider === "google") {
    const session = await signInWithGoogle(options.googleClientId || "");
    return new GoogleDriveBackupService(session);
  }
  throw new Error("Apple 恢复将在下一阶段接入");
}
