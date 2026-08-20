import { formatByteSize } from "@deadlock-mods/shared";
import { Badge } from "@deadlock-mods/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@deadlock-mods/ui/components/card";
import { AlertTriangle, Check, FileCog } from "@deadlock-mods/ui/icons";
import { useTranslation } from "react-i18next";
import { configVariants } from "@/lib/mods/config-mods";
import { cn } from "@/lib/utils";
import type { ConfigModInfo } from "@/types/mods";

interface ConfigModSectionProps {
  config: ConfigModInfo;
  isInstalled: boolean;
}

export const ConfigModSection = ({
  config,
  isInstalled,
}: ConfigModSectionProps) => {
  const { t } = useTranslation();
  const variants = configVariants(config);
  const hasSeveralVersions = variants.length > 1;

  if (variants.length === 0) {
    return null;
  }

  return (
    <Card className='shadow-none [contain:layout_style_paint]'>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          <FileCog className='h-4 w-4' />
          {t("configMods.sectionTitle")}
        </CardTitle>
        <CardDescription>
          {isInstalled
            ? t("configMods.sectionDescriptionActive")
            : t("configMods.sectionDescription")}
          {hasSeveralVersions && ` ${t("configMods.versionsDescription")}`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className='flex flex-col gap-2'>
          {variants.map((variant) => {
            const isActive =
              isInstalled && variant.archiveName === config.activeVariant;

            return (
              <div
                className={cn(
                  "flex items-center justify-between gap-3 rounded-md bg-muted/30 px-3 py-1.5",
                  !variant.isValid && "opacity-60",
                )}
                key={variant.archiveName}>
                <div className='flex min-w-0 flex-col'>
                  <span className='truncate font-mono text-sm'>
                    {variant.archiveName}
                  </span>
                  {!variant.isValid && (
                    <span className='text-muted-foreground text-xs'>
                      {variant.invalidReason ?? t("configMods.noGameinfo")}
                    </span>
                  )}
                </div>
                <div className='flex shrink-0 items-center gap-2'>
                  {variant.isValid && (
                    <span className='text-muted-foreground text-xs tabular-nums'>
                      {formatByteSize(variant.size)}
                    </span>
                  )}
                  {isActive && (
                    <Badge className='gap-1 py-0 text-xs' variant='default'>
                      <Check className='h-3 w-3' />
                      {t("configMods.activeVersion")}
                    </Badge>
                  )}
                  {!variant.isValid && (
                    <Badge
                      className='gap-1 text-xs font-normal text-muted-foreground'
                      variant='outline'>
                      <AlertTriangle className='h-3 w-3' />
                      {t("configMods.unusableVersion")}
                    </Badge>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
};
