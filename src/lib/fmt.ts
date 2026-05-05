// Helpers centrais de formatação. Sempre que precisar exibir valor monetário,
// data, CNPJ, percentual, etc — use estes helpers. Garante consistência visual.
//
// Uso:
//   import { fmt } from "@/lib/fmt";
//   fmt.money(1234.5)       → "R$ 1.234,50"
//   fmt.date("2026-05-04")  → "04/05/2026"
//   fmt.cnpj("12345678000190") → "12.345.678/0001-90"

import { formatCnpjCpf } from "./format";

const BR = "pt-BR";

function toDate(d: Date | string | null | undefined): Date | null {
  if (!d) return null;
  if (d instanceof Date) return d;
  // Aceita "YYYY-MM-DD" e ISO completo
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return new Date(d + "T12:00:00");
  const parsed = new Date(d);
  return isNaN(parsed.getTime()) ? null : parsed;
}

export const fmt = {
  /** R$ 1.234,56 — sempre 2 decimais. Aceita string/number/null. */
  money(v: number | string | null | undefined, opts?: { compact?: boolean }): string {
    const n = typeof v === "string" ? parseFloat(v.replace(/\./g, "").replace(",", ".")) : Number(v);
    if (!isFinite(n)) return "—";
    if (opts?.compact && Math.abs(n) >= 1000) {
      return n.toLocaleString(BR, { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1 });
    }
    return n.toLocaleString(BR, { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  /** 1.234,56 — número sem prefixo de moeda. */
  number(v: number | string | null | undefined, decimals = 0): string {
    const n = typeof v === "string" ? parseFloat(v.replace(/\./g, "").replace(",", ".")) : Number(v);
    if (!isFinite(n)) return "—";
    return n.toLocaleString(BR, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  },

  /** 04/05/2026 */
  date(d: Date | string | null | undefined): string {
    const dt = toDate(d);
    return dt ? dt.toLocaleDateString(BR) : "—";
  },

  /** 4 de maio de 2026 */
  dateLong(d: Date | string | null | undefined): string {
    const dt = toDate(d);
    return dt ? dt.toLocaleDateString(BR, { day: "numeric", month: "long", year: "numeric" }) : "—";
  },

  /** 04/05/2026 14:30 */
  dateTime(d: Date | string | null | undefined): string {
    const dt = toDate(d);
    return dt ? dt.toLocaleString(BR, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  },

  /** "há 3 dias" / "em 2 horas" / "agora" */
  relative(d: Date | string | null | undefined, base: Date = new Date()): string {
    const dt = toDate(d);
    if (!dt) return "—";
    const diffMs = dt.getTime() - base.getTime();
    const abs = Math.abs(diffMs);
    const seconds = Math.floor(abs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const future = diffMs > 0;
    if (seconds < 60) return "agora";
    if (minutes < 60) return future ? `em ${minutes}min` : `há ${minutes}min`;
    if (hours < 24) return future ? `em ${hours}h` : `há ${hours}h`;
    if (days === 1) return future ? "amanhã" : "ontem";
    if (days < 7) return future ? `em ${days} dias` : `há ${days} dias`;
    return fmt.date(dt);
  },

  /** 12.345.678/0001-90 (CNPJ) ou 123.456.789-00 (CPF) */
  cnpj: formatCnpjCpf,
  cpf: formatCnpjCpf,
  doc: formatCnpjCpf,

  /** 12,5% — aceita 0..1 (default) ou 0..100 (whole=true) */
  percent(v: number | null | undefined, opts?: { decimals?: number; whole?: boolean }): string {
    if (v == null || !isFinite(Number(v))) return "—";
    const n = opts?.whole ? Number(v) / 100 : Number(v);
    return n.toLocaleString(BR, { style: "percent", minimumFractionDigits: opts?.decimals ?? 1, maximumFractionDigits: opts?.decimals ?? 1 });
  },

  /** 1.2 MB */
  bytes(b: number | null | undefined): string {
    if (b == null || !isFinite(Number(b))) return "—";
    const n = Number(b);
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  },

  /** Telefone BR — (16) 99185-5127 ou (11) 1234-5678 */
  phone(v: string | null | undefined): string {
    const d = String(v ?? "").replace(/\D/g, "");
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return d || "—";
  },

  /** Trunca string com elipse — "Texto longo..." */
  truncate(s: string | null | undefined, max = 40): string {
    const str = String(s ?? "");
    if (str.length <= max) return str;
    return str.slice(0, max - 1).trimEnd() + "…";
  },
};
