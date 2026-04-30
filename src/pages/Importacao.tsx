import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Upload, FileSpreadsheet, CheckCircle2, AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { supabase } from "@/integrations/supabase/client";
import { fetchCompetencias, fetchEmpresas, insertCompetencia, MESES } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { onlyDigits } from "@/lib/format";

// Excel pode parsear CNPJ/CPF como number, perdendo leading zeros.
// Se o resultado tiver 10-11 dígitos paddar pra 11 (CPF), 12-14 pra 14 (CNPJ).
function normalizeCnpj(raw: string | number | null | undefined): string {
  let d = onlyDigits(String(raw ?? ""));
  if (d.length >= 12 && d.length <= 14) d = d.padStart(14, "0");
  else if (d.length >= 9 && d.length <= 11) d = d.padStart(11, "0");
  return d;
}

export default function Importacao() {
  const [file, setFile] = useState<File | null>(null);
  const [compId, setCompId] = useState("");
  const [mesSelecionado, setMesSelecionado] = useState("");
  const [anoSelecionado, setAnoSelecionado] = useState(new Date().getFullYear().toString());
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<{
    found: number;
    newCompanies: number;
    total: number;
    centavosCorrigidos?: number;
  } | null>(null);
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const { data: competencias = [] } = useQuery({
    queryKey: ["competencias"],
    queryFn: fetchCompetencias,
  });

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && (f.name.endsWith(".xlsx") || f.name.endsWith(".xls"))) setFile(f);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setFile(f);
  };

  const getOrCreateCompetencia = async (): Promise<string> => {
    if (compId) return compId;
    const mes = parseInt(mesSelecionado);
    const ano = parseInt(anoSelecionado);
    const existing = competencias.find(c => c.mes === mes && c.ano === ano);
    if (existing) return existing.id;
    const nova = await insertCompetencia({ mes, ano });
    queryClient.invalidateQueries({ queryKey: ["competencias"] });
    return nova.id;
  };

  const handleProcess = async () => {
    if (!file || (!compId && !mesSelecionado)) return;
    setProcessing(true);
    setResult(null);

    try {
      const competenciaId = await getOrCreateCompetencia();

      const data = await file.arrayBuffer();
      const wb = XLSX.read(data);
      // Find the sheet "ASOs Valores por Empregador" or fallback
      const sheetName = wb.SheetNames.find((n) =>
        n.toLowerCase().includes("aso") && n.toLowerCase().includes("valor")
      ) || wb.SheetNames.find((n) => n.toLowerCase().includes("aso")) || wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const rows: any[] = XLSX.utils.sheet_to_json(ws);

      const empresas = await fetchEmpresas();
      const empresasByCnpj = new Map(empresas.map((e) => [normalizeCnpj(e.cnpj), e]));

      // Detecta planilha do ESO pelo domínio do link de fatura — quando é ESO,
      // o "Valor Unitário*" vem como inteiro em centavos (ex: 30700 = R$ 307,00).
      const isEsoExport = rows.some((r) => {
        const link = String(r["Link"] || r["link"] || "");
        return /sistemaeso\.com\.br/i.test(link);
      });

      // Heurística adicional: se TODOS os valores numéricos forem inteiros
      // (sem casa decimal) E pelo menos um for >= 100, a planilha provavelmente
      // está em centavos — divide por 100. Cobre planilhas que não vêm do ESO
      // mas seguem o mesmo padrão (ex: exportações genéricas que serializam
      // moeda como inteiro de centavos).
      let todosInteirosNaoZero = true;
      let temGrande = false;
      let temNumero = false;
      for (const r of rows) {
        const raw = r["Valor Unitário*"] || r["Valor"] || r["valor"];
        if (raw == null || raw === "") continue;
        if (typeof raw === "number" && !isNaN(raw) && raw > 0) {
          temNumero = true;
          if (!Number.isInteger(raw)) {
            todosInteirosNaoZero = false;
            break;
          }
          if (raw >= 100) temGrande = true;
        } else if (typeof raw === "string" && raw.includes(",")) {
          // Já tem decimal explícito ("80,00") — não é centavos
          todosInteirosNaoZero = false;
          break;
        }
      }
      const looksLikeCentavos = isEsoExport || (temNumero && todosInteirosNaoZero && temGrande);

      let found = 0;
      let newCompanies = 0;
      let total = 0;
      let centavosCorrigidos = 0;

      for (const row of rows) {
        // Map columns by header name (with fallbacks for different ESO formats)
        const rawCnpj = row["Documento (CPF/CNPJ)*"] || row["Documento"] || row["CNPJ"] || row["cnpj"] || row["CNPJ/CPF"];
        const nomeEmpresa = row["Responsável*"] || row["Responsável"] || row["Empregador"] || row["Empresa"] || row["empresa"];
        const rawValor = row["Valor Unitário*"] || row["Valor"] || row["valor"] || "0";
        const valorStr = String(rawValor).trim();
        let valor = 0;
        if (typeof rawValor === "number" && !isNaN(rawValor)) {
          // Inteiros vêm em centavos quando a planilha é do ESO ou foi
          // detectada como centavos pela heurística (todos inteiros + ≥100)
          if (looksLikeCentavos && Number.isInteger(rawValor)) {
            valor = rawValor / 100;
            if (rawValor > 0) centavosCorrigidos++;
          } else {
            valor = rawValor;
          }
        } else if (valorStr.includes(",")) {
          // Brazilian format: "3.746,00" or "649,00"
          valor = parseFloat(valorStr.replace(/\./g, "").replace(",", "."));
        } else {
          valor = parseFloat(valorStr);
        }
        if (isNaN(valor)) valor = 0;
        const linkEso = row["Link"] || row["link"] || null;

        if (!rawCnpj || !nomeEmpresa) continue;

        const cnpjNorm = normalizeCnpj(rawCnpj);
        if (cnpjNorm.length < 11) continue; // skip invalid

        total++;
        const empresa = empresasByCnpj.get(cnpjNorm);

        if (empresa) {
          // Has registration - create faturamento with empresa data
          await supabase.from("faturamentos").insert({
            competencia_id: competenciaId,
            empresa_executora_id: empresa.id,
            empresa_faturadora_id: empresa.empresa_faturadora_id || empresa.id,
            categoria_snapshot: empresa.categoria,
            status: "pendente" as const,
            valor: valor || null,
            observacoes_mes: empresa.observacoes || null,
            link_relatorio_eso: linkEso,
          });
          found++;
        } else {
          // No registration - create a temporary empresa entry and mark as sem_cadastro
          const { data: novaEmpresa } = await supabase
            .from("empresas")
            .insert({
              nome_empresa: nomeEmpresa,
              cnpj: cnpjNorm,
              categoria: "medwork" as const,
              tipo_faturamento: "propria_empresa" as const,
              ativa: true,
            })
            .select()
            .single();

          if (novaEmpresa) {
            empresasByCnpj.set(cnpjNorm, novaEmpresa);
            await supabase.from("faturamentos").insert({
              competencia_id: competenciaId,
              empresa_executora_id: novaEmpresa.id,
              empresa_faturadora_id: novaEmpresa.id,
              categoria_snapshot: "medwork",
              status: "sem_cadastro" as const,
              valor: valor || null,
              link_relatorio_eso: linkEso,
            });
            newCompanies++;
          }
        }
      }

      if (user) {
        await supabase.from("importacoes_eso").insert({
          competencia_id: competenciaId,
          nome_arquivo: file.name,
          usuario_id: user.id,
        });
      }

      queryClient.invalidateQueries({ queryKey: ["faturamentos"] });
      queryClient.invalidateQueries({ queryKey: ["empresas"] });
      queryClient.invalidateQueries({ queryKey: ["competencias"] });
      setResult({ found, newCompanies, total, centavosCorrigidos });
      const msgCentavos =
        centavosCorrigidos > 0
          ? ` · ${centavosCorrigidos} valor(es) ajustado(s) de centavos pra reais`
          : "";
      toast.success(`${total} empresas processadas!${msgCentavos}`);
    } catch (err: any) {
      toast.error("Erro ao processar: " + err.message);
    } finally {
      setProcessing(false);
    }
  };

  const canProcess = file && (compId || (mesSelecionado && anoSelecionado));
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-[1.75rem] font-bold tracking-tight">Importação ESO</h1>
        <p className="text-sm text-muted-foreground">Upload da planilha do ESO para gerar faturamento mensal</p>
      </div>

      <div className="flex items-start gap-3 p-4 rounded-lg bg-warning/10 border border-warning/30">
        <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
        <p className="text-sm text-warning font-medium">A competência selecionada deve ser a mesma do ESO.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border-border/50">
          <CardHeader>
            <CardTitle className="font-display text-lg">1. Upload do Arquivo</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              className="border-2 border-dashed border-border rounded-xl p-8 text-center hover:border-primary/50 transition-colors cursor-pointer"
              onClick={() => document.getElementById("file-input")?.click()}
            >
              <input id="file-input" type="file" accept=".xlsx,.xls" onChange={handleFileSelect} className="hidden" />
              {file ? (
                <div className="flex flex-col items-center gap-2">
                  <FileSpreadsheet className="h-10 w-10 text-success" />
                  <p className="font-medium text-sm">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <Upload className="h-10 w-10 text-muted-foreground/50" />
                  <p className="font-medium text-sm text-muted-foreground">Arraste o arquivo Excel aqui</p>
                  <p className="text-xs text-muted-foreground">ou clique para selecionar (.xlsx, .xls)</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/50">
          <CardHeader>
            <CardTitle className="font-display text-lg">2. Selecionar Competência</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {competencias.length > 0 && (
              <div className="space-y-2">
                <Label>Competência existente</Label>
                <Select value={compId} onValueChange={(v) => { setCompId(v); setMesSelecionado(""); }}>
                  <SelectTrigger><SelectValue placeholder="Selecionar competência..." /></SelectTrigger>
                  <SelectContent>
                    {competencias.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {MESES[c.mes - 1]} {c.ano}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="text-xs text-center text-muted-foreground">ou crie uma nova</div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Mês</Label>
                <Select value={mesSelecionado} onValueChange={(v) => { setMesSelecionado(v); setCompId(""); }}>
                  <SelectTrigger><SelectValue placeholder="Mês..." /></SelectTrigger>
                  <SelectContent>
                    {MESES.map((m, i) => (
                      <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Ano</Label>
                <Select value={anoSelecionado} onValueChange={setAnoSelecionado}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {years.map((y) => (
                      <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button onClick={handleProcess} disabled={!canProcess || processing} className="w-full">
              {processing ? "Processando..." : "Processar Arquivo"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <AnimatePresence>
        {result && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <Card className="border-success/30 bg-success/5">
              <CardContent className="flex items-center gap-4 py-4">
                <CheckCircle2 className="h-8 w-8 text-success" />
                <div>
                  <p className="font-semibold">Importação concluída!</p>
                  <p className="text-sm text-muted-foreground">
                    {result.total} empresas processadas • {result.found} com cadastro • {result.newCompanies} sem cadastro (precisam ser classificadas)
                  </p>
                  {result.centavosCorrigidos ? (
                    <p className="text-xs text-muted-foreground mt-1">
                      💡 Detectei valores em centavos — {result.centavosCorrigidos} valor(es) ajustado(s) (÷100)
                    </p>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
