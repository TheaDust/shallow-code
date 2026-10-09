export interface ToastMessage {
  id: string;
  message: string;
  tone?: "info" | "success" | "error";
  dismissLabel?: string;
}

export interface ToastRegionProps {
  label?: string;
  messages: readonly ToastMessage[];
  onDismiss?(id: string): void;
}

export function ToastRegion({ label = "Notifications", messages, onDismiss }: ToastRegionProps) {
  return (
    <section className="ui-toasts" aria-label={label} aria-live="polite" aria-relevant="additions text">
      {messages.map((message) => (
        <div key={message.id} className="ui-toast" data-tone={message.tone ?? "info"} role={message.tone === "error" ? "alert" : "status"}>
          <span>{message.message}</span>
          {onDismiss ? <button type="button" aria-label={message.dismissLabel ?? `Dismiss ${message.message}`} onClick={() => onDismiss(message.id)}>×</button> : null}
        </div>
      ))}
    </section>
  );
}
