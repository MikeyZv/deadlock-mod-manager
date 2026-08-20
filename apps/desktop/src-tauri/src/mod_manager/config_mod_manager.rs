use crate::errors::Error;
use crate::mod_manager::game_config_manager::GameConfigManager;
use log;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The only configuration file a config mod is allowed to ship.
pub const GAMEINFO_FILE_NAME: &str = "gameinfo.gi";

/// Folder inside a mod's cache directory where its `gameinfo.gi` variants live.
pub const CONFIG_STASH_DIR_NAME: &str = "config";

/// Index of the stashed variants, written next to their folders. Creators publish
/// several archives for one mod (low spec, high spec, ...), and each carries its own
/// `gameinfo.gi`; the index is what maps a folder back to the archive it came from.
const VARIANTS_INDEX_FILE_NAME: &str = "variants.json";

/// Copy of the game's `gameinfo.gi` taken before the first config mod is applied,
/// kept next to the real file so it is found again after an app restart.
const CONFIG_BACKUP_FILE_NAME: &str = "gameinfo.gi.config-backup";

/// Which config mod is currently written into the game.
const STATE_FILE_NAME: &str = "config-mod-state.json";

/// Archives often ship the config next to a readme in a nested folder, so the scan
/// walks the whole tree. Depth is bounded so a pathological archive cannot turn the
/// scan into a long walk.
const MAX_SCAN_DEPTH: usize = 8;

/// Keeps a slugged folder name short enough for every filesystem involved.
const MAX_SLUG_LENGTH: usize = 64;

/// One downloaded archive's `gameinfo.gi`. Invalid variants are kept rather than
/// dropped so the UI can show why a downloaded file cannot be used.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigModVariant {
  /// File name of the archive this came from, as offered by the mod's author.
  pub archive_name: String,
  pub size: u64,
  pub is_valid: bool,
  #[serde(default)]
  pub invalid_reason: Option<String>,
}

/// Every stashed variant of a config mod, plus which one is written into the game.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigModInfo {
  pub variants: Vec<ConfigModVariant>,
  #[serde(default)]
  pub active_variant: Option<String>,
}

/// A variant as stored on disk. `slug` is the folder holding its `gameinfo.gi`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredVariant {
  slug: String,
  archive_name: String,
  size: u64,
  is_valid: bool,
  #[serde(default)]
  invalid_reason: Option<String>,
}

/// The config mod currently applied to the game. At most one can be active,
/// because they all replace the same file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveConfigMod {
  pub mod_id: String,
  pub mod_name: String,
  pub applied_at: u64,
  /// Archive name of the applied variant.
  #[serde(default)]
  pub variant: Option<String>,
}

/// Outcome of applying a config mod, including the mod it displaced (if any) so the
/// frontend can flip that mod back to a disabled state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigModInstallResult {
  pub active: ActiveConfigMod,
  pub replaced_mod_id: Option<String>,
  pub config: ConfigModInfo,
}

/// What scanning one archive turned up, before it is known whether the mod is a
/// config mod at all.
#[derive(Debug, Clone)]
pub struct ScannedArchive {
  pub archive_name: String,
  /// `None` when the archive holds no `gameinfo.gi`.
  pub gameinfo_path: Option<PathBuf>,
  pub invalid_reason: Option<String>,
}

impl ScannedArchive {
  pub fn has_gameinfo(&self) -> bool {
    self.gameinfo_path.is_some()
  }
}

/// Stashes and tracks configuration-only mods (a modified `gameinfo.gi`).
///
/// Writing the file into the game is coordinated by `ModManager`, which owns the
/// `GameConfigManager` that re-patches the mod manager's search paths afterwards.
pub struct ConfigModManager {
  game_config: GameConfigManager,
}

impl ConfigModManager {
  pub fn new() -> Self {
    Self {
      game_config: GameConfigManager::new(),
    }
  }

  pub fn gameinfo_path(game_path: &Path) -> PathBuf {
    game_path
      .join("game")
      .join("citadel")
      .join(GAMEINFO_FILE_NAME)
  }

  pub fn config_backup_path(game_path: &Path) -> PathBuf {
    game_path
      .join("game")
      .join("citadel")
      .join(CONFIG_BACKUP_FILE_NAME)
  }

  pub fn stash_dir(mod_dir: &Path) -> PathBuf {
    mod_dir.join(CONFIG_STASH_DIR_NAME)
  }

  fn index_path(stash_dir: &Path) -> PathBuf {
    stash_dir.join(VARIANTS_INDEX_FILE_NAME)
  }

  fn state_path(app_local_data: &Path) -> PathBuf {
    app_local_data.join(STATE_FILE_NAME)
  }

  pub fn current_timestamp() -> u64 {
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap_or_default()
      .as_secs()
  }

  /// Folder name for a variant. Archive names come from remote metadata, so the
  /// result is restricted to characters that cannot escape the stash directory.
  fn slugify(archive_name: &str) -> String {
    let slug: String = archive_name
      .chars()
      .map(|c| {
        if c.is_ascii_alphanumeric() {
          c.to_ascii_lowercase()
        } else {
          '-'
        }
      })
      .collect();

    let slug = slug.trim_matches('-').to_string();
    let slug: String = slug.chars().take(MAX_SLUG_LENGTH).collect();
    let slug = slug.trim_matches('-').to_string();

    if slug.is_empty() {
      "variant".to_string()
    } else {
      slug
    }
  }

  /// A slug not already claimed by a different archive in `existing`.
  fn unique_slug(archive_name: &str, existing: &[StoredVariant]) -> String {
    let base = Self::slugify(archive_name);
    let taken = |candidate: &str| {
      existing
        .iter()
        .any(|variant| variant.slug == candidate && variant.archive_name != archive_name)
    };

    if !taken(&base) {
      return base;
    }

    let mut counter = 2usize;
    loop {
      let candidate = format!("{base}-{counter}");
      if !taken(&candidate) {
        return candidate;
      }
      counter += 1;
    }
  }

  /// Find the `gameinfo.gi` inside an extracted archive, breadth-first so the
  /// shallowest one wins when an archive ships several variants in subfolders.
  pub fn scan_for_gameinfo(&self, extracted_dir: &Path) -> Option<PathBuf> {
    let mut queue = VecDeque::from([(extracted_dir.to_path_buf(), 0usize)]);

    while let Some((dir, depth)) = queue.pop_front() {
      let Ok(entries) = fs::read_dir(&dir) else {
        continue;
      };

      let mut subdirectories = Vec::new();
      for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
          if depth < MAX_SCAN_DEPTH {
            subdirectories.push(path);
          }
          continue;
        }

        if path
          .file_name()
          .and_then(|name| name.to_str())
          .is_some_and(|name| name.eq_ignore_ascii_case(GAMEINFO_FILE_NAME))
        {
          log::info!("Found config mod gameinfo.gi at {path:?}");
          return Some(path);
        }
      }

      // Sorted so an arbitrary directory listing order cannot change which sibling
      // folder's config gets picked between runs.
      subdirectories.sort();
      for subdirectory in subdirectories {
        queue.push_back((subdirectory, depth + 1));
      }
    }

    None
  }

  /// Look through one extracted archive and judge whether its `gameinfo.gi` is
  /// usable. A rejected file is still reported, so the UI can explain the refusal
  /// rather than silently omitting a version the user downloaded.
  pub fn scan_archive(&self, extracted_dir: &Path, archive_name: &str) -> ScannedArchive {
    let Some(gameinfo_path) = self.scan_for_gameinfo(extracted_dir) else {
      return ScannedArchive {
        archive_name: archive_name.to_string(),
        gameinfo_path: None,
        invalid_reason: None,
      };
    };

    let invalid_reason = match self.game_config.validate_gameinfo_syntax(&gameinfo_path) {
      Ok(validation) if validation.is_valid => None,
      Ok(validation) => Some(validation.errors.join(", ")),
      Err(error) => Some(error.to_string()),
    };

    if let Some(reason) = invalid_reason.as_ref() {
      log::warn!("Archive {archive_name} has an unusable gameinfo.gi: {reason}");
    }

    ScannedArchive {
      archive_name: archive_name.to_string(),
      gameinfo_path: Some(gameinfo_path),
      invalid_reason,
    }
  }

  /// Persist one archive's scan result as a variant, replacing any earlier stash for
  /// the same archive. An archive with no `gameinfo.gi` is recorded as unusable.
  pub fn stash_variant(
    &self,
    stash_dir: &Path,
    scanned: &ScannedArchive,
  ) -> Result<ConfigModInfo, Error> {
    fs::create_dir_all(stash_dir)?;

    let mut stored = Self::load_index(stash_dir);
    let slug = Self::unique_slug(&scanned.archive_name, &stored);
    let variant_dir = stash_dir.join(&slug);

    if variant_dir.exists() {
      fs::remove_dir_all(&variant_dir)?;
    }

    let (size, is_valid, invalid_reason) = match scanned.gameinfo_path.as_ref() {
      Some(source) if scanned.invalid_reason.is_none() => {
        fs::create_dir_all(&variant_dir)?;
        let destination = variant_dir.join(GAMEINFO_FILE_NAME);
        fs::copy(source, &destination)?;
        let size = fs::metadata(&destination)?.len();
        log::info!(
          "Stashed config variant {} ({size} bytes) at {destination:?}",
          scanned.archive_name
        );
        (size, true, None)
      }
      // Unusable files are not copied: only the record of them is worth keeping.
      Some(source) => (
        fs::metadata(source).map(|meta| meta.len()).unwrap_or(0),
        false,
        scanned.invalid_reason.clone(),
      ),
      None => (0, false, None),
    };

    stored.retain(|variant| variant.archive_name != scanned.archive_name);
    stored.push(StoredVariant {
      slug,
      archive_name: scanned.archive_name.clone(),
      size,
      is_valid,
      invalid_reason,
    });

    Self::save_index(stash_dir, &stored)?;
    Ok(Self::info_from_stored(stored, None))
  }

  /// Record archives that shipped no `gameinfo.gi` at all. Only called once at least
  /// one sibling archive proved the mod is a config mod, so a plain VPK mod is never
  /// mistaken for a config mod with broken variants.
  pub fn stash_missing_variants(
    &self,
    stash_dir: &Path,
    scanned: &[ScannedArchive],
  ) -> Result<(), Error> {
    for archive in scanned.iter().filter(|archive| !archive.has_gameinfo()) {
      self.stash_variant(stash_dir, archive)?;
    }

    Ok(())
  }

  fn load_index(stash_dir: &Path) -> Vec<StoredVariant> {
    let path = Self::index_path(stash_dir);
    let Ok(contents) = fs::read_to_string(&path) else {
      return Self::recover_legacy_index(stash_dir);
    };

    match serde_json::from_str::<Vec<StoredVariant>>(&contents) {
      Ok(stored) => stored,
      Err(error) => {
        log::warn!("Ignoring unreadable config variant index at {path:?}: {error}");
        Vec::new()
      }
    }
  }

  /// Earlier builds stashed a single `gameinfo.gi` directly in the stash folder with
  /// no index. Adopt it as one unnamed variant rather than losing it.
  fn recover_legacy_index(stash_dir: &Path) -> Vec<StoredVariant> {
    let legacy = stash_dir.join(GAMEINFO_FILE_NAME);
    if !legacy.is_file() {
      return Vec::new();
    }

    log::info!("Adopting legacy config stash at {legacy:?} as a single variant");
    vec![StoredVariant {
      slug: String::new(),
      archive_name: GAMEINFO_FILE_NAME.to_string(),
      size: fs::metadata(&legacy).map(|meta| meta.len()).unwrap_or(0),
      is_valid: true,
      invalid_reason: None,
    }]
  }

  fn save_index(stash_dir: &Path, stored: &[StoredVariant]) -> Result<(), Error> {
    let contents = serde_json::to_string_pretty(stored)
      .map_err(|error| Error::FileWriteFailed(error.to_string()))?;
    fs::write(Self::index_path(stash_dir), contents)?;

    Ok(())
  }

  fn info_from_stored(stored: Vec<StoredVariant>, active_variant: Option<String>) -> ConfigModInfo {
    ConfigModInfo {
      variants: stored
        .into_iter()
        .map(|variant| ConfigModVariant {
          archive_name: variant.archive_name,
          size: variant.size,
          is_valid: variant.is_valid,
          invalid_reason: variant.invalid_reason,
        })
        .collect(),
      active_variant,
    }
  }

  /// Attribute the applied config to a version when the record does not name one.
  ///
  /// State written before a mod could ship several versions has no variant field, so
  /// a config mod installed by such a build reads back as "applied, version unknown"
  /// and nothing in the picker looks enabled. One stashed version is unambiguous.
  pub fn infer_active_variant(config: &mut ConfigModInfo, mod_is_active: bool) {
    if config.active_variant.is_some() || !mod_is_active {
      return;
    }

    if let [only] = config.variants.as_slice() {
      log::info!(
        "Attributing the applied config to the only stashed version: {}",
        only.archive_name
      );
      config.active_variant = Some(only.archive_name.clone());
    }
  }

  /// Everything stashed for a mod, or `None` when the mod is not a config mod.
  pub fn config_info(stash_dir: &Path, active_variant: Option<String>) -> Option<ConfigModInfo> {
    let stored = Self::load_index(stash_dir);
    if stored.is_empty() {
      return None;
    }

    Some(Self::info_from_stored(stored, active_variant))
  }

  /// Path to a variant's stashed `gameinfo.gi`. `archive_name` of `None` resolves to
  /// `preferred` when it is still valid, else the first valid variant.
  pub fn resolve_variant(
    stash_dir: &Path,
    archive_name: Option<&str>,
    preferred: Option<&str>,
  ) -> Result<(String, PathBuf), Error> {
    let stored = Self::load_index(stash_dir);

    let chosen = match archive_name {
      Some(name) => {
        let variant = stored
          .iter()
          .find(|variant| variant.archive_name == name)
          .ok_or_else(|| {
            Error::ModInvalid(format!("This mod has no downloaded version named {name}"))
          })?;

        if !variant.is_valid {
          return Err(Error::ModInvalid(match variant.invalid_reason.as_ref() {
            Some(reason) => format!("{name} does not contain a usable gameinfo.gi: {reason}"),
            None => format!("{name} does not contain a gameinfo.gi"),
          }));
        }

        variant
      }
      None => preferred
        .and_then(|name| {
          stored
            .iter()
            .find(|variant| variant.is_valid && variant.archive_name == name)
        })
        .or_else(|| stored.iter().find(|variant| variant.is_valid))
        .ok_or_else(|| {
          Error::ModInvalid(
            "None of this mod's downloaded files contain a usable gameinfo.gi".to_string(),
          )
        })?,
    };

    // A legacy stash has no folder of its own; its file sits at the stash root.
    let path = if chosen.slug.is_empty() {
      stash_dir.join(GAMEINFO_FILE_NAME)
    } else {
      stash_dir.join(&chosen.slug).join(GAMEINFO_FILE_NAME)
    };

    if !path.is_file() {
      return Err(Error::ModInvalid(format!(
        "The stashed gameinfo.gi for {} is missing; re-download this version",
        chosen.archive_name
      )));
    }

    Ok((chosen.archive_name.clone(), path))
  }

  pub fn discard_stash(&self, stash_dir: &Path) -> Result<(), Error> {
    if stash_dir.exists() {
      log::info!("Discarding config mod stash: {stash_dir:?}");
      fs::remove_dir_all(stash_dir)?;
    }

    Ok(())
  }

  pub fn load_state(app_local_data: &Path) -> Option<ActiveConfigMod> {
    let path = Self::state_path(app_local_data);
    let contents = fs::read_to_string(&path).ok()?;

    match serde_json::from_str::<ActiveConfigMod>(&contents) {
      Ok(state) => Some(state),
      Err(error) => {
        log::warn!("Ignoring unreadable config mod state at {path:?}: {error}");
        None
      }
    }
  }

  pub fn save_state(app_local_data: &Path, state: &ActiveConfigMod) -> Result<(), Error> {
    fs::create_dir_all(app_local_data)?;
    let path = Self::state_path(app_local_data);
    let contents = serde_json::to_string_pretty(state)
      .map_err(|error| Error::FileWriteFailed(error.to_string()))?;
    fs::write(&path, contents)?;

    Ok(())
  }

  pub fn clear_state(app_local_data: &Path) -> Result<(), Error> {
    let path = Self::state_path(app_local_data);
    if path.exists() {
      fs::remove_file(&path)?;
    }

    Ok(())
  }
}

impl Default for ConfigModManager {
  fn default() -> Self {
    Self::new()
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::TempDir;

  const VALID_GAMEINFO: &str = r#""GameInfo"
{
  FileSystem
  {
    SearchPaths
    {
      Game    citadel
    }
  }
}"#;

  fn write_file(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
      fs::create_dir_all(parent).expect("parent directory should be created");
    }
    fs::write(path, contents).expect("file should be written");
  }

  /// An extracted archive directory containing the given gameinfo.gi body.
  fn extracted_with(dir: &Path, name: &str, contents: &str) -> PathBuf {
    let extracted = dir.join(format!("extracted-{name}"));
    write_file(&extracted.join(GAMEINFO_FILE_NAME), contents);
    extracted
  }

  #[test]
  fn scan_finds_gameinfo_at_the_archive_root() {
    let dir = TempDir::new().expect("temp dir");
    write_file(&dir.path().join("gameinfo.gi"), VALID_GAMEINFO);

    let found = ConfigModManager::new()
      .scan_for_gameinfo(dir.path())
      .expect("gameinfo should be found");

    assert_eq!(found, dir.path().join("gameinfo.gi"));
  }

  #[test]
  fn scan_finds_gameinfo_in_a_nested_folder() {
    let dir = TempDir::new().expect("temp dir");
    let nested = dir.path().join("My Config").join("citadel");
    write_file(&nested.join("gameinfo.gi"), VALID_GAMEINFO);

    let found = ConfigModManager::new()
      .scan_for_gameinfo(dir.path())
      .expect("gameinfo should be found");

    assert_eq!(found, nested.join("gameinfo.gi"));
  }

  #[test]
  fn scan_prefers_the_shallowest_gameinfo() {
    let dir = TempDir::new().expect("temp dir");
    write_file(&dir.path().join("gameinfo.gi"), "root");
    write_file(&dir.path().join("alt").join("gameinfo.gi"), "nested");

    let found = ConfigModManager::new()
      .scan_for_gameinfo(dir.path())
      .expect("gameinfo should be found");

    assert_eq!(fs::read_to_string(found).expect("readable"), "root");
  }

  #[test]
  fn scan_matches_case_insensitively() {
    let dir = TempDir::new().expect("temp dir");
    write_file(&dir.path().join("GameInfo.GI"), VALID_GAMEINFO);

    assert!(
      ConfigModManager::new()
        .scan_for_gameinfo(dir.path())
        .is_some()
    );
  }

  #[test]
  fn scan_returns_none_for_a_regular_mod_archive() {
    let dir = TempDir::new().expect("temp dir");
    write_file(&dir.path().join("pak01_dir.vpk"), "not a config");

    assert!(
      ConfigModManager::new()
        .scan_for_gameinfo(dir.path())
        .is_none()
    );
  }

  #[test]
  fn scan_archive_accepts_a_well_formed_gameinfo() {
    let dir = TempDir::new().expect("temp dir");
    let extracted = extracted_with(dir.path(), "ok", VALID_GAMEINFO);

    let scanned = ConfigModManager::new().scan_archive(&extracted, "low-spec.zip");

    assert!(scanned.has_gameinfo());
    assert_eq!(scanned.invalid_reason, None);
  }

  #[test]
  fn scan_archive_reports_why_a_malformed_gameinfo_is_unusable() {
    let dir = TempDir::new().expect("temp dir");
    let extracted = extracted_with(dir.path(), "bad", "totally not a game config");

    let scanned = ConfigModManager::new().scan_archive(&extracted, "broken.zip");

    assert!(scanned.has_gameinfo());
    assert!(
      scanned
        .invalid_reason
        .as_deref()
        .is_some_and(|reason| reason.contains("SearchPaths"))
    );
  }

  #[test]
  fn scan_archive_reports_an_archive_without_any_gameinfo() {
    let dir = TempDir::new().expect("temp dir");
    let extracted = dir.path().join("extracted");
    write_file(&extracted.join("skin.vpk"), "vpk");

    let scanned = ConfigModManager::new().scan_archive(&extracted, "skin.zip");

    assert!(!scanned.has_gameinfo());
    assert_eq!(scanned.invalid_reason, None);
  }

  #[test]
  fn each_archive_is_stashed_as_its_own_variant() {
    let dir = TempDir::new().expect("temp dir");
    let stash = dir.path().join("mod").join(CONFIG_STASH_DIR_NAME);
    let manager = ConfigModManager::new();

    for name in ["Low Spec.zip", "High Spec.zip"] {
      let extracted = extracted_with(dir.path(), name, VALID_GAMEINFO);
      manager
        .stash_variant(&stash, &manager.scan_archive(&extracted, name))
        .expect("variant should stash");
    }

    let info = ConfigModManager::config_info(&stash, None).expect("config info");
    let names: Vec<&str> = info
      .variants
      .iter()
      .map(|variant| variant.archive_name.as_str())
      .collect();

    assert_eq!(names, vec!["Low Spec.zip", "High Spec.zip"]);
    assert_eq!(info.variants.iter().filter(|v| v.is_valid).count(), 2);
  }

  #[test]
  fn restashing_the_same_archive_replaces_its_variant() {
    let dir = TempDir::new().expect("temp dir");
    let stash = dir.path().join("mod").join(CONFIG_STASH_DIR_NAME);
    let manager = ConfigModManager::new();
    let extracted = extracted_with(dir.path(), "same", VALID_GAMEINFO);
    let scanned = manager.scan_archive(&extracted, "config.zip");

    manager.stash_variant(&stash, &scanned).expect("first");
    let info = manager.stash_variant(&stash, &scanned).expect("second");

    assert_eq!(info.variants.len(), 1);
  }

  #[test]
  fn an_invalid_variant_is_kept_with_its_reason_but_not_copied() {
    let dir = TempDir::new().expect("temp dir");
    let stash = dir.path().join("mod").join(CONFIG_STASH_DIR_NAME);
    let manager = ConfigModManager::new();
    let extracted = extracted_with(dir.path(), "bad", "garbage");

    let info = manager
      .stash_variant(&stash, &manager.scan_archive(&extracted, "broken.zip"))
      .expect("variant should stash");

    let variant = &info.variants[0];
    assert!(!variant.is_valid);
    assert!(variant.invalid_reason.is_some());
    assert_eq!(info.variants.iter().filter(|v| v.is_valid).count(), 0);
  }

  #[test]
  fn archives_without_a_gameinfo_are_recorded_as_unusable() {
    let dir = TempDir::new().expect("temp dir");
    let stash = dir.path().join("mod").join(CONFIG_STASH_DIR_NAME);
    let manager = ConfigModManager::new();
    let vpk_only = dir.path().join("vpk-only");
    write_file(&vpk_only.join("skin.vpk"), "vpk");

    let scanned = vec![
      manager.scan_archive(
        &extracted_with(dir.path(), "ok", VALID_GAMEINFO),
        "config.zip",
      ),
      manager.scan_archive(&vpk_only, "skin.zip"),
    ];

    manager
      .stash_variant(&stash, &scanned[0])
      .expect("valid variant should stash");
    manager
      .stash_missing_variants(&stash, &scanned)
      .expect("missing variants should be recorded");

    let info = ConfigModManager::config_info(&stash, None).expect("config info");
    let missing = info
      .variants
      .iter()
      .find(|variant| variant.archive_name == "skin.zip")
      .expect("skin.zip should be listed");

    assert!(!missing.is_valid);
    assert_eq!(missing.invalid_reason, None);
    assert_eq!(info.variants.iter().filter(|v| v.is_valid).count(), 1);
  }

  #[test]
  fn resolve_variant_picks_the_named_version() {
    let dir = TempDir::new().expect("temp dir");
    let stash = dir.path().join("mod").join(CONFIG_STASH_DIR_NAME);
    let manager = ConfigModManager::new();

    for (name, body) in [("Low Spec.zip", "low"), ("High Spec.zip", "high")] {
      let extracted = extracted_with(dir.path(), name, &format!("{VALID_GAMEINFO}\n// {body}"));
      manager
        .stash_variant(&stash, &manager.scan_archive(&extracted, name))
        .expect("variant should stash");
    }

    let (name, path) =
      ConfigModManager::resolve_variant(&stash, Some("High Spec.zip"), None).expect("resolved");

    assert_eq!(name, "High Spec.zip");
    assert!(
      fs::read_to_string(path)
        .expect("readable")
        .contains("// high")
    );
  }

  #[test]
  fn resolve_variant_without_a_name_prefers_the_active_one() {
    let dir = TempDir::new().expect("temp dir");
    let stash = dir.path().join("mod").join(CONFIG_STASH_DIR_NAME);
    let manager = ConfigModManager::new();

    for name in ["a.zip", "b.zip"] {
      let extracted = extracted_with(dir.path(), name, VALID_GAMEINFO);
      manager
        .stash_variant(&stash, &manager.scan_archive(&extracted, name))
        .expect("variant should stash");
    }

    let (name, _) =
      ConfigModManager::resolve_variant(&stash, None, Some("b.zip")).expect("resolved");

    assert_eq!(name, "b.zip");
  }

  #[test]
  fn resolve_variant_refuses_an_unusable_version() {
    let dir = TempDir::new().expect("temp dir");
    let stash = dir.path().join("mod").join(CONFIG_STASH_DIR_NAME);
    let manager = ConfigModManager::new();
    let extracted = extracted_with(dir.path(), "bad", "garbage");
    manager
      .stash_variant(&stash, &manager.scan_archive(&extracted, "broken.zip"))
      .expect("variant should stash");

    let error = ConfigModManager::resolve_variant(&stash, Some("broken.zip"), None)
      .expect_err("an invalid variant cannot be applied");

    assert!(matches!(error, Error::ModInvalid(message) if message.contains("broken.zip")));
  }

  #[test]
  fn resolve_variant_reports_when_no_version_is_usable() {
    let dir = TempDir::new().expect("temp dir");
    let stash = dir.path().join("mod").join(CONFIG_STASH_DIR_NAME);
    let manager = ConfigModManager::new();
    let extracted = extracted_with(dir.path(), "bad", "garbage");
    manager
      .stash_variant(&stash, &manager.scan_archive(&extracted, "broken.zip"))
      .expect("variant should stash");

    assert!(ConfigModManager::resolve_variant(&stash, None, None).is_err());
  }

  #[test]
  fn slugs_stay_filesystem_safe_and_never_escape_the_stash() {
    assert_eq!(ConfigModManager::slugify("Low Spec.zip"), "low-spec-zip");
    assert_eq!(ConfigModManager::slugify("../../etc/passwd"), "etc-passwd");
    assert_eq!(ConfigModManager::slugify("..."), "variant");
    assert_eq!(ConfigModManager::slugify(""), "variant");
    assert!(ConfigModManager::slugify(&"a".repeat(200)).len() <= MAX_SLUG_LENGTH);
  }

  #[test]
  fn archives_that_slug_alike_get_separate_folders() {
    let existing = vec![StoredVariant {
      slug: "config-zip".to_string(),
      archive_name: "config.zip".to_string(),
      size: 1,
      is_valid: true,
      invalid_reason: None,
    }];

    assert_eq!(
      ConfigModManager::unique_slug("config+zip", &existing),
      "config-zip-2"
    );
    // The same archive keeps its own folder rather than being given a new one.
    assert_eq!(
      ConfigModManager::unique_slug("config.zip", &existing),
      "config-zip"
    );
  }

  #[test]
  fn a_legacy_flat_stash_is_adopted_as_one_variant() {
    let dir = TempDir::new().expect("temp dir");
    let stash = dir.path().join("mod").join(CONFIG_STASH_DIR_NAME);
    write_file(&stash.join(GAMEINFO_FILE_NAME), VALID_GAMEINFO);

    let info = ConfigModManager::config_info(&stash, None).expect("config info");
    assert_eq!(info.variants.len(), 1);

    let (_, path) = ConfigModManager::resolve_variant(&stash, None, None).expect("resolved");
    assert_eq!(path, stash.join(GAMEINFO_FILE_NAME));
  }

  #[test]
  fn a_pre_versions_install_is_attributed_to_its_only_stashed_version() {
    let mut config = ConfigModInfo {
      variants: vec![ConfigModVariant {
        archive_name: GAMEINFO_FILE_NAME.to_string(),
        size: 10,
        is_valid: true,
        invalid_reason: None,
      }],
      active_variant: None,
    };

    ConfigModManager::infer_active_variant(&mut config, true);

    assert_eq!(config.active_variant.as_deref(), Some(GAMEINFO_FILE_NAME));
  }

  #[test]
  fn a_mod_that_is_not_applied_gains_no_active_version() {
    let mut config = ConfigModInfo {
      variants: vec![ConfigModVariant {
        archive_name: "low-spec.zip".to_string(),
        size: 10,
        is_valid: true,
        invalid_reason: None,
      }],
      active_variant: None,
    };

    ConfigModManager::infer_active_variant(&mut config, false);

    assert_eq!(config.active_variant, None);
  }

  #[test]
  fn several_stashed_versions_stay_ambiguous_rather_than_guessing() {
    let variant = |name: &str| ConfigModVariant {
      archive_name: name.to_string(),
      size: 10,
      is_valid: true,
      invalid_reason: None,
    };
    let mut config = ConfigModInfo {
      variants: vec![variant("a.zip"), variant("b.zip")],
      active_variant: None,
    };

    ConfigModManager::infer_active_variant(&mut config, true);

    assert_eq!(config.active_variant, None);
  }

  #[test]
  fn a_recorded_active_version_is_never_overwritten() {
    let mut config = ConfigModInfo {
      variants: vec![ConfigModVariant {
        archive_name: "a.zip".to_string(),
        size: 10,
        is_valid: true,
        invalid_reason: None,
      }],
      active_variant: Some("b.zip".to_string()),
    };

    ConfigModManager::infer_active_variant(&mut config, true);

    assert_eq!(config.active_variant.as_deref(), Some("b.zip"));
  }

  #[test]
  fn config_info_is_absent_for_a_regular_mod() {
    let dir = TempDir::new().expect("temp dir");

    assert!(ConfigModManager::config_info(&dir.path().join("config"), None).is_none());
  }

  #[test]
  fn discard_stash_is_a_no_op_when_nothing_was_stashed() {
    let dir = TempDir::new().expect("temp dir");

    ConfigModManager::new()
      .discard_stash(&dir.path().join("config"))
      .expect("discarding a missing stash should succeed");
  }

  #[test]
  fn state_round_trips_and_clears() {
    let dir = TempDir::new().expect("temp dir");
    let state = ActiveConfigMod {
      mod_id: "mod-1".to_string(),
      mod_name: "Low Spec Config".to_string(),
      applied_at: ConfigModManager::current_timestamp(),
      variant: Some("Low Spec.zip".to_string()),
    };

    ConfigModManager::save_state(dir.path(), &state).expect("state should save");
    let loaded = ConfigModManager::load_state(dir.path()).expect("state should load");
    assert_eq!(loaded.mod_id, "mod-1");
    assert_eq!(loaded.variant.as_deref(), Some("Low Spec.zip"));

    ConfigModManager::clear_state(dir.path()).expect("state should clear");
    assert!(ConfigModManager::load_state(dir.path()).is_none());
  }

  #[test]
  fn corrupt_state_is_ignored_rather_than_failing() {
    let dir = TempDir::new().expect("temp dir");
    write_file(&ConfigModManager::state_path(dir.path()), "{ not json");

    assert!(ConfigModManager::load_state(dir.path()).is_none());
  }
}
