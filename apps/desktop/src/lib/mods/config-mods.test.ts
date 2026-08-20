import { describe, expect, it } from "bun:test";
import { ModDtoSchema } from "@deadlock-mods/shared";
import type { ConfigModInfo } from "@/types/mods";
import { type LocalMod, ModStatus } from "@/types/mods";
import {
  configVariants,
  findConfigVariant,
  isConfigMod,
  resolveConfigVariantNames,
  UNNAMED_CONFIG_VARIANT,
} from "./config-mods";
import { isInstalledModWithVpks, isModEnabled } from "./installed-helpers";
import { filterLibraryModsByStatus, ModFilter } from "./library-display";

const makeMod = (remoteId: string, overrides: Partial<LocalMod>): LocalMod => {
  const remoteUpdatedAt = new Date("2026-01-23T00:00:00.000Z");
  const dto = ModDtoSchema.parse({
    id: remoteId,
    remoteId,
    name: `Mod ${remoteId}`,
    description: null,
    remoteUrl: "https://example.com",
    category: "Other/Misc",
    likes: 0,
    author: "author",
    downloadable: true,
    remoteAddedAt: remoteUpdatedAt,
    remoteUpdatedAt,
    tags: [],
    images: [],
    hero: null,
    isAudio: false,
    isMap: false,
    audioUrl: null,
    downloadCount: 0,
    isNSFW: false,
    filesUpdatedAt: null,
    metadata: null,
    createdAt: null,
    updatedAt: null,
  });

  return { ...dto, status: ModStatus.Downloaded, ...overrides };
};

const configMod = (status: ModStatus) =>
  makeMod("config-preset", {
    status,
    configMod: {
      variants: [
        {
          archiveName: "low-spec.zip",
          size: 4096,
          isValid: true,
          invalidReason: null,
        },
      ],
      activeVariant: status === ModStatus.Installed ? "low-spec.zip" : null,
    },
  });

const vpkMod = (status: ModStatus, installedVpks: string[]) =>
  makeMod("vpk-skin", { status, installedVpks });

describe("isConfigMod", () => {
  it("identifies a mod that stashed a gameinfo.gi", () => {
    expect(isConfigMod(configMod(ModStatus.Downloaded))).toBe(true);
  });

  it("does not treat a regular mod as a config mod", () => {
    expect(isConfigMod(vpkMod(ModStatus.Installed, ["skin.vpk"]))).toBe(false);
  });
});

describe("isModEnabled", () => {
  it("counts an applied config mod even though it installs no VPKs", () => {
    const mod = configMod(ModStatus.Installed);

    expect(isInstalledModWithVpks(mod)).toBe(false);
    expect(isModEnabled(mod)).toBe(true);
  });

  it("does not count a config mod that is downloaded but not applied", () => {
    expect(isModEnabled(configMod(ModStatus.Downloaded))).toBe(false);
  });

  it("still counts a regular installed mod with VPKs", () => {
    expect(isModEnabled(vpkMod(ModStatus.Installed, ["skin.vpk"]))).toBe(true);
  });

  it("does not count an installed mod whose VPKs are gone", () => {
    expect(isModEnabled(vpkMod(ModStatus.Installed, []))).toBe(false);
  });
});

describe("filterLibraryModsByStatus", () => {
  const applied = configMod(ModStatus.Installed);
  const skin = vpkMod(ModStatus.Installed, ["skin.vpk"]);
  const disabled = makeMod("disabled-skin", { status: ModStatus.Downloaded });
  const mods = [applied, skin, disabled];

  it("lists an applied config mod under enabled", () => {
    expect(filterLibraryModsByStatus(mods, ModFilter.Enabled)).toEqual([
      applied,
      skin,
    ]);
  });

  it("keeps an applied config mod out of the disabled list", () => {
    expect(filterLibraryModsByStatus(mods, ModFilter.Disabled)).toEqual([
      disabled,
    ]);
  });

  it("returns everything for the all filter", () => {
    expect(filterLibraryModsByStatus(mods, ModFilter.All)).toBe(mods);
  });
});

describe("config mod versions", () => {
  const threeVersions: ConfigModInfo = {
    variants: [
      {
        archiveName: "low-spec.zip",
        size: 4096,
        isValid: true,
        invalidReason: null,
      },
      {
        archiveName: "broken.zip",
        size: 128,
        isValid: false,
        invalidReason: "SearchPaths section not found",
      },
      {
        archiveName: "high-spec.zip",
        size: 8192,
        isValid: true,
        invalidReason: null,
      },
    ],
    activeVariant: null,
  };

  it("keeps an unusable version around so its reason can be shown", () => {
    const broken = findConfigVariant(threeVersions, "broken.zip");

    expect(broken?.isValid).toBe(false);
    expect(broken?.invalidReason).toBe("SearchPaths section not found");
  });

  it("returns nothing for a version the mod does not have", () => {
    expect(findConfigVariant(threeVersions, "absent.zip")).toBeUndefined();
  });

  it("treats a mod with only unusable versions as a config mod, not a VPK mod", () => {
    const mod = makeMod("all-broken", {
      status: ModStatus.Downloaded,
      configMod: {
        variants: [
          {
            archiveName: "broken.zip",
            size: 1,
            isValid: false,
            invalidReason: "bad",
          },
        ],
        activeVariant: null,
      },
    });

    expect(isConfigMod(mod)).toBe(true);
  });

  it("handles a mod that is not a config mod at all", () => {
    expect(configVariants(undefined)).toEqual([]);
    expect(findConfigVariant(undefined, "any.zip")).toBeUndefined();
  });
});

// The store persists `configMod`, so state written by a build that predates
// versions still reaches these readers. Throwing here unmounts the mod library,
// so every reader has to tolerate the old shape even before the migration runs.
describe("config mod state from an older build", () => {
  const legacyShape = { fileName: "gameinfo.gi", size: 4096 };
  // Deliberately lying about the type: this is what is actually on disk for a
  // user who ran the single-file build.
  const stale = legacyShape as unknown as ConfigModInfo;

  it("reports no versions instead of throwing", () => {
    expect(() => configVariants(stale)).not.toThrow();
    expect(configVariants(stale)).toEqual([]);
  });

  it("finds no version instead of throwing", () => {
    expect(() => findConfigVariant(stale, "gameinfo.gi")).not.toThrow();
    expect(findConfigVariant(stale, "gameinfo.gi")).toBeUndefined();
  });

  it("is still recognised as a config mod", () => {
    const mod = makeMod("stale-config", {
      status: ModStatus.Installed,
      configMod: stale,
    });

    expect(isConfigMod(mod)).toBe(true);
    expect(isModEnabled(mod)).toBe(true);
  });
});

const unnamedOnly = (activeVariant: string | null): ConfigModInfo => ({
  variants: [
    {
      archiveName: UNNAMED_CONFIG_VARIANT,
      size: 2048,
      isValid: true,
      invalidReason: null,
    },
  ],
  activeVariant,
});

describe("recovering the creator's file name for an unnamed version", () => {
  it("shows the version under the one file the user downloaded", () => {
    const { config } = resolveConfigVariantNames(
      unnamedOnly(UNNAMED_CONFIG_VARIANT),
      [{ name: "Low Spec.zip" }],
    );

    expect(config?.variants[0].archiveName).toBe("Low Spec.zip");
    expect(config?.activeVariant).toBe("Low Spec.zip");
  });

  it("translates the displayed name back to what the backend stashed", () => {
    const { toStashName } = resolveConfigVariantNames(
      unnamedOnly(UNNAMED_CONFIG_VARIANT),
      [{ name: "Low Spec.zip" }],
    );

    expect(toStashName("Low Spec.zip")).toBe(UNNAMED_CONFIG_VARIANT);
    expect(toStashName("High Spec.zip")).toBe("High Spec.zip");
  });

  it("leaves it alone when several files were downloaded", () => {
    const original = unnamedOnly(null);
    const { config, toStashName } = resolveConfigVariantNames(original, [
      { name: "Low Spec.zip" },
      { name: "High Spec.zip" },
    ]);

    expect(config).toBe(original);
    expect(toStashName("anything")).toBe("anything");
  });

  it("leaves it alone when nothing was downloaded", () => {
    const original = unnamedOnly(null);

    expect(resolveConfigVariantNames(original, []).config).toBe(original);
  });

  it("does not rename onto a name another version already holds", () => {
    const original: ConfigModInfo = {
      variants: [
        {
          archiveName: UNNAMED_CONFIG_VARIANT,
          size: 1,
          isValid: true,
          invalidReason: null,
        },
        {
          archiveName: "Low Spec.zip",
          size: 2,
          isValid: true,
          invalidReason: null,
        },
      ],
      activeVariant: null,
    };

    expect(
      resolveConfigVariantNames(original, [{ name: "Low Spec.zip" }]).config,
    ).toBe(original);
  });

  it("leaves properly named versions untouched", () => {
    const original: ConfigModInfo = {
      variants: [
        {
          archiveName: "Low Spec.zip",
          size: 1,
          isValid: true,
          invalidReason: null,
        },
      ],
      activeVariant: "Low Spec.zip",
    };

    expect(
      resolveConfigVariantNames(original, [{ name: "Low Spec.zip" }]).config,
    ).toBe(original);
  });

  it("copes with a mod that is not a config mod", () => {
    const { config, toStashName } = resolveConfigVariantNames(undefined, [
      { name: "Low Spec.zip" },
    ]);

    expect(config).toBeUndefined();
    expect(toStashName("Low Spec.zip")).toBe("Low Spec.zip");
  });
});

describe("versions stashed on disk but absent from the author's file list", () => {
  it("keeps a stashed version that the published list no longer mentions", () => {
    // What the Manage Files picker does: without the union, a version applied to
    // the game but missing from the API's file list would never be shown.
    const config: ConfigModInfo = {
      variants: [
        {
          archiveName: UNNAMED_CONFIG_VARIANT,
          size: 2048,
          isValid: true,
          invalidReason: null,
        },
      ],
      activeVariant: UNNAMED_CONFIG_VARIANT,
    };
    const published = new Set(["low-spec.zip", "high-spec.zip"]);

    const stashedOnly = configVariants(config)
      .filter((variant) => !published.has(variant.archiveName))
      .map((variant) => variant.archiveName);

    expect(stashedOnly).toEqual([UNNAMED_CONFIG_VARIANT]);
  });

  it("does not duplicate a stashed version that is in the published list", () => {
    const config: ConfigModInfo = {
      variants: [
        {
          archiveName: "low-spec.zip",
          size: 2048,
          isValid: true,
          invalidReason: null,
        },
      ],
      activeVariant: "low-spec.zip",
    };
    const published = new Set(["low-spec.zip", "high-spec.zip"]);

    const stashedOnly = configVariants(config).filter(
      (variant) => !published.has(variant.archiveName),
    );

    expect(stashedOnly).toEqual([]);
  });
});
