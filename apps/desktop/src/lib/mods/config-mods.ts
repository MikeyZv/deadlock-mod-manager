import { invoke } from "@tauri-apps/api/core";
import type {
  ConfigModInfo,
  ConfigModInstallResult,
  ConfigModVariant,
  LocalMod,
} from "@/types/mods";

/**
 * Whether the mod ships a `gameinfo.gi`, which is installed and removed through its
 * own commands. Most such mods ship nothing else, but an author can bundle one
 * alongside VPKs meant to work with it, so this does not on its own decide how the
 * mod installs — see {@link isConfigOnlyMod}.
 */
export const isConfigMod = (mod: Pick<LocalMod, "configMod">): boolean =>
  Boolean(mod.configMod);

/**
 * Whether the mod has VPKs to enable. Known before installing because the download
 * emits a file tree for every archive that contained any.
 */
export const hasVpks = (
  mod: Pick<LocalMod, "installedVpks" | "installedFileTree">,
): boolean =>
  (mod.installedVpks?.length ?? 0) > 0 ||
  (mod.installedFileTree?.total_files ?? 0) > 0;

/**
 * Whether the game config is all the mod installs. Only these take the config path
 * exclusively: a mod shipping both applies its config *and* enables its VPKs, since
 * an author who bundles the two means them to work together.
 */
export const isConfigOnlyMod = (
  mod: Pick<LocalMod, "configMod" | "installedVpks" | "installedFileTree">,
): boolean => isConfigMod(mod) && !hasVpks(mod);

/**
 * Every stashed version, tolerating persisted state written before versions
 * existed. `configMod` is saved to disk, so state from an older build reaches
 * these readers; a shape mismatch must degrade to "no versions" rather than throw
 * during render and take the whole library down with it.
 */
export const configVariants = (
  config: ConfigModInfo | undefined,
): ConfigModVariant[] =>
  Array.isArray(config?.variants) ? config.variants : [];

export const findConfigVariant = (
  config: ConfigModInfo | undefined,
  archiveName: string,
): ConfigModVariant | undefined =>
  configVariants(config).find((variant) => variant.archiveName === archiveName);

/**
 * Name a stash falls back to when the archive it came from is unknown: a config added
 * from a loose file, or one stashed by a build that recorded no archive names.
 */
export const UNNAMED_CONFIG_VARIANT = "gameinfo.gi";

export const isUnnamedConfigVariant = (archiveName: string): boolean =>
  archiveName === UNNAMED_CONFIG_VARIANT;

export interface ResolvedConfigVariants {
  config: ConfigModInfo | undefined;
  /** Maps a name shown to the user back to the name the version is stashed under. */
  toStashName: (displayName: string) => string;
}

/**
 * Recover the creator's own file name for a version stashed without one.
 *
 * A version stashed before archive names were recorded is only identifiable as
 * `gameinfo.gi`, which tells the user nothing and matches none of the author's
 * published files. When the mod has exactly one downloaded file there is only one
 * archive it can have come from, so it is safe to show it under that name — and the
 * returned `toStashName` translates the user's pick back for the backend, which still
 * knows the version by its stashed name.
 *
 * Any other combination stays genuinely ambiguous and is left alone.
 */
export const resolveConfigVariantNames = (
  config: ConfigModInfo | undefined,
  downloadedFiles: ReadonlyArray<{ name: string }>,
): ResolvedConfigVariants => {
  const unchanged: ResolvedConfigVariants = {
    config,
    toStashName: (displayName) => displayName,
  };

  if (!config) {
    return unchanged;
  }

  const variants = configVariants(config);
  const unnamedCount = variants.filter((variant) =>
    isUnnamedConfigVariant(variant.archiveName),
  ).length;

  if (unnamedCount !== 1 || downloadedFiles.length !== 1) {
    return unchanged;
  }

  const creatorName = downloadedFiles[0].name;
  // Renaming onto a name another version already holds would merge two distinct
  // versions into one row.
  if (variants.some((variant) => variant.archiveName === creatorName)) {
    return unchanged;
  }

  return {
    config: {
      // Rebuilt rather than mutated: these objects are the persisted store's.
      variants: variants.map((variant) =>
        isUnnamedConfigVariant(variant.archiveName)
          ? {
              archiveName: creatorName,
              size: variant.size,
              isValid: variant.isValid,
              invalidReason: variant.invalidReason,
            }
          : variant,
      ),
      activeVariant:
        config.activeVariant && isUnnamedConfigVariant(config.activeVariant)
          ? creatorName
          : config.activeVariant,
    },
    toStashName: (displayName) =>
      displayName === creatorName ? UNNAMED_CONFIG_VARIANT : displayName,
  };
};

export const installConfigMod = (
  mod: Pick<LocalMod, "remoteId" | "name">,
  profileFolder: string | null,
  variant?: string | null,
): Promise<ConfigModInstallResult> =>
  invoke<ConfigModInstallResult>("install_config_mod", {
    modId: mod.remoteId,
    modName: mod.name,
    variant: variant ?? null,
    profileFolder,
  });

export const uninstallConfigMod = (
  modId: string,
  profileFolder: string | null,
): Promise<void> => invoke("uninstall_config_mod", { modId, profileFolder });

/** Download one of the mod's other archives and stash its config as a version. */
export const stageConfigModVariant = (
  modId: string,
  archiveUrl: string,
  archiveName: string,
): Promise<ConfigModInfo> =>
  invoke<ConfigModInfo>("stage_config_mod_variant", {
    modId,
    archiveUrl,
    archiveName,
  });

/** The stashed versions as they are on disk right now, ignoring the store's copy. */
export const getModConfigInfo = (
  modId: string,
): Promise<ConfigModInfo | null> =>
  invoke<ConfigModInfo | null>("get_mod_config_info", { modId });

/**
 * Re-read the stashed versions straight from disk when the store has none. Without
 * this a mod whose `config-mod-found` event never reached the store would fail to
 * install with a misleading "no VPK files" error.
 *
 * Mods that already have VPKs are probed too. Skipping them would be cheaper, but an
 * archive can carry a config alongside its addons and that config would then never
 * be found for a mod added by 1-click, which builds its mod from the API DTO.
 */
export const resolveConfigMod = async (
  mod: Pick<LocalMod, "remoteId" | "configMod">,
): Promise<ConfigModInfo | null> => {
  if (mod.configMod) {
    return mod.configMod;
  }

  return invoke<ConfigModInfo | null>("get_mod_config_info", {
    modId: mod.remoteId,
  });
};
