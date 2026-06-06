/**
 * Cloudflare Turnstile server-side verification.
 * If TURNSTILE_SECRET_KEY is unset (e.g. local dev), verification is skipped
 * so the app still works without bot protection configured.
 */
export async function verifyTurnstile(token: string | undefined, ip?: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not configured → allow
  if (!token) return false;

  const form = new URLSearchParams();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
      cache: "no-store",
    });
    const data = (await res.json()) as { success?: boolean };
    return !!data.success;
  } catch {
    return false;
  }
}

/** Best-effort client IP from proxy headers. */
export function clientIp(request: Request): string | undefined {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
}
