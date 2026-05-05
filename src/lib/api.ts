import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type Empresa = Database["public"]["Tables"]["empresas"]["Row"];
export type EmpresaInsert = Database["public"]["Tables"]["empresas"]["Insert"];
export type Competencia = Database["public"]["Tables"]["competencias"]["Row"];
export type CompetenciaInsert = Database["public"]["Tables"]["competencias"]["Insert"];
export type Faturamento = Database["public"]["Tables"]["faturamentos"]["Row"];
export type FaturamentoInsert = Database["public"]["Tables"]["faturamentos"]["Insert"];

export type Credenciada = Database["public"]["Tables"]["credenciadas"]["Row"];
export type CredenciadaInsert = Database["public"]["Tables"]["credenciadas"]["Insert"];
export type CredenciadaUpdate = Database["public"]["Tables"]["credenciadas"]["Update"];

export type Treinamento = Database["public"]["Tables"]["treinamentos"]["Row"];
export type TreinamentoInsert = Database["public"]["Tables"]["treinamentos"]["Insert"];
export type TreinamentoUpdate = Database["public"]["Tables"]["treinamentos"]["Update"];

export type Categoria = Database["public"]["Enums"]["categoria_empresa"];
export type TipoFaturamento = Database["public"]["Enums"]["tipo_faturamento"];
export type StatusFaturamento = Database["public"]["Enums"]["status_faturamento"];
export type StatusCompetencia = Database["public"]["Enums"]["status_competencia"];
export type ModalidadeTreinamento = Database["public"]["Enums"]["modalidade_treinamento"];

export const COMISSAO_TREINAMENTO = 0.07; // 7% fixo

export const CATEGORIA_LABELS: Record<Categoria, string> = {
  medwork: "MedWork",
  medwork_porto: "MedWork Porto",
  avista: "À Vista",
  especial: "Especial",
  credenciada: "Credenciada",
  mensalidade: "Mensalidade",
  labore: "Labore",
};

export const STATUS_LABELS: Record<StatusFaturamento, string> = {
  pendente: "Pendente",
  aguardando_oc: "Aguardando OC",
  conferencia: "Conferência",
  faturado: "Faturado",
  pago_avista: "Pago à Vista",
  concluido: "Concluído",
  sem_cadastro: "Não possui cadastro",
  ca_error: "Erro CA",
};

export const STATUS_COLORS: Record<StatusFaturamento, string> = {
  pendente: "bg-warning/20 text-warning",
  aguardando_oc: "bg-warning/20 text-warning",
  conferencia: "bg-info/20 text-info",
  faturado: "bg-primary/20 text-primary",
  pago_avista: "bg-success/20 text-success",
  concluido: "bg-success text-white",
  sem_cadastro: "bg-destructive/20 text-destructive",
  ca_error: "bg-destructive text-white",
};

export const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

// API functions
export async function fetchEmpresas() {
  const { data, error } = await supabase.from("empresas").select("*").order("nome_empresa");
  if (error) throw error;
  return data;
}

export async function insertEmpresa(empresa: EmpresaInsert) {
  const { data, error } = await supabase.from("empresas").insert(empresa).select().single();
  if (error) throw error;
  return data;
}

export async function insertEmpresasBulk(empresas: EmpresaInsert[]) {
  const { data, error } = await supabase.from("empresas").insert(empresas).select();
  if (error) throw error;
  return data;
}

export async function fetchCompetencias() {
  const { data, error } = await supabase.from("competencias").select("*").order("ano", { ascending: false }).order("mes", { ascending: false });
  if (error) throw error;
  return data;
}

export async function insertCompetencia(comp: CompetenciaInsert) {
  const { data, error } = await supabase.from("competencias").insert(comp).select().single();
  if (error) throw error;
  return data;
}

export async function fetchFaturamentos(competenciaId: string) {
  const { data, error } = await supabase
    .from("faturamentos")
    .select("*, empresa_executora:empresas!faturamentos_empresa_executora_id_fkey(*), empresa_faturadora:empresas!faturamentos_empresa_faturadora_id_fkey(*)")
    .eq("competencia_id", competenciaId);
  if (error) throw error;
  return data;
}

export async function updateFaturamentoStatus(id: string, status: StatusFaturamento) {
  const { error } = await supabase.from("faturamentos").update({ status }).eq("id", id);
  if (error) throw error;
}

export async function insertFaturamento(fat: FaturamentoInsert) {
  const { data, error } = await supabase.from("faturamentos").insert(fat).select().single();
  if (error) throw error;
  return data;
}

export async function updateEmpresa(id: string, updates: Partial<EmpresaInsert>) {
  const { error } = await supabase.from("empresas").update(updates).eq("id", id);
  if (error) throw error;
}

export async function deleteEmpresa(id: string) {
  const { error } = await supabase.from("empresas").delete().eq("id", id);
  if (error) throw error;
}

// Mescla uma empresa duplicada na empresa "manter": move TODOS os dados
// vinculados (faturamentos, treinamentos, empresas que faturam por ela) e
// só depois exclui o registro duplicado. Preserva histórico.
export async function mergeEmpresaDuplicate(keepId: string, duplicateId: string) {
  // 1. Move faturamentos onde a duplicata é executora
  const r1 = await supabase
    .from("faturamentos")
    .update({ empresa_executora_id: keepId })
    .eq("empresa_executora_id", duplicateId);
  if (r1.error) throw new Error(`faturamentos.executora: ${r1.error.message}`);

  // 2. Move faturamentos onde a duplicata é faturadora
  const r2 = await supabase
    .from("faturamentos")
    .update({ empresa_faturadora_id: keepId })
    .eq("empresa_faturadora_id", duplicateId);
  if (r2.error) throw new Error(`faturamentos.faturadora: ${r2.error.message}`);

  // 3. Move treinamentos vinculados
  const r3 = await supabase
    .from("treinamentos")
    .update({ empresa_id: keepId })
    .eq("empresa_id", duplicateId);
  if (r3.error) throw new Error(`treinamentos: ${r3.error.message}`);

  // 4. Move qualquer outra empresa que tenha a duplicata como faturadora
  const r4 = await supabase
    .from("empresas")
    .update({ empresa_faturadora_id: keepId })
    .eq("empresa_faturadora_id", duplicateId);
  if (r4.error) throw new Error(`empresas.faturadora: ${r4.error.message}`);

  // 5. Agora pode excluir o cadastro duplicado vazio
  const r5 = await supabase.from("empresas").delete().eq("id", duplicateId);
  if (r5.error) throw new Error(`delete: ${r5.error.message}`);
}

export type FaturamentoUpdate = Database["public"]["Tables"]["faturamentos"]["Update"];

export async function updateFaturamento(id: string, updates: FaturamentoUpdate) {
  const { error } = await supabase.from("faturamentos").update(updates).eq("id", id);
  if (error) throw error;
}

export async function deleteFaturamento(id: string) {
  const { error } = await supabase.from("faturamentos").delete().eq("id", id);
  if (error) throw error;
}

export async function deleteManyFaturamentos(ids: string[]) {
  if (ids.length === 0) return 0;
  const { error, count } = await supabase
    .from("faturamentos")
    .delete({ count: "exact" })
    .in("id", ids);
  if (error) throw error;
  return count ?? ids.length;
}

// ─────────────────────────────────────────────────────────────────────
// Credenciadas
// ─────────────────────────────────────────────────────────────────────
export async function fetchCredenciadas() {
  const { data, error } = await supabase.from("credenciadas").select("*").order("nome");
  if (error) throw error;
  return data;
}

export async function insertCredenciada(cred: CredenciadaInsert) {
  const { data, error } = await supabase.from("credenciadas").insert(cred).select().single();
  if (error) throw error;
  return data;
}

export async function updateCredenciada(id: string, updates: CredenciadaUpdate) {
  const { error } = await supabase.from("credenciadas").update(updates).eq("id", id);
  if (error) throw error;
}

export async function deleteCredenciada(id: string) {
  const { error } = await supabase.from("credenciadas").delete().eq("id", id);
  if (error) throw error;
}

/** Upload a file to a storage bucket and return the stored path. */
export async function uploadCredenciadaFile(
  bucket: "contratos-credenciadas" | "tabelas-preco",
  credenciadaId: string,
  file: File
): Promise<string> {
  const ext = file.name.split(".").pop() || "bin";
  const path = `${credenciadaId}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    upsert: true,
    cacheControl: "3600",
  });
  if (error) throw error;
  return path;
}

/** Get a signed URL to view a file from a private bucket. */
export async function getCredenciadaFileUrl(
  bucket: "contratos-credenciadas" | "tabelas-preco",
  path: string
): Promise<string> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Categoriza o tempo de contrato de uma credenciada em relação a HOJE:
 *  - "reajuste_proximo": <= 30 dias pra completar 1 ano
 *  - "atrasado_1ano":    passou 1 ano e ainda <2 anos (precisa reajuste)
 *  - "atrasado_2anos":   >=2 anos sem atualizar
 *  - null:               sem data_contrato ou dentro do primeiro ano
 */
export function classificaReajusteCredenciada(data_contrato: string | null):
  | "reajuste_proximo"
  | "atrasado_1ano"
  | "atrasado_2anos"
  | null {
  if (!data_contrato) return null;
  const d = new Date(data_contrato);
  const hoje = new Date();
  const diffDias = Math.floor((hoje.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  const diasPrimeiroAniv = 365 - diffDias;
  if (diffDias >= 730) return "atrasado_2anos";
  if (diffDias >= 365) return "atrasado_1ano";
  if (diasPrimeiroAniv >= 0 && diasPrimeiroAniv <= 30) return "reajuste_proximo";
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Treinamentos
// ─────────────────────────────────────────────────────────────────────
export async function fetchTreinamentos() {
  const { data, error } = await supabase
    .from("treinamentos")
    .select("*, empresa:empresas!treinamentos_empresa_id_fkey(id, nome_empresa, cnpj)")
    .order("data_treinamento", { ascending: false });
  if (error) throw error;
  return data;
}

export async function insertTreinamento(t: TreinamentoInsert) {
  const { data, error } = await supabase.from("treinamentos").insert(t).select().single();
  if (error) throw error;
  return data;
}

export async function updateTreinamento(id: string, updates: TreinamentoUpdate) {
  const { error } = await supabase.from("treinamentos").update(updates).eq("id", id);
  if (error) throw error;
}

export async function deleteTreinamento(id: string) {
  const { error } = await supabase.from("treinamentos").delete().eq("id", id);
  if (error) throw error;
}

// ────────────────────────────────────────────────────────────────────────────
// Retenção fiscal — cálculo automático por categoria/valor
// ────────────────────────────────────────────────────────────────────────────
export type RetencaoPadrao =
  | "nenhuma"
  | "federal"          // CSLL + PIS + COFINS + IRRF (se valor > 666,67)
  | "iss"              // ISS apenas
  | "federal_iss"      // tudo
  | "credenciada_auto"; // regra automática por valor (215, 666,67)

export interface RetencaoCalculada {
  irrf: boolean;
  csll: boolean;
  pis: boolean;
  cofins: boolean;
  iss: boolean;
  // alíquotas
  irrf_pct: number;
  csll_pct: number;
  pis_pct: number;
  cofins_pct: number;
  iss_pct: number;
  // valores em reais
  irrf_valor: number;
  csll_valor: number;
  pis_valor: number;
  cofins_valor: number;
  iss_valor: number;
  total_retido: number;
  valor_liquido: number;
}

export const ALIQUOTAS = {
  irrf: 0.015,    // 1,5%
  csll: 0.01,     // 1%
  pis: 0.0065,    // 0,65%
  cofins: 0.03,   // 3%
  iss: 0.05,      // 5%
};

export function calcularRetencao(
  categoria: string | null | undefined,
  valor: number,
  retencaoPadrao: RetencaoPadrao = "nenhuma"
): RetencaoCalculada {
  let aplicaIrrf = false;
  let aplicaCsll = false;
  let aplicaPis = false;
  let aplicaCofins = false;
  let aplicaIss = false;

  // Credenciada: regra automática (Lei 10.833/03 piso R$ 215; IRRF piso R$ 10)
  if (categoria === "credenciada" || retencaoPadrao === "credenciada_auto") {
    if (valor > 215) {
      aplicaCsll = true;
      aplicaPis = true;
      aplicaCofins = true;
      // IRRF só se o valor retido for > R$ 10 → valor > 666,67
      if (valor * ALIQUOTAS.irrf > 10) aplicaIrrf = true;
    }
  } else {
    // Outras categorias: aplica conforme retencao_padrao do cadastro
    const aplicaFederal = retencaoPadrao === "federal" || retencaoPadrao === "federal_iss";
    const aplicaIssFlag = retencaoPadrao === "iss" || retencaoPadrao === "federal_iss";
    if (aplicaFederal) {
      aplicaCsll = true;
      aplicaPis = true;
      aplicaCofins = true;
      if (valor * ALIQUOTAS.irrf > 10) aplicaIrrf = true;
    }
    if (aplicaIssFlag) aplicaIss = true;
  }

  const irrf_valor = aplicaIrrf ? valor * ALIQUOTAS.irrf : 0;
  const csll_valor = aplicaCsll ? valor * ALIQUOTAS.csll : 0;
  const pis_valor = aplicaPis ? valor * ALIQUOTAS.pis : 0;
  const cofins_valor = aplicaCofins ? valor * ALIQUOTAS.cofins : 0;
  const iss_valor = aplicaIss ? valor * ALIQUOTAS.iss : 0;
  const total_retido = irrf_valor + csll_valor + pis_valor + cofins_valor + iss_valor;

  return {
    irrf: aplicaIrrf,
    csll: aplicaCsll,
    pis: aplicaPis,
    cofins: aplicaCofins,
    iss: aplicaIss,
    irrf_pct: ALIQUOTAS.irrf,
    csll_pct: ALIQUOTAS.csll,
    pis_pct: ALIQUOTAS.pis,
    cofins_pct: ALIQUOTAS.cofins,
    iss_pct: ALIQUOTAS.iss,
    irrf_valor: round2(irrf_valor),
    csll_valor: round2(csll_valor),
    pis_valor: round2(pis_valor),
    cofins_valor: round2(cofins_valor),
    iss_valor: round2(iss_valor),
    total_retido: round2(total_retido),
    valor_liquido: round2(valor - total_retido),
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export const RETENCAO_LABELS: Record<RetencaoPadrao, string> = {
  nenhuma: "Nenhuma",
  federal: "Só Federal (CSLL+PIS+COFINS, IRRF se ≥ R$ 666,67)",
  iss: "Só ISS (5%)",
  federal_iss: "Federal + ISS",
  credenciada_auto: "Credenciada (automático por valor)",
};
