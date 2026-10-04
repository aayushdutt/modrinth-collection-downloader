import { useState } from "react";
import { useClipboard } from "../hooks/useClipboard";
import type { Loaded } from "../hooks/usePlan";

/** The panel's title row and the link field. */
export function CollectionForm({
  loaded,
  initialInput,
  opening,
  error,
  disabled,
  onOpen,
}: {
  loaded: Loaded | null;
  initialInput: string;
  opening: boolean;
  error: string | null;
  disabled: boolean;
  onOpen(input: string): void;
}) {
  const [input, setInput] = useState(initialInput);
  const [shownId, setShownId] = useState<string | null>(null);
  const { copied, copy } = useClipboard();

  // Show the canonical link once a collection opens.
  const openedId = loaded?.collection.id ?? null;
  if (openedId !== shownId) {
    setShownId(openedId);
    if (openedId) setInput(`modrinth.com/collection/${openedId}`);
  }

  return (
    <>
      <div className="flex min-h-[calc(var(--s)*10)] items-center gap-[calc(var(--s)*3)]">
        {loaded?.collection.icon_url && (
          <img src={loaded.collection.icon_url} alt="" className="size-[calc(var(--s)*10)] object-cover" />
        )}
        <h2 id="gui-title" className="min-w-0 truncate font-pixel text-[20px] leading-tight text-ink">
          {loaded ? loaded.collection.name : "Open a collection"}
        </h2>
        {loaded && (
          <button
            type="button"
            className="ml-auto shrink-0 font-pixel text-[14px] text-ink underline decoration-[length:var(--s)] underline-offset-4 hover:text-black"
            onClick={() => copy(location.href, "link")}
          >
            {copied === "link" ? "Copied" : "Share"}
          </button>
        )}
      </div>
      {loaded?.collection.description && (
        <p className="mt-1 line-clamp-2 text-[15px] text-ink">{loaded.collection.description}</p>
      )}

      <form
        className="mt-3 flex gap-[calc(var(--s)*2)]"
        onSubmit={(e) => {
          e.preventDefault();
          onOpen(input);
        }}
      >
        <label htmlFor="collection" className="sr-only">
          Collection link or ID
        </label>
        <input
          id="collection"
          className="mc-field min-w-0 flex-1 text-[16px]"
          placeholder="modrinth.com/collection/..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoFocus={!initialInput}
          disabled={disabled}
        />
        <button className={`mc-button text-[16px] ${loaded ? "" : "mc-button-primary"}`} disabled={opening || disabled}>
          {opening ? "Opening" : "Open"}
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-[15px] font-bold text-danger">
          {error}
        </p>
      ) : (
        !loaded && <p className="mt-2 text-[15px] text-ink">Collections are on your Modrinth profile. They must be public.</p>
      )}
    </>
  );
}
