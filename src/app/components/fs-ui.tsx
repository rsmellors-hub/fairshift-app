import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

// Shared design components (design 10 Nov 2026, src/app/fairshift.css). Markup only: each one renders
// the design's classes and passes every other prop straight through, so a form keeps its action,
// field names and hidden inputs exactly as the page wrote them. They render inside an element with
// the "fs" class (FsArea, or a shell from fs-shell.tsx).

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

/** The scope that turns the design styles on for everything inside it. */
export function FsArea({ as: Tag = "div", className, ...props }: { as?: "div" | "section" | "main" | "article" } & ComponentProps<"div">) {
  return <Tag className={cx("fs", className)} {...props} />;
}

export type ButtonVariant = "primary" | "out" | "inv" | "inv-out";
export type ButtonSize = "sm" | "md" | "lg";
type ButtonLook = { variant?: ButtonVariant; size?: ButtonSize; wide?: boolean };
const buttonClass = ({ variant = "primary", size = "md", wide }: ButtonLook, extra?: string) =>
  cx("btn", variant !== "primary" && variant, size !== "md" && size, wide && "wide", extra);

/** A button. Defaults to type="button"; pass type="submit" inside a form. One primary per area. */
export function Button({ variant, size, wide, className, type = "button", ...props }: ButtonLook & ComponentProps<"button">) {
  return <button type={type} className={buttonClass({ variant, size, wide }, className)} {...props} />;
}

/** A link that looks like a button, for navigation only. */
export function ButtonLink({ variant, size, wide, className, ...props }: ButtonLook & ComponentProps<typeof Link>) {
  return <Link className={buttonClass({ variant, size, wide }, className)} {...props} />;
}

export type ChipTone = "paid" | "ok" | "held" | "info" | "bad" | "line" | "dark" | "ai" | "demo";
/** A status chip. "ai" marks AI output and "demo" marks sample data; "paid" is only for a PayPal SUCCESS. */
export function Chip({ tone = "line", className, ...props }: { tone?: ChipTone } & ComponentProps<"span">) {
  return <span className={cx("chip", tone, className)} {...props} />;
}
export const AiChip = ({ children = "AI", ...props }: ComponentProps<"span">) => <Chip tone="ai" {...props}>{children}</Chip>;
export const DemoChip = ({ children = "Demo", ...props }: ComponentProps<"span">) => <Chip tone="demo" {...props}>{children}</Chip>;

/** A white card on the paper background. */
export function Card({ as: Tag = "div", className, ...props }: { as?: "div" | "section" | "article" | "aside" } & ComponentProps<"div">) {
  return <Tag className={cx("card", className)} {...props} />;
}

/**
 * A collapsible section, closed by default, with its key value in the header so the closed state
 * still answers the main question. Nothing inside is removed: a control the design does not show
 * lives here, reachable with one click.
 */
export function Fold({ title, detail, keyValue, open = false, plain = false, id, className, children }: {
  title: ReactNode;
  detail?: ReactNode;
  keyValue?: ReactNode;
  open?: boolean;
  plain?: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return <details className={cx("fold", plain && "plain", className)} open={open || undefined} id={id}>
    <summary>
      <span className="fold-title"><span>{title}</span>{detail ? <span className="small">{detail}</span> : null}</span>
      {keyValue !== undefined && keyValue !== null ? <span className="fold-key">{keyValue}</span> : null}
    </summary>
    <div className="fold-body">{children}</div>
  </details>;
}

/** A data table with horizontal scroll on narrow screens. */
export function Table({ caption, className, children, ...props }: { caption?: ReactNode } & ComponentProps<"table">) {
  return <div className="scroll">
    <table className={cx("tbl", className)} {...props}>
      {caption ? <caption className="eyebrow" style={{ textAlign: "left", paddingBottom: 10 }}>{caption}</caption> : null}
      {children}
    </table>
  </div>;
}

/** A labelled form field: label, control, optional hint. */
export function Field({ label, hint, htmlFor, children }: { label: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return <div className="field">
    {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <label>{label}{children}</label>}
    {htmlFor ? children : null}
    {hint ? <span className="hint">{hint}</span> : null}
  </div>;
}
