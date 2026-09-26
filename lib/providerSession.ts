// The demo has no login. The current provider is remembered in a cookie set at signup, by /demo, or when
// a provider page is opened. Client-side helpers only.

const KEY = "ss_provider";

export function rememberProvider(id: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${KEY}=${encodeURIComponent(id)}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
}

export function currentProvider(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp(`(?:^|; )${KEY}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export function forgetProvider() {
  if (typeof document === "undefined") return;
  document.cookie = `${KEY}=; path=/; max-age=0`;
}
