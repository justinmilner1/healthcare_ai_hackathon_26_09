// Email via Resend's HTTP API. No SDK needed. Owner: Justin.
// If RESEND_API_KEY is unset, sendEmail() returns { sent: false } and the UI shows the link instead.
// Resend's free tier sends from onboarding@resend.dev to the account owner's address without domain setup.

export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<{ sent: boolean; error?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, error: "Resend not configured" };
  const from = process.env.EMAIL_FROM ?? "Sweet Spot <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text, html: html ?? `<pre style="font-family:sans-serif">${escapeHtml(text)}</pre>` }),
    });
    if (!res.ok) return { sent: false, error: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
