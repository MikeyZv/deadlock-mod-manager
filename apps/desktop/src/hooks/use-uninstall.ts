import { toast } from "@deadlock-mods/ui/components/sonner";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useConfirm } from "@/components/providers/alert-dialog";
import logger from "@/lib/logger";
import {
  hasVpks,
  isConfigMod,
  uninstallConfigMod,
} from "@/lib/mods/config-mods";
import { usePersistedStore } from "@/lib/store";
import { type LocalMod, ModStatus } from "@/types/mods";
import { isTauriError } from "@/types/tauri";
import { useVpkScan } from "./use-vpk-scan";

const useUninstall = () => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const removeMod = usePersistedStore((state) => state.removeMod);
  const setModStatus = usePersistedStore((state) => state.setModStatus);
  const setModEnabledInCurrentProfile = usePersistedStore(
    (state) => state.setModEnabledInCurrentProfile,
  );
  const getActiveProfile = usePersistedStore((state) => state.getActiveProfile);
  const { refetch: refetchVpkScan } = useVpkScan();

  const uninstall = async (mod: LocalMod, remove: boolean) => {
    try {
      if (remove) {
        const shouldUninstall = !!(await confirm({
          title: t("mods.deleteConfirmTitle"),
          body: t("mods.deleteConfirmBody"),
          tone: "destructive",
          actionButton: t("mods.deleteConfirmAction"),
          cancelButton: t("mods.deleteConfirmCancel"),
        }));
        if (!shouldUninstall) {
          return;
        }
      }

      const activeProfile = getActiveProfile();
      const profileFolder = activeProfile?.folderName ?? null;

      // A config mod owns the game's gameinfo.gi, so disabling it means putting the
      // previous game config back. Deleting it is left to `purge_mod`, which restores
      // the config before removing the mod's files. A mod that also ships VPKs falls
      // through afterwards to have those disabled too.
      if (isConfigMod(mod) && mod.status === ModStatus.Installed && !remove) {
        logger
          .withMetadata({ modId: mod.remoteId, profileFolder })
          .info("Disabling config mod");
        await uninstallConfigMod(mod.remoteId, profileFolder);

        if (!hasVpks(mod)) {
          setModStatus(mod.remoteId, ModStatus.Downloaded);
          setModEnabledInCurrentProfile(mod.remoteId, false);
          toast.success(t("mods.disableSuccess"));
          return;
        }
      }

      if (mod.status === ModStatus.Installed) {
        logger
          .withMetadata({
            modId: mod.remoteId,
            vpks: mod.installedVpks,
            profileFolder,
          })
          .info("Uninstalling mod");
        if (remove) {
          await invoke("purge_mod", {
            modId: mod.remoteId,
            vpks: mod.installedVpks ?? [],
            profileFolder,
          });
        } else {
          await invoke("uninstall_mod", {
            modId: mod.remoteId,
            vpks: mod.installedVpks ?? [],
            profileFolder,
          });
          setModStatus(mod.remoteId, ModStatus.Downloaded);
          setModEnabledInCurrentProfile(mod.remoteId, false);
        }
      } else if (remove) {
        logger
          .withMetadata({ modId: mod.remoteId, profileFolder })
          .info("Purging disabled mod");
        await invoke("purge_mod", {
          modId: mod.remoteId,
          vpks: [],
          profileFolder,
        });
      }

      if (remove) {
        removeMod(mod.remoteId);
        refetchVpkScan();
      }

      toast.success(
        remove ? t("mods.deleteSuccess") : t("mods.disableSuccess"),
      );
    } catch (error) {
      // Tauri rejects with a plain {kind, message} object, which `errorOnly`
      // renders as an empty line.
      logger
        .withMetadata({ modId: mod.remoteId, remove, error })
        .error("Failed to uninstall mod");

      if (isTauriError(error) && error.kind === "vpkInUse") {
        toast.error(remove ? t("mods.deleteError") : t("mods.disableError"), {
          description: t("mods.deleteErrorVpkInUse"),
        });
        return;
      }

      // Raised only when the mod being removed owns the game's gameinfo.gi. The
      // removal was refused before anything was deleted, so it is worth telling
      // the user it succeeds once the game is closed.
      if (isTauriError(error) && error.kind === "gameRunning") {
        toast.error(remove ? t("mods.deleteError") : t("mods.disableError"), {
          description: t("mods.deleteErrorGameRunning"),
        });
        return;
      }

      toast.error(remove ? t("mods.deleteError") : t("mods.disableError"));
    }
  };

  return { uninstall };
};

export default useUninstall;
