use std::path::PathBuf;

use crate::app_runtime::AppHandle;
use crate::download_manager::ConfigModFoundEvent;
use crate::errors::Error;
use crate::mod_manager::archive_extractor::ArchiveExtractor;
use crate::mod_manager::{ConfigModInfo, ConfigModInstallResult, ConfigModManager};

use super::state::MANAGER;

/// Every stashed version of a mod, or `None` when it is not a config mod.
#[tauri::command]
pub async fn get_mod_config_info(mod_id: String) -> Result<Option<ConfigModInfo>, Error> {
  let mod_manager = MANAGER.lock().unwrap();
  mod_manager.get_mod_config_info(&mod_id)
}

#[tauri::command]
pub async fn install_config_mod(
  mod_id: String,
  mod_name: String,
  variant: Option<String>,
  profile_folder: Option<String>,
) -> Result<ConfigModInstallResult, Error> {
  let mut mod_manager = MANAGER.lock().unwrap();
  mod_manager.install_config_mod(mod_id, mod_name, variant, profile_folder)
}

#[tauri::command]
pub async fn uninstall_config_mod(
  mod_id: String,
  profile_folder: Option<String>,
) -> Result<(), Error> {
  let mut mod_manager = MANAGER.lock().unwrap();
  mod_manager.uninstall_config_mod(&mod_id, profile_folder)
}

/// Download one of the mod's other archives and stash its `gameinfo.gi` as a version,
/// so the user can switch to a version they never downloaded. The counterpart of
/// `stage_download_archive`, which stages VPKs and rejects a config-only archive.
#[tauri::command]
pub async fn stage_config_mod_variant(
  mod_id: String,
  archive_url: String,
  archive_name: String,
) -> Result<ConfigModInfo, Error> {
  log::info!("Staging config mod version for {mod_id}: {archive_name}");

  super::mods::validate_download_url(&archive_url)?;
  let safe_archive_name = super::mods::sanitize_archive_name(&archive_name)?;

  let stash_dir = {
    let mod_manager = MANAGER.lock().unwrap();
    ConfigModManager::stash_dir(&mod_manager.get_validated_mod_folder_path(&mod_id)?)
  };

  let client = crate::proxy::build_default_http_client()?;
  let response = client
    .get(&archive_url)
    .send()
    .await
    .map_err(|e| Error::Network(format!("Failed to fetch {archive_url}: {e}")))?;

  if !response.status().is_success() {
    return Err(Error::DownloadFailed(format!(
      "{archive_url} returned status {}",
      response.status()
    )));
  }

  let bytes = response
    .bytes()
    .await
    .map_err(|e| Error::DownloadFailed(format!("Failed reading body for {archive_url}: {e}")))?;

  let temp_dir = tempfile::tempdir()?;
  let archive_path = temp_dir.path().join(&safe_archive_name);
  std::fs::write(&archive_path, &bytes)?;

  let extract_dir = temp_dir.path().join("extracted");
  ArchiveExtractor::new().extract_archive(&archive_path, &extract_dir)?;

  let config_mod_manager = ConfigModManager::new();
  let scanned = config_mod_manager.scan_archive(&extract_dir, &archive_name);

  // The version is recorded either way: a rejected download stays visible in the UI
  // with its reason instead of vanishing.
  let config = config_mod_manager.stash_variant(&stash_dir, &scanned)?;

  if !scanned.has_gameinfo() {
    return Err(Error::ModInvalid(format!(
      "{archive_name} does not contain a gameinfo.gi"
    )));
  }

  if let Some(reason) = scanned.invalid_reason.as_ref() {
    return Err(Error::ModInvalid(format!(
      "{archive_name} does not contain a usable gameinfo.gi: {reason}"
    )));
  }

  Ok(config)
}

/// Restore the game config before a config mod's files are deleted. Purging a mod
/// that is not the active config mod, or is not a config mod at all, is a no-op.
pub(crate) fn restore_game_config_if_active(
  mod_id: &str,
  profile_folder: Option<String>,
) -> Result<(), Error> {
  let mut mod_manager = MANAGER.lock().unwrap();

  let is_active = mod_manager
    .get_active_config_mod()
    .unwrap_or(None)
    .is_some_and(|active| active.mod_id == mod_id);

  if !is_active {
    return Ok(());
  }

  // Without a game path there is nothing to restore into, and refusing the purge
  // would leave the mod undeletable. Dropping the record is the recoverable half.
  if mod_manager.get_steam_manager().get_game_path().is_none() {
    log::warn!("Game path not set, clearing config mod state for {mod_id} without restoring");
    return mod_manager.forget_config_mod_state();
  }

  // Restoring overwrites the game's gameinfo.gi, which the running game holds
  // open. The purge is refused rather than skipped: continuing would delete the
  // stashed copy while the mod's config stayed applied, stranding the user's own
  // config behind a mod no longer in the library. Naming the cause up front makes
  // it clear the delete only needs retrying once the game is closed.
  if mod_manager.is_game_running()? {
    log::warn!("Refusing to purge active config mod {mod_id}: the game is running");
    return Err(Error::GameRunning);
  }

  log::info!("Purging active config mod {mod_id}, restoring the previous game config first");
  mod_manager.uninstall_config_mod(mod_id, profile_folder)
}

/// Scan a locally added mod's extracted files for a `gameinfo.gi` and stash it,
/// mirroring what the download pipeline does for downloaded archives.
#[tauri::command]
pub async fn scan_and_stash_local_mod_config(
  app_handle: AppHandle,
  mod_id: String,
  files_dir: String,
) -> Result<Option<ConfigModInfo>, Error> {
  use tauri::Emitter;

  let (mod_dir, validated_files_dir) = {
    let mod_manager = MANAGER.lock().unwrap();
    let mod_dir = mod_manager.get_validated_mod_folder_path(&mod_id)?;
    let validated_files_dir =
      mod_manager.validate_extract_target_path(&PathBuf::from(&files_dir))?;
    let expected_files_dir = mod_dir.join("files");

    if validated_files_dir != expected_files_dir {
      return Err(Error::UnauthorizedPath(format!(
        "Path '{}' is outside the allowed mod files directory '{}'",
        validated_files_dir.display(),
        expected_files_dir.display()
      )));
    }

    (mod_dir, validated_files_dir)
  };

  if !validated_files_dir.exists() {
    return Ok(None);
  }

  let config_mod_manager = ConfigModManager::new();
  let stash_dir = ConfigModManager::stash_dir(&mod_dir);
  config_mod_manager.discard_stash(&stash_dir)?;

  // A locally added mod has no published archive to name the version after, so the
  // file itself is the label.
  let scanned = config_mod_manager.scan_archive(
    &validated_files_dir,
    crate::mod_manager::config_mod_manager::GAMEINFO_FILE_NAME,
  );

  if !scanned.has_gameinfo() {
    return Ok(None);
  }

  let config = config_mod_manager.stash_variant(&stash_dir, &scanned)?;

  log::info!("Local mod {mod_id} is a config mod, emitting config-mod-found event");
  app_handle
    .emit(
      "config-mod-found",
      ConfigModFoundEvent {
        mod_id,
        config: config.clone(),
      },
    )
    .map_err(|error| Error::Io(std::io::Error::other(error.to_string())))?;

  Ok(Some(config))
}
