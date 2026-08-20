import { isConfigMod } from "@/lib/mods/config-mods";
import { type LocalMod, ModStatus } from "@/types/mods";

export function isInstalledModWithVpks(mod: LocalMod): boolean {
  return (
    mod.status === ModStatus.Installed &&
    !!mod.installedVpks &&
    mod.installedVpks.length > 0
  );
}

/**
 * Whether a mod is currently applied to the game. Config mods count even though
 * they install no VPKs — they replace gameinfo.gi instead.
 */
export function isModEnabled(mod: LocalMod): boolean {
  return (
    isInstalledModWithVpks(mod) ||
    (isConfigMod(mod) && mod.status === ModStatus.Installed)
  );
}
