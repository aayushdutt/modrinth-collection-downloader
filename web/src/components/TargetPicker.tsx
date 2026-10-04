import { useMemo } from "react";
import { loaderName } from "../lib/format";
import { coverage, loadersIn } from "../lib/resolve";
import type { GameVersionTag, Project } from "../lib/types";
import { installableCount, versionChoices } from "../lib/versions";
import { Checkbox } from "./Checkbox";

function Choice({
  label,
  count,
  total,
  title,
  pressed,
  onClick,
}: {
  label: string;
  count: number;
  total: number;
  title: string;
  pressed: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className="mc-button flex items-baseline gap-1.5 text-[16px]"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
    >
      {label}
      {/* Only worth showing when some projects are missing. */}
      {count < total && (
        <span className="font-sans text-[12px] text-white/80">
          {count}/{total}
        </span>
      )}
    </button>
  );
}

/** Minecraft version, loader, and whether alphas may fill gaps (betas always may). */
export function TargetPicker({
  projects,
  tags,
  gameVersion,
  loader,
  allowAlpha,
  disabled,
  onGameVersion,
  onLoader,
  onAllowAlpha,
}: {
  projects: Project[];
  tags: GameVersionTag[];
  gameVersion: string;
  loader: string;
  allowAlpha: boolean;
  disabled: boolean;
  onGameVersion(version: string): void;
  onLoader(loader: string): void;
  onAllowAlpha(on: boolean): void;
}) {
  const total = installableCount(projects);
  const loaders = useMemo(() => loadersIn(projects), [projects]);
  const counts = useMemo(() => coverage(projects, loader), [projects, loader]);
  const { chips, others } = useMemo(() => versionChoices(counts, tags), [counts, tags]);
  const inMenu = !chips.includes(gameVersion);

  return (
    <div className="mt-5 space-y-4">
      <fieldset disabled={disabled}>
        <legend className="font-pixel text-[16px] text-ink">Minecraft version</legend>
        <div className="mt-1.5 flex flex-wrap gap-[calc(var(--s)*2)]">
          {chips.map((v) => (
            <Choice
              key={v}
              label={v}
              count={counts.get(v) ?? 0}
              total={total}
              title={`${counts.get(v)} of ${total} projects list ${v}`}
              pressed={v === gameVersion}
              onClick={() => onGameVersion(v)}
            />
          ))}
          {others.length > 0 && (
            <select
              aria-label="Other Minecraft versions"
              className={`mc-button text-[16px] ${inMenu ? "mc-button-primary" : ""}`}
              value={inMenu ? gameVersion : ""}
              onChange={(e) => onGameVersion(e.target.value)}
            >
              <option value="" disabled>
                Other
              </option>
              {others.map((v) => (
                <option key={v} value={v}>
                  {v}
                  {counts.get(v)! < total ? ` (${counts.get(v)}/${total})` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      </fieldset>

      {loaders.length > 0 && (
        <fieldset disabled={disabled}>
          <legend className="font-pixel text-[16px] text-ink">Loader</legend>
          <div className="mt-1.5 flex flex-wrap gap-[calc(var(--s)*2)]">
            {loaders.map((l) => {
              const n = coverage(projects, l).get(gameVersion) ?? 0;
              return (
                <Choice
                  key={l}
                  label={loaderName(l)}
                  count={n}
                  total={total}
                  title={`${n} of ${total} projects list ${loaderName(l)} for ${gameVersion}`}
                  pressed={l === loader}
                  onClick={() => onLoader(l)}
                />
              );
            })}
          </div>
        </fieldset>
      )}

      <Checkbox checked={allowAlpha} onChange={onAllowAlpha} disabled={disabled}>
        Use alphas when there's no release or beta
      </Checkbox>
    </div>
  );
}
