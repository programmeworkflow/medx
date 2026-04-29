// Utilitários de formatação CNPJ/CPF.
// Auto-detecta pelo número de dígitos: 14 → CNPJ, 11 → CPF.

export function onlyDigits(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

export type DocumentoTipo = "CNPJ" | "CPF" | "INVALIDO";

export function detectDocumentoTipo(value: string | null | undefined): DocumentoTipo {
  const d = onlyDigits(value);
  if (d.length === 14) return "CNPJ";
  if (d.length === 11) return "CPF";
  return "INVALIDO";
}

// Formata pra exibição. Se inválido, retorna o valor cru com dígitos só.
export function formatCnpjCpf(value: string | null | undefined): string {
  const d = onlyDigits(value);
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  if (d.length === 11) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  return d;
}

// Máscara progressiva pra inputs — formata enquanto digita.
// Aceita até 14 dígitos. Decide layout pelo tamanho (>11 = CNPJ).
export function maskCnpjCpf(value: string): string {
  const d = onlyDigits(value).slice(0, 14);
  if (d.length <= 11) {
    // CPF format: 000.000.000-00
    if (d.length <= 3) return d;
    if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
    if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  // CNPJ format: 00.000.000/0000-00
  if (d.length <= 2) return d;
  if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
  if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
  if (d.length <= 12) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}
