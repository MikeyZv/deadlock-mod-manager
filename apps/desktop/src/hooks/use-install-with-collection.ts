import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { useState } from "react";
import { createLogger } from "@/lib/logger";
import { hasVpks, resolveConfigMod } from "@/lib/mods/config-mods";
import { usePersistedStore } from "@/lib/store";
import { useConfigModInstall } from "./use-config-mod-install";
import type {
  InstallableMod,
  LocalMod,
  LocalModWithFiles,
  ModFileTree,
} from "@/types/mods";
import { ModStatus } from "@/types/mods";
import type { ErrorKind } from "@/types/tauri";

const logger = createLogger("install-with-collection");

// Every rejection has to reach onError or the mod stays stuck in Installing.
// An empty message is deliberate: callers substitute their own localized copy.
const toUnknownError = (error: unknown): ErrorKind => {
  if (typeof error === "string") {
    return { kind: "unknown", message: error };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return { kind: "unknown", message: error.message };
  }
  return { kind: "unknown", message: "" };
};

const toErrorKind = (error: unknown): ErrorKind => {
  if (error instanceof Error) {
    return { kind: "unknown", message: error.message };
  }
  if (typeof error === "object" && error !== null && "kind" in error) {
    return error as ErrorKind;
  }
  return toUnknownError(error);
};

export type InstallWithCollectionOptions = {
  onStart: (mod: LocalMod) => void;
  onComplete: (mod: LocalMod, result: InstallableMod) => void;
  onError: (mod: LocalMod, error: ErrorKind) => void;
  onCancel?: (mod: LocalMod) => void;
  onFileTreeAnalyzed?: (mod: LocalMod, fileTree: ModFileTree) => void;
};

export type InstallWithCollectionFunction = (
  mod: LocalMod,
  options: InstallWithCollectionOptions,
  preselectedFileTree?: ModFileTree,
) => Promise<InstallableMod | null>;

export type UseInstallWithCollectionReturn = {
  install: InstallWithCollectionFunction;
  isAnalyzing: boolean;
  currentFileTree: ModFileTree | null;
  showFileSelector: boolean;
  setShowFileSelector: (show: boolean) => void;
  confirmInstallation: (fileTree: ModFileTree) => Promise<void>;
  cancelInstallation: () => void;
  currentMod: LocalMod | null;
  currentOptions: InstallWithCollectionOptions | null;
};

const useInstallWithCollection = (): UseInstallWithCollectionReturn => {
  const getActiveProfile = usePersistedStore((state) => state.getActiveProfile);
  const setConfigMod = usePersistedStore((state) => state.setConfigMod);
  const installConfigModForMod = useConfigModInstall();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [currentFileTree, setCurrentFileTree] = useState<ModFileTree | null>(
    null,
  );
  const [showFileSelector, setShowFileSelector] = useState(false);
  const [currentMod, setCurrentMod] = useState<LocalMod | null>(null);
  const [currentOptions, setCurrentOptions] =
    useState<InstallWithCollectionOptions | null>(null);

  // A mod whose only content is a gameinfo.gi has nothing for the file-tree selection
  // below to act on.
  const performConfigModInstallation = async (
    mod: LocalMod,
    options: InstallWithCollectionOptions,
    variant?: string,
  ): Promise<InstallableMod | null> => {
    try {
      const activeProfile = getActiveProfile();
      const profileFolder = activeProfile?.folderName ?? null;

      await installConfigModForMod(mod, profileFolder, variant);

      const installed: InstallableMod = {
        id: mod.remoteId,
        name: mod.name,
        installed_vpks: [],
      };

      options.onComplete(mod, installed);
      return installed;
    } catch (error: unknown) {
      logger
        .withMetadata({ modId: mod.remoteId })
        .withError(error)
        .error("Config mod installation failed");

      options.onError(mod, toErrorKind(error));
      return null;
    }
  };

  const performInstallation = async (
    mod: LocalMod,
    options: InstallWithCollectionOptions,
    fileTree?: ModFileTree,
  ): Promise<InstallableMod | null> => {
    try {
      logger
        .withMetadata({
          modId: mod.remoteId,
          hasFileTree: !!fileTree,
          selectedFiles: fileTree?.files.filter((f) => f.is_selected).length,
        })
        .info("Performing installation");

      const activeProfile = getActiveProfile();
      const profileFolder = activeProfile?.folderName ?? null;

      // If file tree is provided and mod was downloaded with multiple files,
      // we need to copy selected VPKs from archive first
      if (fileTree?.has_multiple_files) {
        logger
          .withMetadata({
            modId: mod.remoteId,
            selectedFiles: fileTree.files.filter((f) => f.is_selected).length,
          })
          .info("Copying selected VPKs from archive");

        try {
          await invoke("copy_selected_vpks_from_archive", {
            modId: mod.remoteId,
            fileTree,
            profileFolder,
            isMap: mod.isMap,
          });
        } catch (error: unknown) {
          logger
            .withMetadata({ modId: mod.remoteId })
            .withError(error)
            .error("Failed to copy selected VPKs");
          // If copying fails, try to proceed anyway (maybe VPKs already exist)
          // This handles edge cases where archive was already processed
        }
      }

      const modData: LocalModWithFiles = {
        ...mod,
        file_tree: fileTree,
      };

      const result = (await invoke("install_mod", {
        deadlockMod: {
          id: modData.remoteId,
          name: modData.name,
          is_map: modData.isMap,
          file_tree: modData.file_tree,
        },
        profileFolder,
      })) as InstallableMod;

      options.onComplete(mod, result);
      return result;
    } catch (error: unknown) {
      logger
        .withMetadata({ modId: mod.remoteId })
        .withError(error)
        .error("Installation failed");

      options.onError(mod, toErrorKind(error));
      return null;
    }
  };

  const install: InstallWithCollectionFunction = async (
    mod,
    options,
    preselectedFileTree,
  ) => {
    try {
      options.onStart(mod);

      if (mod.status === ModStatus.Installed) {
        throw new Error("Mod is already installed!");
      }

      const configMod = await resolveConfigMod(mod).catch((error) => {
        logger
          .withMetadata({ modId: mod.remoteId })
          .withError(error)
          .warn("Failed to check whether the mod is a config mod");
        return null;
      });

      if (configMod) {
        if (!mod.configMod) {
          setConfigMod(mod.remoteId, configMod);
        }

        // A config bundled with VPKs is applied alongside them rather than instead of
        // them, so only a mod that ships nothing else skips the file-tree flow below.
        if (!hasVpks(mod)) {
          return await performConfigModInstallation(mod, options);
        }

        const activeProfile = getActiveProfile();
        await installConfigModForMod(mod, activeProfile?.folderName ?? null);
      }

      // If a preselected file tree was provided, use it directly
      if (preselectedFileTree) {
        logger
          .withMetadata({
            modId: mod.remoteId,
            selectedFiles: preselectedFileTree.files.filter(
              (f) => f.is_selected,
            ).length,
          })
          .info("Using preselected file tree");

        return await performInstallation(mod, options, preselectedFileTree);
      }

      // Check if file tree was stored during download
      if (mod.installedFileTree) {
        logger
          .withMetadata({
            modId: mod.remoteId,
            totalFiles: mod.installedFileTree.total_files,
            hasMultipleFiles: mod.installedFileTree.has_multiple_files,
            hasInstalledVpks: !!mod.installedVpks?.length,
          })
          .info("Using stored file tree from download");

        // Call onFileTreeAnalyzed callback if provided
        options.onFileTreeAnalyzed?.(mod, mod.installedFileTree);

        // If mod has multiple files, check if we already have a previous selection
        if (mod.installedFileTree.has_multiple_files) {
          // If mod already has installedVpks, it means user previously selected files
          // Use that selection instead of prompting again
          if (mod.installedVpks && mod.installedVpks.length > 0) {
            logger
              .withMetadata({
                modId: mod.remoteId,
                previouslyInstalledVpks: mod.installedVpks.length,
              })
              .info("Mod has previous VPK selection, using it for re-enable");

            // Create a new file tree with only previously selected files marked as selected
            const previouslySelectedFiles = new Set(
              mod.installedVpks.map((vpkPath) => {
                // Extract the original filename from the path
                const filename = vpkPath.split(/[\\/]/).pop() || "";
                // Remove the mod prefix if present (e.g., "modId_file.vpk" -> "file.vpk")
                return filename.replace(new RegExp(`^${mod.remoteId}_`), "");
              }),
            );

            const updatedFileTree: ModFileTree = {
              ...mod.installedFileTree,
              files: mod.installedFileTree.files.map((file) => ({
                ...file,
                is_selected: previouslySelectedFiles.has(file.name),
              })),
            };

            logger
              .withMetadata({
                modId: mod.remoteId,
                selectedFiles: updatedFileTree.files.filter(
                  (f) => f.is_selected,
                ).length,
                totalFiles: updatedFileTree.total_files,
              })
              .info("Using previous VPK selection for re-enable");

            return await performInstallation(mod, options, updatedFileTree);
          }

          // No previous selection - show file selector dialog
          logger
            .withMetadata({
              modId: mod.remoteId,
              totalFiles: mod.installedFileTree.total_files,
            })
            .info("Mod has multiple files, showing file selector dialog");

          // Store mod and options for dialog callbacks
          setCurrentMod(mod);
          setCurrentOptions(options);
          setCurrentFileTree(mod.installedFileTree);
          setShowFileSelector(true);
          setIsAnalyzing(false);

          // Return null - installation will proceed after user confirms selection
          return null;
        }

        // Single file - proceed with installation directly
        logger
          .withMetadata({
            modId: mod.remoteId,
            totalFiles: mod.installedFileTree.total_files,
          })
          .info(
            "Mod has single file or no files, proceeding with installation",
          );

        return await performInstallation(mod, options, mod.installedFileTree);
      }

      // Analyze file tree to check for multiple VPK files
      setIsAnalyzing(true);
      let fileTree: ModFileTree | null = null;

      try {
        // Construct mod directory path
        const base = await appLocalDataDir();
        const modsRoot = await join(base, "mods");
        const modDir = await join(modsRoot, mod.remoteId);

        logger
          .withMetadata({ modId: mod.remoteId, modPath: modDir })
          .info("Analyzing mod file tree");

        // Get file tree from backend
        fileTree = (await invoke("get_mod_file_tree", {
          modPath: modDir,
        })) as ModFileTree;

        logger
          .withMetadata({
            modId: mod.remoteId,
            totalFiles: fileTree.total_files,
            hasMultipleFiles: fileTree.has_multiple_files,
          })
          .info("File tree analysis complete");

        // Call onFileTreeAnalyzed callback if provided
        options.onFileTreeAnalyzed?.(mod, fileTree);

        // If mod has multiple files, show file selector dialog
        if (fileTree.has_multiple_files) {
          logger
            .withMetadata({
              modId: mod.remoteId,
              totalFiles: fileTree.total_files,
            })
            .info("Mod has multiple files, showing file selector dialog");

          // Store mod and options for dialog callbacks
          setCurrentMod(mod);
          setCurrentOptions(options);
          setCurrentFileTree(fileTree);
          setShowFileSelector(true);
          setIsAnalyzing(false);

          // Return null - installation will proceed after user confirms selection
          return null;
        }

        // Single file or no files - proceed with installation directly
        logger
          .withMetadata({
            modId: mod.remoteId,
            totalFiles: fileTree.total_files,
          })
          .info(
            "Mod has single file or no files, proceeding with installation",
          );

        setIsAnalyzing(false);
        return await performInstallation(mod, options, fileTree);
      } catch (error: unknown) {
        setIsAnalyzing(false);
        logger
          .withMetadata({ modId: mod.remoteId })
          .withError(error)
          .warn(
            "File tree analysis failed, proceeding with direct installation",
          );

        // If analysis fails, proceed with installation without file tree
        // This handles cases where mod directory doesn't exist or analysis fails
        return await performInstallation(mod, options);
      }
    } catch (error: unknown) {
      setIsAnalyzing(false);
      logger
        .withMetadata({ modId: mod.remoteId })
        .withError(error)
        .error("Installation process failed");

      options.onError(mod, toErrorKind(error));
      return null;
    }
  };

  const confirmInstallation = async (fileTree: ModFileTree): Promise<void> => {
    if (!currentMod) {
      logger.error("No current mod for installation confirmation");
      return;
    }

    if (!currentOptions) {
      logger.error("No current options for installation confirmation");
      return;
    }

    logger
      .withMetadata({
        modId: currentMod.remoteId,
        selectedFiles: fileTree.files.filter((f) => f.is_selected).length,
      })
      .info("User confirmed installation");

    setShowFileSelector(false);

    try {
      await performInstallation(currentMod, currentOptions, fileTree);
    } finally {
      // Clean up state
      setCurrentMod(null);
      setCurrentOptions(null);
      setCurrentFileTree(null);
    }
  };

  const cancelInstallation = (): void => {
    if (currentMod && currentOptions) {
      logger
        .withMetadata({ modId: currentMod.remoteId })
        .info("User canceled installation");

      // Call onCancel callback to revert mod status
      currentOptions.onCancel?.(currentMod);
    }

    setShowFileSelector(false);
    setCurrentMod(null);
    setCurrentOptions(null);
    setCurrentFileTree(null);
  };

  return {
    install,
    isAnalyzing,
    currentFileTree,
    showFileSelector,
    setShowFileSelector,
    confirmInstallation,
    cancelInstallation,
    currentMod,
    currentOptions,
  };
};

export default useInstallWithCollection;
