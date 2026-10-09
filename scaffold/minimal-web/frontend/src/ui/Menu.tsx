import { useEffect, useId, useRef, useState } from "react";
import { Button, type ButtonProps } from "./Button";

export interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  tone?: "default" | "danger";
  onSelect(): void;
}

export interface MenuProps {
  triggerLabel: string;
  items: readonly MenuItem[];
  menuLabel?: string;
  buttonVariant?: ButtonProps["variant"];
}

export function Menu({ triggerLabel, menuLabel = triggerLabel, items, buttonVariant = "secondary" }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const openingFocus = useRef(0);
  const menuId = useId();

  const focusItem = (index: number) => {
    const enabled = items.map((item, itemIndex) => ({ item, itemIndex })).filter(({ item }) => !item.disabled);
    if (!enabled.length) return;
    const normalized = (index + enabled.length) % enabled.length;
    itemRefs.current[enabled[normalized].itemIndex]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    const enabled = itemRefs.current.filter(item => item && !item.disabled);
    (openingFocus.current === -1 ? enabled.at(-1) : enabled[0])?.focus();
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  return (
    <div className="ui-menu" ref={rootRef}>
      <Button
        ref={triggerRef}
        variant={buttonVariant}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          openingFocus.current = 0;
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openingFocus.current = event.key === "ArrowDown" ? 0 : -1;
            if (open) focusItem(openingFocus.current);
            else setOpen(true);
          }
        }}
      >
        {triggerLabel}
      </Button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={menuLabel}
          className="ui-menu__content"
          onKeyDown={(event) => {
            const enabledIndexes = items.map((item, index) => item.disabled ? -1 : index).filter((index) => index >= 0);
            const current = enabledIndexes.indexOf(itemRefs.current.findIndex((node) => node === document.activeElement));
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              focusItem(current + (event.key === "ArrowDown" ? 1 : -1));
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              focusItem(event.key === "Home" ? 0 : -1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => { itemRefs.current[index] = node; }}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className="ui-menu__item"
              data-tone={item.tone ?? "default"}
              tabIndex={-1}
              onClick={() => {
                item.onSelect();
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
