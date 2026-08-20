import type { ModDto } from "@deadlock-mods/shared";
import {
  type HeroDetectionResult,
  resolveDetectedHeroLabel,
} from "@deadlock-mods/hero-parser";
import { toast } from "@deadlock-mods/ui/components/sonner";
import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { BaseDirectory, readDir } from "@tauri-apps/plugin-fs";
import JSZip from "jszip";
import { useTranslation } from "react-i18next";
import { useProgress } from "@/components/downloads/progress-indicator";
import { ModCategory } from "@/lib/constants";
import {
  GAMEINFO_FILE_NAME,
  GAMEINFO_PATTERN,
  generateFallbackModSVG,
  IMAGE_PATTERN,
  VPK_PATTERN,
} from "@/lib/file-patterns";
import {
  type ModSource,
  ensureDirectory,
  getFileBaseName,
  fileToBytes,
  fileToDataUrl,
  writeFileBytes,
  writeFileText,
} from "@/lib/file-utils";
import logger from "@/lib/logger";
import { usePersistedStore } from "@/lib/store";
import { ModStatus, type ConfigModInfo, type ModFileTree } from "@/types/mods";
import { isTauriError } from "@/types/tauri";

interface PathBackedFile extends File {
  path?: string;
}

export interface ModMetadata {
  name: string;
  author?: string;
  link?: string;
  description?: string;
  imageFile?: File | null;
}

const getSourceFilePath = (file: File): string | null => {
  const filePath = (file as PathBackedFile).path;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : null;
};

const readSourceFileBytes = async (file: File): Promise<Uint8Array> => {
  const filePath = getSourceFilePath(file);
  if (!filePath) {
    return fileToBytes(file);
  }

  const bytes = await invoke<number[]>("read_dropped_mod_file", { filePath });
  return new Uint8Array(bytes);
};

export const useModProcessor = () => {
  const { t } = useTranslation();
  const { setProcessing } = useProgress();
  const {
    addLocalMod: addMod,
    setModStatus,
    setDetectedHero,
    getActiveProfile,
  } = usePersistedStore();

  const processArchive = async (
    file: File,
    filesDir: string,
    modDir: string,
  ): Promise<void> => {
    const fileBaseName = getFileBaseName(file);
    const fileName = fileBaseName.toLowerCase();
    const fileBytes = await readSourceFileBytes(file);

    if (fileName.endsWith(".zip")) {
      const zip = await JSZip.loadAsync(fileBytes);
      const vpkEntry = Object.values(zip.files).find(
        (f) => !f.dir && VPK_PATTERN.test(f.name),
      );

      if (vpkEntry) {
        const buffer = await vpkEntry.async("uint8array");
        const baseName = vpkEntry.name.split("/").pop() || "mod.vpk";
        await writeFileBytes(await join(filesDir, baseName), buffer);
        return;
      }

      // A config mod archive carries a gameinfo.gi instead of any VPK.
      const gameinfoEntry = Object.values(zip.files).find(
        (f) => !f.dir && GAMEINFO_PATTERN.test(f.name),
      );

      if (gameinfoEntry) {
        await writeFileBytes(
          await join(filesDir, GAMEINFO_FILE_NAME),
          await gameinfoEntry.async("uint8array"),
        );
        return;
      }

      await writeFileBytes(await join(modDir, fileBaseName), fileBytes);
      toast.error(t("addMods.noVpkFound"));
    } else if (fileName.endsWith(".rar") || fileName.endsWith(".7z")) {
      const format = fileName.split(".").pop()?.toUpperCase();

      setProcessing(true, t("addMods.storingArchive", { format }));
      await writeFileBytes(await join(modDir, fileBaseName), fileBytes);

      // Extract archive using backend
      try {
        setProcessing(true, t("addMods.extractingArchive", { format }));
        const archivePath = await join(modDir, fileBaseName);
        await invoke("extract_archive", {
          archivePath: await archivePath,
          targetPath: await filesDir,
        });
        toast.success(t("addMods.archiveExtractedSuccess", { format }));
      } catch {
        toast.error(t("addMods.failedToExtractArchive"));
      }
    } else {
      await writeFileBytes(await join(modDir, fileBaseName), fileBytes);
    }
  };

  const processPreviewImage = async (
    metadata: ModMetadata,
    modDir: string,
  ): Promise<{ previewName: string; imageDataUrl: string }> => {
    let previewName = "preview.svg";
    let imageDataUrl: string;

    if (metadata.imageFile) {
      const extMatch = metadata.imageFile.name.match(IMAGE_PATTERN);
      previewName = `preview${extMatch ? extMatch[0].toLowerCase() : ".png"}`;

      await writeFileBytes(
        await join(modDir, previewName),
        await fileToBytes(metadata.imageFile),
      );

      imageDataUrl = await fileToDataUrl(metadata.imageFile);
    } else {
      const fallbackSVG = generateFallbackModSVG();
      await writeFileText(await join(modDir, previewName), fallbackSVG);
      imageDataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(fallbackSVG)}`;
    }

    return { previewName, imageDataUrl };
  };

  const validateFiles = async (
    filesDir: string,
    detectedSource: ModSource,
  ): Promise<boolean> => {
    const filesList = await readDir(filesDir, {
      baseDir: BaseDirectory.AppLocalData,
    });
    const hasVpk = filesList.some((entry) =>
      VPK_PATTERN.test(entry.name || ""),
    );

    if (hasVpk) {
      return true;
    }

    if (detectedSource.kind === "archive") {
      const fileName = getFileBaseName(detectedSource.file).toLowerCase();
      if (fileName.endsWith(".rar") || fileName.endsWith(".7z")) {
        toast.info(t("addMods.archiveWillBeProcessed"));
        return true;
      }

      toast.warning(t("addMods.noVpkFoundStored"));
      return true;
    }

    toast.error(t("addMods.noVpkFoundInContent"));
    return false;
  };

  const processMod = async (
    metadata: ModMetadata,
    category: ModCategory,
    detectedSource: ModSource,
  ): Promise<void> => {
    setProcessing(true, t("addMods.validatingMetadata"));

    const modId = `local-${crypto.randomUUID()}`;
    const base = await appLocalDataDir();
    const modsRoot = await join(base, "mods");
    const modDir = await join(modsRoot, modId);
    const filesDir = await join(modDir, "files");

    setProcessing(true, t("addMods.creatingDirectories"));
    await ensureDirectory(modsRoot);
    await ensureDirectory(modDir);
    await ensureDirectory(filesDir);

    setProcessing(true, t("addMods.processingPreview"));
    const { previewName, imageDataUrl } = await processPreviewImage(
      metadata,
      modDir,
    );

    setProcessing(true, t("addMods.processingFiles"));
    if (detectedSource.kind === "vpkPath") {
      await invoke("place_forge_payload", {
        path: detectedSource.path,
        destination: await join(filesDir, detectedSource.fileName),
      });
    } else {
      try {
        if (detectedSource.kind === "vpk") {
          const fileName = getFileBaseName(detectedSource.file);
          await writeFileBytes(
            await join(filesDir, fileName),
            await readSourceFileBytes(detectedSource.file),
          );
        } else if (detectedSource.kind === "config") {
          await writeFileBytes(
            await join(filesDir, GAMEINFO_FILE_NAME),
            await readSourceFileBytes(detectedSource.file),
          );
        } else {
          await processArchive(detectedSource.file, filesDir, modDir);
        }
      } catch {
        const fileName = getFileBaseName(detectedSource.file);
        toast.error(t("addMods.failedToProcessArchive"));
        await writeFileBytes(
          await join(modDir, fileName),
          await readSourceFileBytes(detectedSource.file),
        );
      }
    }

    setProcessing(true, t("addMods.validatingFiles"));

    // A config mod ships a gameinfo.gi rather than VPKs, so it is detected before
    // the VPK validation that would otherwise reject it.
    const configMod = await invoke<ConfigModInfo | null>(
      "scan_and_stash_local_mod_config",
      { modId, filesDir },
    ).catch((error) => {
      logger
        .withMetadata({ filesDir, modId })
        .withError(error)
        .warn("Failed to scan local mod for a bundled game config");
      return null;
    });

    if (!configMod) {
      const isValid = await validateFiles(filesDir, detectedSource);
      if (!isValid) {
        setProcessing(false);
        return;
      }
    }

    setProcessing(true, t("addMods.processingFiles"));
    let fileTree: ModFileTree | null = null;
    let hasVpkFiles = false;

    // An author who bundles VPKs with a config means the two to work together, so
    // the copy is attempted whether or not a config was found, rather than instead
    // of it.
    try {
      const activeProfile = getActiveProfile();
      const profileFolder = activeProfile?.folderName ?? null;

      await invoke("copy_local_mod_vpks", {
        modId: modId,
        profileFolder,
        isMap: category === ModCategory.MAPS,
      });
      hasVpkFiles = true;

      // Scan the extracted files dir for fonts and emit the same event as the
      // download pipeline so the FontInstallDialog appears if any are found.
      await invoke("scan_and_stash_local_mod_fonts", {
        modId,
        filesDir,
      }).catch((error) => {
        logger
          .withMetadata({ filesDir, modId })
          .withError(error)
          .warn("Failed to scan local mod for bundled fonts");
      });

      try {
        fileTree = (await invoke("get_mod_file_tree", {
          modPath: modDir,
        })) as ModFileTree;
      } catch {}
    } catch (error) {
      // `copy_local_mod_vpks` rejects a mod with nothing to copy, and that is the
      // only thing it raises `invalidInput` for. Expected of a mod whose config is
      // all it ships; a real failure for anything else.
      const nothingToCopy =
        isTauriError(error) && error.kind === "invalidInput";

      if (!configMod || !nothingToCopy) {
        setProcessing(false);
        toast.error((error as Error)?.message || "Unknown error");
        return;
      }

      logger
        .withMetadata({ modId })
        .info("Local config mod ships no VPKs of its own");
    }

    setProcessing(true, t("addMods.savingMetadata"));
    const modMetadata = {
      id: modId,
      kind: "local",
      name: metadata.name,
      author: metadata.author || "Unknown",
      link: metadata.link || null,
      description: metadata.description || null,
      category,
      createdAt: new Date().toISOString(),
      preview: previewName,
      _schema: 1,
    };

    await writeFileText(
      await join(modDir, "metadata.json"),
      JSON.stringify(modMetadata, null, 2),
    );

    setProcessing(true, t("addMods.addingToLibrary"));
    const modDto: ModDto = {
      id: modId,
      remoteId: modId,
      name: modMetadata.name,
      description: modMetadata.description ?? "",
      remoteUrl: modMetadata.link ?? "local://manual",
      author: modMetadata.author,
      downloadable: false,
      remoteAddedAt: new Date(modMetadata.createdAt),
      remoteUpdatedAt: new Date(modMetadata.createdAt),
      tags: [],
      images: [imageDataUrl],
      hero: null,
      isAudio: false,
      isMap: category === ModCategory.MAPS,
      audioUrl: null,
      isNSFW: false,
      createdAt: new Date(modMetadata.createdAt),
      updatedAt: new Date(modMetadata.createdAt),
      downloadCount: 0,
      likes: 0,
      isBlacklisted: false,
      blacklistReason: null,
      blacklistedAt: null,
      blacklistedBy: null,
      isObsolete: false,
      category,
      filesUpdatedAt: null,
      metadata: null,
      overrides: null,
      dependencies: null,
    };

    addMod(modDto, {
      status: ModStatus.Downloaded,
      installedFileTree: fileTree ?? undefined,
      configMod: configMod ?? undefined,
    });
    setModStatus(modId, ModStatus.Downloaded);

    // Hero detection reads the mod's VPKs, which a config-only mod does not have.
    if (hasVpkFiles) {
      invoke<HeroDetectionResult>("detect_mod_hero", { modId })
        .then((result) =>
          setDetectedHero(
            modId,
            resolveDetectedHeroLabel(result),
            result.usesCriticalPaths,
          ),
        )
        .catch(() => setDetectedHero(modId, null));
    }

    setProcessing(true, t("addMods.modAddedSuccess"));
    toast.success(t("addMods.addedSuccess", { name: metadata.name }));
    setProcessing(false);
  };

  const processLocalAddon = async (
    metadata: ModMetadata,
    category: ModCategory,
    existingPath: string,
  ): Promise<void> => {
    setProcessing(true, t("addMods.validatingMetadata"));

    const modId = `local-${crypto.randomUUID()}`;
    const base = await appLocalDataDir();
    const modsRoot = await join(base, "mods");
    const modDir = await join(modsRoot, modId);

    setProcessing(true, t("addMods.creatingDirectories"));
    await ensureDirectory(modsRoot);
    await ensureDirectory(modDir);

    setProcessing(true, t("addMods.processingPreview"));
    const { previewName, imageDataUrl } = await processPreviewImage(
      metadata,
      modDir,
    );

    setProcessing(true, t("addMods.savingMetadata"));
    const modMetadata = {
      id: modId,
      kind: "local",
      name: metadata.name,
      author: metadata.author || "Unknown",
      link: metadata.link || null,
      description: metadata.description || null,
      category,
      createdAt: new Date().toISOString(),
      preview: previewName,
      _schema: 1,
    };

    await writeFileText(
      await join(modDir, "metadata.json"),
      JSON.stringify(modMetadata, null, 2),
    );

    setProcessing(true, t("addMods.addingToLibrary"));
    const modDto: ModDto = {
      id: modId,
      remoteId: modId,
      name: modMetadata.name,
      description: modMetadata.description ?? "",
      remoteUrl: modMetadata.link ?? "local://manual",
      author: modMetadata.author,
      downloadable: false,
      remoteAddedAt: new Date(modMetadata.createdAt),
      remoteUpdatedAt: new Date(modMetadata.createdAt),
      tags: [],
      images: [imageDataUrl],
      hero: null,
      isAudio: false,
      isMap: category === ModCategory.MAPS,
      audioUrl: null,
      isNSFW: false,
      createdAt: new Date(modMetadata.createdAt),
      updatedAt: new Date(modMetadata.createdAt),
      downloadCount: 0,
      likes: 0,
      isBlacklisted: false,
      blacklistReason: null,
      isObsolete: false,
      blacklistedAt: null,
      blacklistedBy: null,
      category,
      filesUpdatedAt: null,
      metadata: null,
      overrides: null,
      dependencies: null,
    };

    const vpkFileName = existingPath.split(/[\\/]/).pop() || existingPath;
    addMod(modDto, {
      status: ModStatus.Installed,
      installedVpks: [vpkFileName],
      installedFileTree: {
        files: [
          {
            name: vpkFileName,
            path: vpkFileName,
            size: 0,
            is_selected: true,
            archive_name: "",
          },
        ],
        total_files: 1,
        has_multiple_files: false,
      },
    });
    setModStatus(modId, ModStatus.Installed);

    invoke<HeroDetectionResult>("detect_mod_hero", { modId })
      .then((result) =>
        setDetectedHero(
          modId,
          resolveDetectedHeroLabel(result),
          result.usesCriticalPaths,
        ),
      )
      .catch(() => setDetectedHero(modId, null));

    setProcessing(true, t("addMods.modAddedSuccess"));
    toast.success(t("addMods.addedSuccess", { name: metadata.name }));
    setProcessing(false);
  };

  return { processMod, processLocalAddon };
};
