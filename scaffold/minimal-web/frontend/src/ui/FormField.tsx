import type { ReactNode } from "react";

export interface FormFieldProps {
  id: string;
  label: string;
  children: ReactNode;
  description?: string;
  error?: string;
  required?: boolean;
}

export function FormField({ id, label, children, description, error, required }: FormFieldProps) {
  return (
    <div className="ui-field" data-invalid={Boolean(error) || undefined}>
      <label htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>
      {children}
      {description ? <p id={`${id}-description`} className="ui-field__description">{description}</p> : null}
      {error ? <p id={`${id}-error`} className="ui-field__error" role="alert">{error}</p> : null}
    </div>
  );
}

export function fieldDescriptionIds(id: string, options: { description?: boolean; error?: boolean }): string | undefined {
  const ids = [options.description ? `${id}-description` : undefined, options.error ? `${id}-error` : undefined].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}
