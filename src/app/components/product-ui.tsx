export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}
export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "predictive" | "fact";
}) {
  return <span className={`status-badge status-badge-${tone}`}>{children}</span>;
}

export function StatePanel({
  title,
  children,
  tone = "neutral",
}: {
  title: string;
  children?: React.ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return (
    <section className={`state-panel state-panel-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <strong>{title}</strong>
      {children ? <div>{children}</div> : null}
    </section>
  );
}

export function DataLabel({
  kind,
  children,
}: {
  kind: "fact" | "predictive" | "demo";
  children: React.ReactNode;
}) {
  return <span className={`data-label data-label-${kind}`}>{children}</span>;
}
