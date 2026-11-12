import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AiChip, Button, Chip, DemoChip, Fold, FsArea, Table } from "@/app/components/fs-ui";
import { OwnerShell, PhoneShell, SandboxStrip } from "@/app/components/fs-shell";
import { Toast } from "@/app/components/fs-toast";

describe("shared design components", () => {
  it("renders a collapsible section closed by default with its key value in the header", () => {
    const html = renderToStaticMarkup(h(Fold, { title: "Create a shift", keyValue: "R270.00", children: h("form", { action: "/x" }, h("input", { type: "hidden", name: "id", value: "1" })) }));
    expect(html).toContain('<details class="fold">');
    expect(html).not.toContain(" open");
    expect(html).toMatch(/<summary>.*Create a shift.*R270\.00.*<\/summary>/);
    expect(html).toContain('name="id"');
    expect(renderToStaticMarkup(h(Fold, { title: "T", open: true, children: "x" }))).toContain("open");
  });

  it("keeps button types explicit and chips labelled", () => {
    expect(renderToStaticMarkup(h(Button, null, "Edit"))).toBe('<button type="button" class="btn">Edit</button>');
    expect(renderToStaticMarkup(h(Button, { type: "submit", variant: "out", size: "sm" }, "Send"))).toBe('<button type="submit" class="btn out sm">Send</button>');
    expect(renderToStaticMarkup(h(AiChip))).toBe('<span class="chip ai">AI</span>');
    expect(renderToStaticMarkup(h(DemoChip))).toBe('<span class="chip demo">Demo</span>');
    expect(renderToStaticMarkup(h(Chip, { tone: "held" }, "Held"))).toBe('<span class="chip held">Held</span>');
  });

  it("scopes the design styles and frames", () => {
    expect(renderToStaticMarkup(h(FsArea, null, "x"))).toBe('<div class="fs">x</div>');
    expect(renderToStaticMarkup(h(Table, null, h("tbody")))).toContain('<div class="scroll"><table class="tbl">');
    expect(renderToStaticMarkup(h(SandboxStrip, { detail: "Business" }))).toContain("PayPal Sandbox. No real money moves.");
    const owner = renderToStaticMarkup(h(OwnerShell, { label: "Owner", home: "/owner", primary: [{ label: "Pay", href: "/manager/review", count: 2, current: true }], children: "body" }));
    expect(owner).toContain('aria-current="page"');
    expect(owner).toContain('<span class="count">2</span>');
    const phone = renderToStaticMarkup(h(PhoneShell, { label: "Worker", tabs: [{ label: "Home", href: "/worker", current: true }], children: "body" }));
    expect(phone).toContain('class="fs phone"');
  });

  it("renders a toast only when there is a message", () => {
    expect(renderToStaticMarkup(h(Toast, { message: null }))).toBe("");
    expect(renderToStaticMarkup(h(Toast, { message: "Saved" }))).toContain('role="status"');
  });
});
