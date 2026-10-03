const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Tiny {{var}} templating. Values are HTML-escaped in html, raw in plain text/subject. */
export function renderTemplate(t: string, vars: Record<string, string | null | undefined>, html = false) {
  return t.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => {
    const v = vars[k] ?? "";
    return html ? esc(v) : v;
  });
}
