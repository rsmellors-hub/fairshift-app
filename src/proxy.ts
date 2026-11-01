import { NextResponse, type NextRequest } from "next/server";
import { REQUEST_METHOD_HEADER } from "@/lib/request-method";

// Tells server code the real HTTP method, because a server action can arrive as a plain form
// POST without its usual header. Whatever a client sends in this header is overwritten here.
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(REQUEST_METHOD_HEADER, request.method);
  return NextResponse.next({ request: { headers } });
}

// API routes are left alone so webhook bodies and signatures pass through untouched.
export const config = { matcher: "/((?!api|_next/static|_next/image|favicon.ico).*)" };
