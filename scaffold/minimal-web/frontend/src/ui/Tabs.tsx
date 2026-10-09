import { useId, type ReactNode } from "react";

export interface TabItem {
  id: string;
  label: string;
  panel: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  label: string;
  items: readonly TabItem[];
  activeId: string;
  onChange(id: string): void;
}

export function Tabs({ label, items, activeId, onChange }: TabsProps) {
  const prefix = useId();
  const active = items.find((item) => item.id === activeId && !item.disabled) ?? items.find((item) => !item.disabled);

  const move = (from: number, direction: 1 | -1) => {
    for (let distance = 1; distance <= items.length; distance += 1) {
      const index = (from + direction * distance + items.length) % items.length;
      if (!items[index].disabled) {
        onChange(items[index].id);
        queueMicrotask(() => document.getElementById(`${prefix}-tab-${items[index].id}`)?.focus());
        return;
      }
    }
  };

  return (
    <div className="ui-tabs">
      <div role="tablist" aria-label={label} className="ui-tabs__list">
        {items.map((item, index) => (
          <button
            key={item.id}
            id={`${prefix}-tab-${item.id}`}
            type="button"
            role="tab"
            disabled={item.disabled}
            aria-selected={item.id === active?.id}
            aria-controls={`${prefix}-panel-${item.id}`}
            tabIndex={item.id === active?.id ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                move(index, event.key === "ArrowRight" ? 1 : -1);
              }
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {active ? (
        <div
          id={`${prefix}-panel-${active.id}`}
          role="tabpanel"
          aria-labelledby={`${prefix}-tab-${active.id}`}
          className="ui-tabs__panel"
        >
          {active.panel}
        </div>
      ) : null}
    </div>
  );
}
