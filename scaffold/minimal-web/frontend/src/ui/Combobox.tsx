import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type SelectHTMLAttributes,
} from "react";

export interface ComboboxOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface ComboboxProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children" | "multiple" | "size"> {
  label: string;
  options: readonly ComboboxOption[];
}

/**
 * A native select with a DOM-visible option surface while it is activated.
 *
 * The select remains the canonical form control, so browser `selectOption`
 * and ordinary form submission work. Activating it also exposes one visible
 * listbox whose options can be clicked by role-based browser flows. Native
 * option nodes stay out of role/text queries to avoid duplicate matches.
 */
export function Combobox({
  id,
  label,
  options,
  className = "",
  value,
  defaultValue,
  disabled = false,
  onChange,
  ...selectProps
}: ComboboxProps) {
  const generatedId = useId();
  const controlId = id ?? `combobox-${generatedId}`;
  const listboxId = `${controlId}-listbox`;
  const controlled = value !== undefined;
  const initialValue = String(defaultValue ?? options.find((option) => !option.disabled)?.value ?? "");
  const [uncontrolledValue, setUncontrolledValue] = useState(initialValue);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const selectedValue = String(controlled ? value ?? "" : uncontrolledValue);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    if (!controlled) setUncontrolledValue(event.currentTarget.value);
    onChange?.(event);
    setOpen(false);
  };

  const choose = (option: ComboboxOption) => {
    if (option.disabled || !selectRef.current) return;
    selectRef.current.value = option.value;
    selectRef.current.dispatchEvent(new Event("input", { bubbles: true }));
    selectRef.current.dispatchEvent(new Event("change", { bubbles: true }));
    setOpen(false);
    selectRef.current.focus();
  };

  return (
    <div className="ui-combobox" ref={rootRef} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <label htmlFor={controlId}>{label}</label>
      <select
        {...selectProps}
        id={controlId}
        ref={selectRef}
        className={["ui-combobox__control", className].filter(Boolean).join(" ")}
        disabled={disabled}
        value={selectedValue}
        aria-expanded={open}
        aria-controls={listboxId}
        onChange={handleChange}
        onClick={() => {
          if (!disabled) setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          else if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") setOpen(true);
        }}
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            label={option.label}
            disabled={option.disabled}
            aria-hidden="true"
          >{`\u2060`}</option>
        ))}
      </select>
      {open ? (
        <div id={listboxId} role="listbox" aria-label={label} className="ui-combobox__listbox">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              className="ui-combobox__option"
              aria-selected={option.value === selectedValue}
              aria-disabled={option.disabled || undefined}
              disabled={option.disabled}
              onClick={() => choose(option)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
