import { useEffect } from "react";

export interface ShareState {
  collection: string;
  gameVersion: string;
  loader: string;
  /** Alphas may fill gaps; betas always may. Shared as pre=1. */
  allowAlpha: boolean;
}

/** What a shared link asks for: ?c=<collection>&v=<version>&l=<loader>&pre=1 */
export function readShareUrl(): ShareState {
  const params = new URLSearchParams(location.search);
  return {
    collection: params.get("c") ?? "",
    gameVersion: params.get("v") ?? "",
    loader: params.get("l") ?? "",
    allowAlpha: params.get("pre") === "1",
  };
}

/** Keep the address bar shareable: it always reopens the current setup. */
export function useShareUrl(state: ShareState | null) {
  const query = state
    ? new URLSearchParams({
        c: state.collection,
        ...(state.gameVersion && { v: state.gameVersion }),
        ...(state.loader && { l: state.loader }),
        ...(state.allowAlpha && { pre: "1" }),
      }).toString()
    : "";
  useEffect(() => {
    history.replaceState(null, "", query ? `?${query}` : location.pathname);
  }, [query]);
}
