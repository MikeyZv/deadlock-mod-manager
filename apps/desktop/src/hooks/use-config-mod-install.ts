import { toast } from "@deadlock-mods/ui/components/sonner";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { createLogger } from "@/lib/logger";
import { hasVpks, installConfigMod } from "@/lib/mods/config-mods";
import { usePersistedStore } from "@/lib/store";
import {
  type ConfigModInstallResult,
  type LocalMod,
  ModStatus,
} from "@/types/mods";

const logger = createLogger("config-mod-install");

/**
 * Applies a config mod and reconciles the store afterwards.
 *
 * Lives in a hook rather than alongside the other config-mod helpers because it
 * needs the store, and `config-mods.ts` cannot import it without a cycle
 * (store -> installed-helpers -> config-mods). Both install paths share this so
 * they cannot drift apart on what happens to the mod that got displaced.
 */
export const useConfigModInstall = () => {
  const { t } = useTranslation();
  const setConfigMod = usePersistedStore((state) => state.setConfigMod);
  const setModStatus = usePersistedStore((state) => state.setModStatus);
  const setModEnabledInCurrentProfile = usePersistedStore(
    (state) => state.setModEnabledInCurrentProfile,
  );

  return useCallback(
    async (
      mod: Pick<LocalMod, "remoteId" | "name">,
      profileFolder: string | null,
      variant?: string | null,
    ): Promise<ConfigModInstallResult> => {
      logger
        .withMetadata({ modId: mod.remoteId, profileFolder, variant })
        .info("Installing config mod");

      // The backend remembers the applied version only while the mod is still the
      // active config mod, and disabling one clears that. The store kept the user's
      // pick, so a re-enable restores it instead of silently dropping to the first
      // valid version. An explicit pick always wins.
      const remembered = usePersistedStore
        .getState()
        .localMods.find((m) => m.remoteId === mod.remoteId)
        ?.configMod?.activeVariant;

      const result = await installConfigMod(
        mod,
        profileFolder,
        variant ?? remembered,
      );

      setConfigMod(mod.remoteId, result.config);

      // Only one config mod can own gameinfo.gi, so the one it displaced is no
      // longer applied and has to stop looking enabled.
      if (result.replacedModId) {
        const replaced = usePersistedStore
          .getState()
          .localMods.find((m) => m.remoteId === result.replacedModId);

        logger
          .withMetadata({
            modId: mod.remoteId,
            replacedModId: result.replacedModId,
          })
          .info("Config mod replaced the previously applied one");

        // A mod that also ships VPKs keeps its status: only its config was displaced,
        // and marking it disabled would strand those VPKs, which `useUninstall`
        // reaches only while the mod still reads as installed.
        if (!(replaced && hasVpks(replaced))) {
          setModStatus(result.replacedModId, ModStatus.Downloaded);
          setModEnabledInCurrentProfile(result.replacedModId, false);
        }

        toast.info(
          t("configMods.replaced", {
            name: replaced?.name ?? result.replacedModId,
          }),
        );
      }

      return result;
    },
    [setConfigMod, setModStatus, setModEnabledInCurrentProfile, t],
  );
};
