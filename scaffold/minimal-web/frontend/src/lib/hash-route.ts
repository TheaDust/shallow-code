import { useSyncExternalStore } from "react";

const NAVIGATION_EVENT = "shallowcode:navigation";

export interface HashLocation {
  path: string;
  search: URLSearchParams;
}

export function parseHashLocation(hash: string): HashLocation {
  const raw = hash.replace(/^#/, "") || "/";
  const url = new URL(raw.startsWith("/") ? raw : `/${raw}`, "http://local");
  return { path: url.pathname, search: url.searchParams };
}

export function makeHash(path: string, search?: URLSearchParams): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const query = search?.toString();
  return `#${normalized}${query ? `?${query}` : ""}`;
}

export function navigate(path: string, search?: URLSearchParams): void {
  window.location.hash = makeHash(path, search);
  // Native hashchange is queued. Notify React in the same interaction task so
  // the next page is observable immediately after a click.
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

function subscribe(listener: () => void): () => void {
  const navigateHashLink = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
    const href = anchor.getAttribute("href");
    if (!href?.startsWith("#/")) return;
    event.preventDefault();
    const location = parseHashLocation(href);
    navigate(location.path, location.search);
  };

  window.addEventListener("hashchange", listener);
  window.addEventListener(NAVIGATION_EVENT, listener);
  document.addEventListener("click", navigateHashLink);
  return () => {
    window.removeEventListener("hashchange", listener);
    window.removeEventListener(NAVIGATION_EVENT, listener);
    document.removeEventListener("click", navigateHashLink);
  };
}

function snapshot(): string {
  return window.location.hash;
}

export function useHashLocation(): HashLocation {
  return parseHashLocation(useSyncExternalStore(subscribe, snapshot, () => "#/"));
}
