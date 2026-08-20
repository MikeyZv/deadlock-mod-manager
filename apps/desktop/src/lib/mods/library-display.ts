import type { LocalMod } from "@/types/mods";
import { isModEnabled } from "./installed-helpers";

export enum ModFilter {
  All = "all",
  Enabled = "enabled",
  Disabled = "disabled",
}

export function filterLibraryModsByStatus(
  mods: LocalMod[],
  filter: ModFilter,
): LocalMod[] {
  switch (filter) {
    case ModFilter.Enabled:
      return mods.filter(isModEnabled);
    case ModFilter.Disabled:
      return mods.filter((mod) => !isModEnabled(mod));
    case ModFilter.All:
      return mods;
  }
}
