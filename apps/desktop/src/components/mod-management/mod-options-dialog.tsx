import { Badge } from "@deadlock-mods/ui/components/badge";
import { Button } from "@deadlock-mods/ui/components/button";
import { Checkbox } from "@deadlock-mods/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deadlock-mods/ui/components/dialog";
import {
  RadioGroup,
  RadioGroupItem,
} from "@deadlock-mods/ui/components/radio-group";
import {
  AlertTriangle,
  Check,
  CloudDownload,
  Package,
  Settings,
  X,
} from "@deadlock-mods/ui/icons";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { configVariants, findConfigVariant } from "@/lib/mods/config-mods";
import { cn } from "@/lib/utils";
import type { ConfigModInfo, ModDownloadItem } from "@/types/mods";

/**
 * One selectable row. Usually an archive the author published, but a config mod can
 * also have a version stashed on disk that the published list no longer mentions —
 * one added from a loose file, or downloaded before archive names were recorded.
 * Leaving those out would hide the version that is actually applied to the game.
 */
interface ArchiveRow {
  name: string;
  size: number;
  description?: string | null;
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

/**
 * Shared by both list flavours so they space their rows identically. `flex` and `gap-1`
 * are also what override `RadioGroup`'s own `grid gap-2` default.
 */
const listClassName = "flex flex-col gap-1";

interface ModOptionsDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  isSaving?: boolean;
  onApply: (
    selectedArchives: ModDownloadItem[],
    deselectedArchives: ModDownloadItem[],
    allCheckedArchiveNames: string[],
  ) => void;
  onCancel: () => void;
  modName?: string;
  downloads?: ModDownloadItem[];
  onDiskArchiveNames?: Set<string>;
  activeArchiveNames?: Set<string>;
  /**
   * Set for a config mod, which can only ever have one version applied because every
   * version replaces the same gameinfo.gi. Turns the list into a single-choice picker
   * and marks versions whose archive holds no usable config.
   */
  configMod?: ConfigModInfo;
}

export const ModOptionsDialog = ({
  isOpen,
  onOpenChange,
  isSaving = false,
  onApply,
  onCancel,
  modName = "Mod",
  downloads = [],
  onDiskArchiveNames = new Set<string>(),
  activeArchiveNames = new Set<string>(),
  configMod,
}: ModOptionsDialogProps) => {
  const { t } = useTranslation();
  const [checkedNames, setCheckedNames] = useState<Set<string>>(new Set());
  const singleSelect = configMod !== undefined;

  const rows = useMemo<ArchiveRow[]>(() => {
    const published = new Set(downloads.map((download) => download.name));
    const stashedOnly = configVariants(configMod)
      .filter((variant) => !published.has(variant.archiveName))
      .map((variant) => ({ name: variant.archiveName, size: variant.size }));

    return [...stashedOnly, ...downloads];
  }, [downloads, configMod]);

  useEffect(() => {
    if (isOpen) {
      setCheckedNames(new Set(activeArchiveNames));
    }
  }, [isOpen, activeArchiveNames]);

  useEffect(() => {
    if (!isOpen) {
      setCheckedNames(new Set());
    }
  }, [isOpen]);

  // A downloaded archive with no usable gameinfo.gi is listed but cannot be picked,
  // so the user can see why a file they downloaded is not on offer.
  const unusableReason = (name: string): string | null => {
    if (!configMod) {
      return null;
    }
    const variant = findConfigVariant(configMod, name);
    if (!variant || variant.isValid) {
      return null;
    }
    return variant.invalidReason ?? t("configMods.noGameinfo");
  };

  const toggleArchive = (name: string) => {
    if (unusableReason(name)) {
      return;
    }
    setCheckedNames((prev) => {
      if (singleSelect) {
        return new Set([name]);
      }
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const initialKey = useMemo(
    () => [...activeArchiveNames].sort().join("|"),
    [activeArchiveNames],
  );
  const currentKey = useMemo(
    () => [...checkedNames].sort().join("|"),
    [checkedNames],
  );

  const hasChanges = initialKey !== currentKey;
  const canApply = !isSaving && hasChanges && checkedNames.size > 0;

  const handleApply = () => {
    const newlySelected = downloads.filter(
      (d) => checkedNames.has(d.name) && !activeArchiveNames.has(d.name),
    );
    const newlyDeselected = downloads.filter(
      (d) => !checkedNames.has(d.name) && activeArchiveNames.has(d.name),
    );
    onApply(newlySelected, newlyDeselected, [...checkedNames]);
  };

  const checkedCount = checkedNames.size;

  const rowElements = rows.map((download) => {
    const isChecked = checkedNames.has(download.name);
    const isOnDisk = onDiskArchiveNames.has(download.name);
    const isEnabled = activeArchiveNames.has(download.name);
    const unusable = unusableReason(download.name);

    return (
      <div
        className={cn(
          "flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left",
          unusable
            ? "cursor-not-allowed opacity-60"
            : "cursor-pointer hover:bg-muted/50",
          isSaving && "pointer-events-none opacity-50",
        )}
        key={`archive-${download.name}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!isSaving) toggleArchive(download.name);
        }}>
        <div className='flex items-center gap-3'>
          {singleSelect ? (
            <RadioGroupItem
              aria-label={download.name}
              disabled={isSaving || unusable !== null}
              onClick={(e) => e.stopPropagation()}
              value={download.name}
            />
          ) : (
            <Checkbox
              checked={isChecked}
              disabled={isSaving}
              onCheckedChange={() => toggleArchive(download.name)}
              onClick={(e) => e.stopPropagation()}
            />
          )}
          <div className='flex flex-col gap-0.5'>
            <div className='flex items-center gap-2'>
              <Package className='h-4 w-4 text-muted-foreground' />
              <span className='font-mono text-sm'>{download.name}</span>
              {isEnabled && (
                <Badge variant='default' className='gap-1 text-xs py-0'>
                  <Check className='h-3 w-3' />
                  {t("modOptions.enabled")}
                </Badge>
              )}
              {unusable ? (
                <Badge
                  variant='outline'
                  className='gap-1 text-xs font-normal text-muted-foreground'>
                  <AlertTriangle className='h-3 w-3' />
                  {t("configMods.unusableVersion")}
                </Badge>
              ) : (
                !isOnDisk && (
                  <Badge
                    variant='outline'
                    className='gap-1 text-xs font-normal'>
                    <CloudDownload className='h-3 w-3' />
                    {t("modOptions.needsDownload")}
                  </Badge>
                )
              )}
            </div>
            <div className='flex items-center gap-3 pl-6 text-xs text-muted-foreground'>
              {/* A stashed version records size 0 when its archive shipped no config
                  at all, which is an unknown size rather than an empty file. */}
              {download.size > 0 && (
                <span>{formatFileSize(download.size)}</span>
              )}
              {unusable ? (
                <span className='truncate max-w-[300px]'>{unusable}</span>
              ) : (
                download.description && (
                  <span className='truncate max-w-[300px]'>
                    {download.description}
                  </span>
                )
              )}
            </div>
          </div>
        </div>
      </div>
    );
  });

  return (
    <Dialog onOpenChange={onOpenChange} open={isOpen}>
      <DialogContent
        className='max-h-[80vh] max-w-2xl'
        onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <Settings className='h-5 w-5' />
            {t("modOptions.title", { modName })}
          </DialogTitle>
          <DialogDescription>
            {singleSelect
              ? t("configMods.versionPickerDescription")
              : t("modOptions.description")}
          </DialogDescription>
        </DialogHeader>

        {rows.length === 0 ? (
          <div className='py-8 text-center text-muted-foreground text-sm'>
            {t("modOptions.noOptions")}
          </div>
        ) : (
          <div className='max-h-[55vh] overflow-y-auto pr-4'>
            {singleSelect ? (
              // Radio semantics belong to the group, so the list is only a RadioGroup
              // when it really is single-choice.
              <RadioGroup
                className={listClassName}
                disabled={isSaving}
                onValueChange={toggleArchive}
                value={[...checkedNames][0] ?? ""}>
                {rowElements}
              </RadioGroup>
            ) : (
              <div className={listClassName}>{rowElements}</div>
            )}
          </div>
        )}

        <DialogFooter className='flex items-center justify-between'>
          <div className='text-muted-foreground text-sm'>
            {t("modOptions.selectedCount", {
              selected: checkedCount,
              total: rows.length,
            })}
          </div>
          <div className='space-x-2'>
            <Button
              icon={<X className='h-4 w-4' />}
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
              variant='outline'
              disabled={isSaving}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!canApply}
              icon={<Check className='h-4 w-4' />}
              isLoading={isSaving}
              onClick={(e) => {
                e.stopPropagation();
                handleApply();
              }}>
              {t("modOptions.apply")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
