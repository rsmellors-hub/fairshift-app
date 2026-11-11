import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ErrorPage from "@/app/error";
import GlobalError from "@/app/global-error";
import NotFound from "@/app/not-found";

const failure = Object.assign(new Error("connect ECONNREFUSED postgres://user:secret@db"), { digest: "abc123" });

describe("error pages", () => {
  it("offers a retry and a reference without exposing the error message", () => {
    const html = renderToStaticMarkup(createElement(ErrorPage, { error: failure, reset: () => {} }));
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Try again");
    expect(html).toContain("abc123");
    expect(html).not.toContain("secret");
    expect(html).not.toContain("ECONNREFUSED");
  });

  it("renders its own document when the root layout fails", () => {
    const html = renderToStaticMarkup(createElement(GlobalError, { error: failure, reset: () => {} }));
    expect(html).toContain("<html lang=\"en\">");
    expect(html).toContain("<body>");
    expect(html).toContain("Try again");
    expect(html).not.toContain("secret");
  });

  it("says a missing page was not found and links home", () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain("Page not found");
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/sign-in"');
  });
});
