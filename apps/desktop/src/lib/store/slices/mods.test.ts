import { describe, expect, it, mock } from "bun:test";
import type { ConfigModInfo, ConfigModVariant, LocalMod } from "@/types/mods";
import { ModStatus } from "@/types/mods";

interface LoggerMock {
  withMetadata: () => LoggerMock;
  withError: () => LoggerMock;
  warn: () => void;
  error: () => void;
  info: () => void;
  debug: () => void;
}

const noop = () => {};
const loggerMock: LoggerMock = {
  withMetadata: () => loggerMock,
  withError: () => loggerMock,
  warn: noop,
  error: noop,
  info: noop,
  debug: noop,
};

mock.module("@/lib/logger", () => ({
  createLogger: () => loggerMock,
  default: loggerMock,
}));

const { createModsSlice } = await import("./mods");

interface TestProfile {
  mods: LocalMod[];
}

interface TestState {
  localMods: LocalMod[];
  profiles: Record<string, TestProfile>;
  activeProfileId: string;
}

const variant = (archiveName: string): ConfigModVariant => ({
  archiveName,
  size: 1,
  isValid: true,
  invalidReason: null,
});

const config = (
  archiveNames: string[],
  activeVariant: string | null,
): ConfigModInfo => ({
  variants: archiveNames.map(variant),
  activeVariant,
});

const modWith = (
  remoteId: string,
  configMod: ConfigModInfo | undefined,
): LocalMod =>
  ({
    id: remoteId,
    remoteId,
    name: `Mod ${remoteId}`,
    status: ModStatus.Downloaded,
    configMod,
  }) as LocalMod;

/**
 * Drives the slice's actions against a plain object, so the merge logic can be
 * exercised without standing up the real persisted store.
 */
const harness = (initial: TestState) => {
  let state = initial;

  const set = (partial: unknown) => {
    const next =
      typeof partial === "function"
        ? (partial as (current: TestState) => Partial<TestState>)(state)
        : (partial as Partial<TestState>);
    state = { ...state, ...next };
  };

  const slice = createModsSlice(
    set as never,
    (() => state) as never,
    {} as never,
  );

  return { slice, read: () => state };
};

const singleMod = (configMod: ConfigModInfo | undefined): TestState => ({
  localMods: [modWith("mod-1", configMod)],
  profiles: { default: { mods: [modWith("mod-1", configMod)] } },
  activeProfileId: "default",
});

describe("setConfigModVariants", () => {
  it("keeps the applied version when the incoming config names none", () => {
    const { slice, read } = harness(
      singleMod(config(["Low Spec.zip"], "Low Spec.zip")),
    );

    // What a download or a stash reports: the versions on disk, with no claim
    // about which one is in the game.
    slice.setConfigModVariants(
      "mod-1",
      config(["Low Spec.zip", "High Spec.zip"], null),
    );

    const mod = read().localMods[0];
    expect(mod.configMod?.activeVariant).toBe("Low Spec.zip");
    expect(mod.configMod?.variants).toHaveLength(2);
  });

  it("clears the applied version when it is no longer stashed", () => {
    const { slice, read } = harness(
      singleMod(config(["Low Spec.zip"], "Low Spec.zip")),
    );

    slice.setConfigModVariants("mod-1", config(["High Spec.zip"], null));

    expect(read().localMods[0].configMod?.activeVariant).toBe(null);
  });

  it("lets an incoming applied version win over the stored one", () => {
    const { slice, read } = harness(
      singleMod(config(["Low Spec.zip", "High Spec.zip"], "Low Spec.zip")),
    );

    slice.setConfigModVariants(
      "mod-1",
      config(["Low Spec.zip", "High Spec.zip"], "High Spec.zip"),
    );

    expect(read().localMods[0].configMod?.activeVariant).toBe("High Spec.zip");
  });

  it("records the versions for a mod that had no config yet", () => {
    const { slice, read } = harness(singleMod(undefined));

    slice.setConfigModVariants("mod-1", config(["Low Spec.zip"], null));

    expect(read().localMods[0].configMod?.activeVariant).toBe(null);
    expect(read().localMods[0].configMod?.variants).toHaveLength(1);
  });

  it("reaches every profile, not only the active one", () => {
    const applied = config(["Low Spec.zip"], "Low Spec.zip");
    const { slice, read } = harness({
      localMods: [modWith("mod-1", applied)],
      profiles: {
        default: { mods: [modWith("mod-1", applied)] },
        other: { mods: [modWith("mod-1", applied)] },
      },
      activeProfileId: "default",
    });

    slice.setConfigModVariants(
      "mod-1",
      config(["Low Spec.zip", "High Spec.zip"], null),
    );

    for (const profile of Object.values(read().profiles)) {
      expect(profile.mods[0].configMod?.variants).toHaveLength(2);
      expect(profile.mods[0].configMod?.activeVariant).toBe("Low Spec.zip");
    }
  });

  it("leaves other mods untouched", () => {
    const other = config(["Other.zip"], "Other.zip");
    const { slice, read } = harness({
      localMods: [
        modWith("mod-1", config(["Low Spec.zip"], "Low Spec.zip")),
        modWith("mod-2", other),
      ],
      profiles: { default: { mods: [] } },
      activeProfileId: "default",
    });

    slice.setConfigModVariants("mod-1", config(["High Spec.zip"], null));

    expect(read().localMods[1].configMod).toBe(other);
  });
});

describe("setConfigMod", () => {
  it("replaces the applied version, including clearing it", () => {
    // The counterpart to `setConfigModVariants`: callers of this one have asked
    // the backend what is applied, so their null is an answer rather than silence.
    const { slice, read } = harness(
      singleMod(config(["Low Spec.zip"], "Low Spec.zip")),
    );

    slice.setConfigMod("mod-1", config(["Low Spec.zip"], null));

    expect(read().localMods[0].configMod?.activeVariant).toBe(null);
  });
});
