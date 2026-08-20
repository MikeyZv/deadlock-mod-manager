import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import { createLogger } from "@/lib/logger";
import { hasVpks, resolveConfigMod } from "@/lib/mods/config-mods";
import { usePersistedStore } from "@/lib/store";
import { type InstallableMod, type LocalMod, ModStatus } from "@/types/mods";
import type { ErrorKind } from "@/types/tauri";
import { useConfigModInstall } from "./use-config-mod-install";

const logger = createLogger("install");

export type InstallOptions = {
  onStart: (mod: LocalMod) => void;
  onComplete: (mod: LocalMod, result: InstallableMod) => void;
  onError: (mod: LocalMod, error: ErrorKind) => void;
};

export type InstallFunction = (
  mod: LocalMod,
  options: InstallOptions,
) => Promise<InstallableMod | null>;

const useInstall = () => {
  const { getActiveProfile } = usePersistedStore();
  const installConfigModForMod = useConfigModInstall();

  const install: InstallFunction = useCallback(
    async (mod, options) => {
      try {
        options.onStart(mod);

        if (mod.status === ModStatus.Installed) {
          throw new Error("Mod is already installed!");
        }

        const activeProfile = getActiveProfile();
        const profileFolder = activeProfile?.folderName ?? null;

        // The 1-click caller builds its mod from the API DTO, which never carries
        // `configMod`, so the stashed config has to be read from the backend. A
        // failed probe must not sink an otherwise installable VPK mod.
        const configMod = await resolveConfigMod(mod).catch((error) => {
          logger
            .withMetadata({ modId: mod.remoteId })
            .withError(error)
            .warn("Failed to check whether the mod is a config mod");
          return null;
        });

        if (configMod) {
          await installConfigModForMod(mod, profileFolder);
        }

        // The 1-click caller builds its mod from the API DTO, so the object here
        // carries neither the installed VPKs nor the file tree even when the download
        // wrote both to the store. Reading the stored mod back keeps a VPK mod that
        // also ships a config from being mistaken for a config-only one.
        const stored = usePersistedStore
          .getState()
          .localMods.find((m) => m.remoteId === mod.remoteId);

        // An author who ships a config alongside VPKs means the two to work together,
        // so both are applied. `install_mod` rejects a mod with no VPKs to enable, so
        // it is skipped only when the config really is all there is.
        const result: InstallableMod =
          configMod && !hasVpks(stored ?? mod)
            ? { id: mod.remoteId, name: mod.name, installed_vpks: [] }
            : ((await invoke("install_mod", {
                deadlockMod: {
                  id: mod.remoteId,
                  name: mod.name,
                  is_map: mod.isMap,
                },
                profileFolder,
              })) as InstallableMod);

        options.onComplete(mod, result);

        return result;
      } catch (error: unknown) {
        if (error instanceof Error) {
          options.onError(mod, {
            kind: "unknown",
            message: error.message,
          });
        } else if (
          typeof error === "object" &&
          error !== null &&
          "kind" in error
        ) {
          options.onError(mod, error as ErrorKind);
        }
        return null;
      }
    },
    [getActiveProfile, installConfigModForMod],
  );

  return { install };
};

export default useInstall;
