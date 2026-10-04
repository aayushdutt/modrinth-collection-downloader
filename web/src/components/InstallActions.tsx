import { useClipboard } from "../hooks/useClipboard";
import type { InstallFlow } from "../hooks/useInstallFlow";
import { GAME_FOLDER, platform, supportsFolderAccess } from "../lib/platform";
import { countStates } from "../lib/summary";
import { XpBar } from "./XpBar";

const canUseFolders = supportsFolderAccess();
const os = platform();
const folderHint = GAME_FOLDER[os];

/** Progress, the zip and folder buttons, and the folder picker's follow-ups. */
export function InstallActions({
  flow,
  jobCount,
  ready,
  tooBigForZip,
}: {
  flow: InstallFlow;
  jobCount: number;
  ready: boolean;
  tooBigForZip: boolean;
}) {
  const { copied, copy } = useClipboard();
  const done = countStates(flow.progress, "added", "updated", "current", "kept", "failed", "stopped");

  return (
    <>
      {flow.phase !== "idle" && (
        <div className="mt-4">
          <XpBar value={jobCount ? done / jobCount : 0} level={done} />
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-[calc(var(--s)*2)]">
        {flow.phase === "running" ? (
          <button type="button" className="mc-button text-[17px]" onClick={flow.stop}>
            Stop
          </button>
        ) : (
          <>
            <button
              type="button"
              className="mc-button mc-button-primary text-[17px]"
              disabled={!ready || tooBigForZip}
              onClick={flow.downloadZip}
            >
              Download zip
            </button>
            {canUseFolders && (
              <button type="button" className="mc-button text-[17px]" disabled={!ready} onClick={flow.chooseFolder}>
                Install into folder
              </button>
            )}
          </>
        )}
      </div>

      {flow.pendingRoot && (
        <div role="alert" className="mt-3 space-y-2 text-[15px]">
          <p>
            <strong>"{flow.pendingRoot.name}"</strong> has no mods folder. Install here anyway?
          </p>
          <div className="flex flex-wrap gap-[calc(var(--s)*2)]">
            <button type="button" className="mc-button text-[15px]" onClick={() => flow.installInto(flow.pendingRoot!)}>
              Install here
            </button>
            <button type="button" className="mc-button text-[15px]" onClick={flow.chooseFolder}>
              Pick another
            </button>
          </div>
        </div>
      )}
      {flow.note && (
        <p role="alert" className="mt-3 text-[15px] font-bold text-danger">
          {flow.note}
        </p>
      )}
      {tooBigForZip && <p className="mt-3 text-[15px]">Too big for one zip. Skip some, or install into a folder.</p>}

      {canUseFolders && (
        <div className="mt-4 space-y-1 text-[15px] leading-snug">
          <p>Install into folder updates your game folder in place.</p>
          {os === "mac" ? (
            <p>On Mac, Chrome can't open folders in ~/Library. Use the zip for those.</p>
          ) : (
            folderHint && (
              <p>
                Default:{" "}
                <button
                  type="button"
                  className="font-pixel underline underline-offset-4"
                  title="Copy"
                  onClick={() => copy(folderHint.path)}
                >
                  {copied ? "copied" : folderHint.path}
                </button>{" "}
                ({folderHint.jump})
              </p>
            )
          )}
        </div>
      )}
    </>
  );
}
