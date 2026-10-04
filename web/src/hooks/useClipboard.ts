import { useState } from "react";

/** Copy text and remember which thing was copied, briefly, for "Copied" feedback. */
export function useClipboard() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (text: string, what = text) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied((current) => (current === what ? null : current)), 1600);
  };
  return { copied, copy };
}
