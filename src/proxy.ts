import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Protects /admin with HTTP Basic Auth. Set ADMIN_PASSWORD (and optionally
// ADMIN_USER, default "admin") in the environment. Fails closed if unset.
export function proxy(request: NextRequest) {
  const pass = process.env.ADMIN_PASSWORD;
  const user = process.env.ADMIN_USER ?? "admin";

  if (!pass) {
    return new NextResponse("Admin is not configured.", { status: 503 });
  }

  const header = request.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const sep = decoded.indexOf(":");
      const u = decoded.slice(0, sep);
      const p = decoded.slice(sep + 1);
      if (u === user && p === pass) return NextResponse.next();
    } catch {
      /* fall through to 401 */
    }
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Admin", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
