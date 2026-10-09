import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { makeHash, navigate, parseHashLocation, useHashLocation } from "./hash-route";

describe("hash route utilities", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    document.body.replaceChildren();
  });

  it("normalizes an empty location to the root", () => {
    expect(parseHashLocation("").path).toBe("/");
  });

  it("preserves a stable path and query", () => {
    const location = parseHashLocation("#/items/42?tab=activity");
    expect(location.path).toBe("/items/42");
    expect(location.search.get("tab")).toBe("activity");
    expect(makeHash(location.path, location.search)).toBe("#/items/42?tab=activity");
  });

  it("publishes programmatic navigation synchronously", () => {
    const route = renderHook(() => useHashLocation());
    act(() => navigate("/settings", new URLSearchParams({ tab: "security" })));
    expect(route.result.current.path).toBe("/settings");
    expect(route.result.current.search.get("tab")).toBe("security");
  });

  it("completes an ordinary internal hash-link navigation before the link can unmount", () => {
    const route = renderHook(() => useHashLocation());
    const link = document.createElement("a");
    link.href = "#/organizations/acme?tab=teams";
    link.textContent = "Open";
    link.addEventListener("click", () => link.remove());
    document.body.append(link);

    fireEvent.click(link);

    expect(route.result.current.path).toBe("/organizations/acme");
    expect(route.result.current.search.get("tab")).toBe("teams");
  });
});
