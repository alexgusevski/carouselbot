import { chmod, mkdir } from "node:fs/promises";

// mkdir's mode applies only when it creates the folder. Enforce owner-only
// access on every start, including folders left by older versions and the
// legacy SlideStudioMCP location. Windows ACLs are inherited from the profile.
export async function secureStateDirectory(directory, { platform = process.platform } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (platform !== "win32") await chmod(directory, 0o700);
}
