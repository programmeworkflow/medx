import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Plus, Search, Upload, Download, CheckCircle2, AlertTriangle, Pencil, Trash2, Eye, MessageSquare, SlidersHorizontal, ChevronDown, X } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { formatCnpjCpf, maskCnpjCpf, onlyDigits, detectDocumentoTipo } from "@/lib/format";
import { confirmDialog } from "@/lib/confirm";
import {
  fetchEmpresas,
  insertEmpresa,
  insertEmpresasBulk,
  updateEmpresa,
  deleteEmpresa,
  mergeEmpresaDuplicate,
  CATEGORIA_LABELS,
  type Categoria,
  type TipoFaturamento,
  type EmpresaInsert,
  type Empresa,
} from "@/lib/api";

const categorias: Categoria[] = ["medwork", "medwork_porto", "avista", "especial", "credenciada", "mensalidade", "labore"];

export default function Empresas() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedEmpresa, setSelectedEmpresa] = useState<Empresa | null>(null);
  const [uploadResult, setUploadResult] = useState<{ success: number; atualizadas: number; errors: string[] } | null>(null);
  const [dupesOpen, setDupesOpen] = useState(false);
  const [duplicates, setDuplicates] = useState<[string, any[]][]>([]);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ ok: 0, fail: 0, errors: [] as string[] });

  // Filters
  const [filterCategoria, setFilterCategoria] = useState<string>("all");
  const [filterFaturamento, setFilterFaturamento] = useState<string>("all");

  // Pagination
  const [pageSize, setPageSize] = useState(25);
  const [currentPage, setCurrentPage] = useState(0);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkCatOpen, setBulkCatOpen] = useState(false);
  const [bulkCategoria, setBulkCategoria] = useState<Categoria>("medwork");

  // Form
  const [nome, setNome] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [categoria, setCategoria] = useState<Categoria>("medwork");
  const [tipo, setTipo] = useState<TipoFaturamento>("propria_empresa");
  const [fatId, setFatId] = useState("");
  const [obs, setObs] = useState("");
  const [ativa, setAtiva] = useState(true);
  const [vidasContrato, setVidasContrato] = useState<string>("");
  const [vidasEso, setVidasEso] = useState<string>("");
  const [dataFechamentoEspecial, setDataFechamentoEspecial] = useState<string>("");
  const [janelaFechamento, setJanelaFechamento] = useState("");
  const [retencaoPadrao, setRetencaoPadrao] = useState<string>("nenhuma");
  const [nfModo, setNfModo] = useState<"nao_emite" | "manual" | "automatica">("manual");
  const [enviarEmailPadrao, setEnviarEmailPadrao] = useState<boolean>(false);
  const [centroCustoId, setCentroCustoId] = useState<string>("");

  const { data: centrosCusto = [] } = useQuery({
    queryKey: ["ca-centros-custo"],
    queryFn: async () => {
      const r = await fetch("/api/contaazul/cost-centers");
      const j = await r.json();
      return (j?.items as { id: string; nome: string }[]) || [];
    },
  });

  const { data: empresas = [], isLoading } = useQuery({
    queryKey: ["empresas"],
    queryFn: fetchEmpresas,
  });

  const insertMutation = useMutation({
    mutationFn: insertEmpresa,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["empresas"] });
      setOpen(false);
      resetForm();
      toast.success("✅ Empresa cadastrada com sucesso!", {
        description: "Já está disponível na lista.",
        duration: 5000,
      });
    },
    onError: (err: any) => {
      toast.error(err.message?.includes("duplicate") ? "CNPJ já cadastrado." : "Erro ao cadastrar empresa.");
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<EmpresaInsert> }) => updateEmpresa(id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["empresas"] });
      setOpen(false);
      setEditingId(null);
      resetForm();
      toast.success("Empresa atualizada com sucesso!");
    },
    onError: () => toast.error("Erro ao atualizar empresa."),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteEmpresa,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["empresas"] });
      toast.success("Empresa excluída com sucesso!");
    },
    onError: () => toast.error("Erro ao excluir empresa. Verifique se não há faturamentos vinculados."),
  });

  const resetForm = () => {
    setNome(""); setCnpj(""); setObs(""); setCategoria("medwork"); setTipo("propria_empresa"); setFatId(""); setAtiva(true);
    setVidasContrato(""); setVidasEso(""); setDataFechamentoEspecial(""); setJanelaFechamento("");
    setRetencaoPadrao("nenhuma"); setNfModo("manual"); setEnviarEmailPadrao(false);
    setCentroCustoId("");
  };

  const openEdit = (e: Empresa) => {
    setEditingId(e.id);
    setNome(e.nome_empresa);
    setCnpj(e.cnpj);
    setCategoria(e.categoria);
    setTipo(e.tipo_faturamento);
    setFatId(e.empresa_faturadora_id || "");
    setObs(e.observacoes || "");
    setAtiva(e.ativa);
    setVidasContrato(e.vidas_contrato != null ? String(e.vidas_contrato) : "");
    setVidasEso(e.vidas_eso != null ? String(e.vidas_eso) : "");
    setDataFechamentoEspecial(e.data_fechamento_especial || "");
    setJanelaFechamento(e.janela_fechamento || "");
    setRetencaoPadrao((e as any).retencao_padrao || "nenhuma");
    // nf_modo é o campo novo; cai pra emitir_nf_padrao boolean (legado)
    const modoSalvo = (e as any).nf_modo as string | undefined;
    setNfModo(
      modoSalvo === "nao_emite" || modoSalvo === "automatica" || modoSalvo === "manual"
        ? modoSalvo
        : (e as any).emitir_nf_padrao
        ? "automatica"
        : "manual"
    );
    setEnviarEmailPadrao(!!(e as any).enviar_email_padrao);
    setCentroCustoId((e as any).centro_custo_id || "");
    setOpen(true);
  };

  const openDetail = (e: Empresa) => {
    setSelectedEmpresa(e);
    setDetailOpen(true);
  };

  const filtered = empresas.filter((e) => {
    const sd = onlyDigits(search);
    const matchSearch =
      e.nome_empresa.toLowerCase().includes(search.toLowerCase()) ||
      (sd && onlyDigits(e.cnpj).includes(sd));
    const matchCat = filterCategoria === "all" || e.categoria === filterCategoria;
    const matchFat = filterFaturamento === "all" || e.tipo_faturamento === filterFaturamento;
    return matchSearch && matchCat && matchFat;
  });

  const totalPages = Math.ceil(filtered.length / pageSize);
  const paginated = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  const handleSave = () => {
    if (!nome || !cnpj) {
      toast.error("Nome e CNPJ/CPF são obrigatórios.");
      return;
    }
    const tipoDoc = detectDocumentoTipo(cnpj);
    if (tipoDoc === "INVALIDO") {
      toast.error("Documento inválido — precisa ter 11 dígitos (CPF) ou 14 (CNPJ)");
      return;
    }
    const cnpjLimpo = onlyDigits(cnpj);
    const payload: any = {
      nome_empresa: nome,
      cnpj: cnpjLimpo,
      categoria,
      tipo_faturamento: tipo,
      empresa_faturadora_id: tipo === "outra_empresa" ? fatId || undefined : null,
      observacoes: obs || null,
      ativa,
      vidas_contrato: vidasContrato ? parseInt(vidasContrato, 10) : null,
      vidas_eso: vidasEso ? parseInt(vidasEso, 10) : null,
      data_fechamento_especial: dataFechamentoEspecial || null,
      janela_fechamento: janelaFechamento || null,
      retencao_padrao: retencaoPadrao,
      nf_modo: nfModo,
      emitir_nf_padrao: nfModo === "automatica",
      enviar_email_padrao: enviarEmailPadrao,
      centro_custo_id: centroCustoId || null,
    };

    if (editingId) {
      updateMutation.mutate({ id: editingId, updates: payload });
    } else {
      insertMutation.mutate(payload);
    }
  };

  const handleBulkCategory = async () => {
    if (selectedIds.size === 0) return;
    for (const id of selectedIds) {
      await updateEmpresa(id, { categoria: bulkCategoria });
    }
    setSelectedIds(new Set());
    setBulkCatOpen(false);
    queryClient.invalidateQueries({ queryKey: ["empresas"] });
    toast.success(`${selectedIds.size} empresas atualizadas!`);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === paginated.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(paginated.map(e => e.id)));
    }
  };

  const handleDownloadTemplate = () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["Empresa", "CNPJ", "Categoria", "Vidas Contrato", "Vidas ESO", "Janela Fechamento", "Data Fechamento Especial", "Observacoes"],
      ["Exemplo Empresa LTDA", "12.345.678/0001-01", "medwork", 50, 48, "do dia 20 ao dia 20", "", "faturar com nota dedicada"],
    ]);
    ws["!cols"] = [
      { wch: 30 }, { wch: 22 }, { wch: 18 },
      { wch: 15 }, { wch: 12 }, { wch: 25 }, { wch: 22 }, { wch: 40 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, "Empresas");
    XLSX.writeFile(wb, "modelo_cadastro_empresas.xlsx");
  };

  const handleUploadFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows: any[] = XLSX.utils.sheet_to_json(ws);
      if (rows.length === 0) { toast.error("Planilha vazia."); return; }
      const errors: string[] = [];
      const validEmpresas: EmpresaInsert[] = [];
      const updates: { id: string; categoria: Categoria; nome: string }[] = [];
      const existingByCnpj = new Map(empresas.map((e) => [onlyDigits(e.cnpj), e]));
      const seenInBatch = new Set<string>();
      const normalizeCat = (s: any) => String(s ?? "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/\s+/g, "_");
      rows.forEach((row, idx) => {
        const nome = row["Empresa"] || row["empresa"] || row["Nome"] || row["nome_empresa"];
        const cnpjRaw = row["CNPJ"] || row["cnpj"];
        const cnpj = onlyDigits(String(cnpjRaw ?? ""));
        const cat  = row["Categoria"] || row["categoria"];
        const vc   = row["Vidas Contrato"] || row["vidas_contrato"];
        const ve   = row["Vidas ESO"]     || row["vidas_eso"];
        const jf   = row["Janela Fechamento"] || row["janela_fechamento"];
        const dfe  = row["Data Fechamento Especial"] || row["data_fechamento_especial"];
        const obsv = row["Observacoes"] || row["observacoes"];
        if (!nome || !cnpj) { errors.push(`Linha ${idx + 2}: Nome ou CNPJ vazio`); return; }
        if (cnpj.length !== 14 && cnpj.length !== 11) {
          errors.push(`Linha ${idx + 2}: CNPJ/CPF "${cnpjRaw}" tem ${cnpj.length} dígitos (precisa 14 ou 11)`);
          return;
        }
        if (seenInBatch.has(cnpj)) {
          errors.push(`Linha ${idx + 2}: CNPJ ${cnpjRaw} duplicado na própria planilha`);
          return;
        }
        seenInBatch.add(cnpj);
        const catNorm = normalizeCat(cat);
        const validCat = categorias.find((c) => normalizeCat(c) === catNorm);
        if (cat && !validCat) errors.push(`Linha ${idx + 2}: Categoria "${cat}" inválida — usado fallback "medwork"`);
        const toIntOrNull = (v: any) => {
          const n = parseInt(String(v ?? "").replace(/\D/g, ""), 10);
          return isFinite(n) && n > 0 ? n : null;
        };
        const toDateOrNull = (v: any) => {
          if (!v) return null;
          if (v instanceof Date) return v.toISOString().slice(0, 10);
          const s = String(v);
          if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
          return null;
        };
        const existente = existingByCnpj.get(cnpj);
        if (existente) {
          // Já cadastrado — se a planilha tem categoria nova/diferente, atualiza
          if (validCat && validCat !== existente.categoria) {
            updates.push({ id: existente.id, categoria: validCat, nome });
          } else {
            errors.push(`Linha ${idx + 2}: CNPJ ${cnpjRaw} já cadastrado (sem alterações)`);
          }
          return;
        }
        validEmpresas.push({
          nome_empresa: nome,
          cnpj,
          categoria: validCat || "medwork",
          tipo_faturamento: "propria_empresa",
          ativa: true,
          vidas_contrato: toIntOrNull(vc),
          vidas_eso: toIntOrNull(ve),
          janela_fechamento: jf ? String(jf) : null,
          data_fechamento_especial: toDateOrNull(dfe),
          observacoes: obsv ? String(obsv) : null,
        });
      });
      if (validEmpresas.length > 0) {
        await insertEmpresasBulk(validEmpresas);
      }
      // Aplica updates de categoria pra empresas já existentes
      let updateFails = 0;
      for (const u of updates) {
        try {
          await updateEmpresa(u.id, { categoria: u.categoria });
        } catch (err: any) {
          updateFails++;
          errors.push(`Update falhou para "${u.nome}": ${err?.message || "erro"}`);
        }
      }
      if (updateFails > 0) console.error(`${updateFails} updates de categoria falharam`);
      if (validEmpresas.length > 0 || updates.length > 0) {
        queryClient.invalidateQueries({ queryKey: ["empresas"] });
      }
      setUploadResult({ success: validEmpresas.length, atualizadas: updates.length, errors });
      if (validEmpresas.length > 0 || updates.length > 0) {
        const ignoradas = errors.length;
        const partes: string[] = [];
        if (validEmpresas.length > 0) partes.push(`${validEmpresas.length} cadastrada${validEmpresas.length > 1 ? "s" : ""}`);
        if (updates.length > 0) partes.push(`${updates.length} atualizada${updates.length > 1 ? "s" : ""}`);
        toast.success(`✅ Importação concluída — ${partes.join(", ")}!`, {
          description: ignoradas > 0
            ? `${ignoradas} linha${ignoradas > 1 ? "s" : ""} ignorada${ignoradas > 1 ? "s" : ""} (veja os detalhes no diálogo)`
            : "Todas as linhas foram processadas com sucesso.",
          duration: 8000,
        });
      }
    } catch (err: any) { toast.error("Erro ao processar planilha: " + err.message); }
  }, [empresas, queryClient]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-[1.75rem] font-bold tracking-tight">Empresas</h1>
          <p className="text-sm text-muted-foreground">{empresas.length} cadastradas</p>
          {(() => {
            const counts = empresas.reduce((acc, e) => {
              acc[e.categoria] = (acc[e.categoria] || 0) + 1;
              return acc;
            }, {} as Record<string, number>);
            const ordered = categorias.filter(c => counts[c] > 0);
            if (ordered.length === 0) return null;
            return (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {ordered.map(c => (
                  <button
                    key={c}
                    onClick={() => { setFilterCategoria(c); setCurrentPage(0); }}
                    className="text-xs px-2 py-0.5 rounded bg-muted hover:bg-muted/70 text-muted-foreground hover:text-foreground transition-colors"
                    title={`Filtrar por ${CATEGORIA_LABELS[c]}`}
                  >
                    {CATEGORIA_LABELS[c]}: <span className="font-semibold text-foreground">{counts[c]}</span>
                  </button>
                ))}
              </div>
            );
          })()}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              const groups = new Map<string, typeof empresas>();
              for (const e of empresas) {
                const k = onlyDigits(e.cnpj);
                const arr = groups.get(k) || [];
                arr.push(e);
                groups.set(k, arr);
              }
              const dupes = Array.from(groups.entries()).filter(([, arr]) => arr.length > 1);
              if (dupes.length === 0) {
                toast.success("Nenhuma duplicata encontrada — todos os CNPJs são únicos.");
                return;
              }
              setDuplicates(dupes);
              setDupesOpen(true);
            }}
          >
            <AlertTriangle className="h-4 w-4 mr-2" /> Encontrar duplicatas
          </Button>
          <Dialog open={uploadOpen} onOpenChange={(v) => { setUploadOpen(v); if (!v) setUploadResult(null); }}>
            <DialogTrigger asChild>
              <Button variant="outline"><Upload className="h-4 w-4 mr-2" /> Importar Planilha</Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="font-display">Importar Empresas por Planilha</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-2">
                <p className="text-sm text-muted-foreground">
                  Faça upload de uma planilha Excel com as colunas: <strong>Empresa</strong>, <strong>CNPJ</strong>, <strong>Categoria</strong>.
                  Os demais campos poderão ser preenchidos depois.
                </p>
                <Button variant="outline" onClick={handleDownloadTemplate} className="w-full">
                  <Download className="h-4 w-4 mr-2" /> Baixar Planilha Modelo
                </Button>
                <div>
                  <Label>Selecionar Arquivo</Label>
                  <Input type="file" accept=".xlsx,.xls" onChange={handleUploadFile} className="mt-1" />
                </div>
                {uploadResult && (
                  <div className="space-y-3">
                    {(uploadResult.success > 0 || uploadResult.atualizadas > 0) && (
                      <div className="flex items-center gap-3 rounded-lg border border-success/40 bg-success/10 p-4">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success/20">
                          <CheckCircle2 className="h-6 w-6 text-success" />
                        </div>
                        <div className="flex-1">
                          <p className="font-display text-base font-semibold text-success">
                            ✅ Importação concluída!
                          </p>
                          <p className="text-sm text-muted-foreground mt-0.5">
                            {uploadResult.success > 0 && `${uploadResult.success} ${uploadResult.success === 1 ? "cadastrada" : "cadastradas"}`}
                            {uploadResult.success > 0 && uploadResult.atualizadas > 0 && " · "}
                            {uploadResult.atualizadas > 0 && `${uploadResult.atualizadas} ${uploadResult.atualizadas === 1 ? "atualizada" : "atualizadas"}`}
                            {uploadResult.errors.length > 0 && ` · ${uploadResult.errors.length} ignorada${uploadResult.errors.length > 1 ? "s" : ""}`}
                          </p>
                        </div>
                      </div>
                    )}
                    {uploadResult.errors.length > 0 && (
                      <div className="space-y-1 max-h-64 overflow-y-auto rounded-md border border-border bg-muted/30 p-3">
                        <p className="text-xs font-semibold text-muted-foreground mb-2">
                          {uploadResult.errors.length} linha{uploadResult.errors.length > 1 ? "s" : ""} ignorada{uploadResult.errors.length > 1 ? "s" : ""}:
                        </p>
                        {uploadResult.errors.map((err, i) => (
                          <div key={i} className="flex items-start gap-2 text-sm text-destructive">
                            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{err}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </DialogContent>
          </Dialog>

          <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditingId(null); resetForm(); } }}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> Nova Empresa</Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="font-display">{editingId ? "Editar Empresa" : "Cadastrar Empresa"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 mt-2">
                <Accordion type="multiple" defaultValue={["basicos","faturamento"]} className="w-full">
                  <AccordionItem value="basicos">
                    <AccordionTrigger className="font-display text-sm">Dados básicos</AccordionTrigger>
                    <AccordionContent className="space-y-4 pt-2">
                      <div className="space-y-2">
                        <Label>Nome da Empresa</Label>
                        <Input value={nome} onChange={(e) => setNome(e.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label>{detectDocumentoTipo(cnpj) === "CPF" ? "CPF" : "CNPJ"} <span className="text-xs text-muted-foreground font-normal">(máscara automática)</span></Label>
                        <Input
                          value={maskCnpjCpf(cnpj)}
                          onChange={(e) => setCnpj(maskCnpjCpf(e.target.value))}
                          placeholder="00.000.000/0000-00 ou 000.000.000-00"
                          inputMode="numeric"
                        />
                        {cnpj && detectDocumentoTipo(cnpj) === "INVALIDO" && (
                          <p className="text-xs text-destructive">
                            Documento incompleto: precisa ter 11 dígitos (CPF) ou 14 (CNPJ)
                          </p>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <Label>Categoria</Label>
                          <Select value={categoria} onValueChange={(v) => setCategoria(v as Categoria)}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {categorias.map((c) => (
                                <SelectItem key={c} value={c}>{CATEGORIA_LABELS[c]}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Status</Label>
                          <Select value={ativa ? "ativa" : "inativa"} onValueChange={(v) => setAtiva(v === "ativa")}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="ativa">Ativa</SelectItem>
                              <SelectItem value="inativa">Inativa</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="faturamento">
                    <AccordionTrigger className="font-display text-sm">Faturamento</AccordionTrigger>
                    <AccordionContent className="space-y-4 pt-2">
                      <div className="space-y-2">
                        <Label>Tipo de Faturamento</Label>
                        <Select value={tipo} onValueChange={(v) => setTipo(v as TipoFaturamento)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="propria_empresa">Própria Empresa</SelectItem>
                            <SelectItem value="outra_empresa">Outra Empresa</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {tipo === "outra_empresa" && (
                        <div className="space-y-2">
                          <Label>Empresa Faturadora</Label>
                          <Select value={fatId} onValueChange={setFatId}>
                            <SelectTrigger><SelectValue placeholder="Selecionar..." /></SelectTrigger>
                            <SelectContent>
                              {empresas.map((e) => (
                                <SelectItem key={e.id} value={e.id}>{e.nome_empresa}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="contrato">
                    <AccordionTrigger className="font-display text-sm">Contrato e vidas</AccordionTrigger>
                    <AccordionContent className="space-y-4 pt-2">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <Label>Vidas inclusas no Contrato</Label>
                          <Input type="number" min={0} value={vidasContrato} onChange={(e) => setVidasContrato(e.target.value)} placeholder="Ex: 50" />
                        </div>
                        <div className="space-y-2">
                          <Label>Vidas no ESO</Label>
                          <Input type="number" min={0} value={vidasEso} onChange={(e) => setVidasEso(e.target.value)} placeholder="Ex: 48" />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <Label>Data especial de fechamento</Label>
                          <Input type="date" value={dataFechamentoEspecial} onChange={(e) => setDataFechamentoEspecial(e.target.value)} />
                        </div>
                        <div className="space-y-2">
                          <Label>Janela de fechamento</Label>
                          <Input value={janelaFechamento} onChange={(e) => setJanelaFechamento(e.target.value)} placeholder='Ex: "do dia 20 ao dia 20"' />
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="retencao">
                    <AccordionTrigger className="font-display text-sm">Retenção fiscal & NF (Conta Azul)</AccordionTrigger>
                    <AccordionContent className="space-y-4 pt-2">
                      <div className="space-y-2">
                        <Label>Centro de custo (Conta Azul)</Label>
                        <Select value={centroCustoId} onValueChange={setCentroCustoId}>
                          <SelectTrigger>
                            <SelectValue placeholder={centrosCusto.length ? "Selecionar..." : "Carregando..."} />
                          </SelectTrigger>
                          <SelectContent>
                            {centrosCusto.map((c) => (
                              <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          Usado automaticamente quando faturar essa empresa na Conta Azul.
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label>Retenção padrão</Label>
                        <Select value={retencaoPadrao} onValueChange={setRetencaoPadrao}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="nenhuma">Nenhuma</SelectItem>
                            <SelectItem value="federal">Só Federal (CSLL+PIS+COFINS, IRRF se ≥ R$ 666,67)</SelectItem>
                            <SelectItem value="iss">Só ISS (5%)</SelectItem>
                            <SelectItem value="federal_iss">Federal + ISS</SelectItem>
                            <SelectItem value="credenciada_auto">Credenciada (automático por valor)</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          Pra credenciadas com regra automática: se valor ≤ R$ 215 não retém; acima retém CSLL+PIS+COFINS; se valor ≥ R$ 666,67 retém também IRRF.
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label>Modo de emissão de NF</Label>
                        <Select value={nfModo} onValueChange={(v) => setNfModo(v as any)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="nao_emite">Não emite NF</SelectItem>
                            <SelectItem value="manual">Manual (marcar caso a caso)</SelectItem>
                            <SelectItem value="automatica">Automática (toda venda gera NF)</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          Define o comportamento padrão ao faturar essa empresa.
                          {nfModo === "nao_emite" && " O campo NF fica desabilitado."}
                          {nfModo === "manual" && " Default desmarcado, marca quando precisar."}
                          {nfModo === "automatica" && " Default marcado, toda venda gera NF."}
                        </p>
                      </div>
                      <label className="flex items-start gap-2 cursor-pointer p-3 rounded-lg border border-border">
                        <input
                          type="checkbox"
                          checked={enviarEmailPadrao}
                          onChange={(e) => setEnviarEmailPadrao(e.target.checked)}
                          className="mt-0.5"
                        />
                        <div className="flex-1">
                          <div className="text-sm font-medium">Enviar e-mail da venda automaticamente</div>
                          <div className="text-xs text-muted-foreground">
                            Após faturar, dispara o e-mail do Conta Azul pros contatos de cobrança da empresa.
                          </div>
                        </div>
                      </label>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="obs">
                    <AccordionTrigger className="font-display text-sm">Observações</AccordionTrigger>
                    <AccordionContent className="pt-2">
                      <Textarea value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Notas internas sobre essa empresa..." />
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>

                <Button onClick={handleSave} className="w-full" disabled={insertMutation.isPending || updateMutation.isPending}>
                  {(insertMutation.isPending || updateMutation.isPending) ? "Salvando..." : editingId ? "Atualizar Empresa" : "Salvar Empresa"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar por nome ou CNPJ..." value={search} onChange={(e) => { setSearch(e.target.value); setCurrentPage(0); }} className="pl-10" />
        </div>
        <Select value={filterCategoria} onValueChange={(v) => { setFilterCategoria(v); setCurrentPage(0); }}>
          <SelectTrigger className="w-[180px]"><SelectValue placeholder="Categoria" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas Categorias</SelectItem>
            {categorias.map((c) => (
              <SelectItem key={c} value={c}>{CATEGORIA_LABELS[c]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterFaturamento} onValueChange={(v) => { setFilterFaturamento(v); setCurrentPage(0); }}>
          <SelectTrigger className="w-[180px]"><SelectValue placeholder="Faturamento" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos Tipos</SelectItem>
            <SelectItem value="propria_empresa">Própria Empresa</SelectItem>
            <SelectItem value="outra_empresa">Outra Empresa</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Bulk actions */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/10 border border-primary/20">
          <span className="text-sm font-medium">{selectedIds.size} selecionadas</span>
          <Button size="sm" variant="outline" onClick={() => setBulkCatOpen(true)}>
            Alterar Categoria em Lote
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>Limpar</Button>
        </div>
      )}

      <Card className="border-border/50">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px]">
                  <Checkbox checked={paginated.length > 0 && selectedIds.size === paginated.length} onCheckedChange={toggleAll} />
                </TableHead>
                <TableHead>Empresa</TableHead>
                <TableHead>CNPJ</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead>Faturamento</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Obs</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginated.map((e) => {
                const fat = e.tipo_faturamento === "outra_empresa" ? empresas.find((x) => x.id === e.empresa_faturadora_id) : null;
                return (
                  <TableRow key={e.id} className={!e.ativa ? "opacity-50" : ""}>
                    <TableCell>
                      <Checkbox checked={selectedIds.has(e.id)} onCheckedChange={() => toggleSelect(e.id)} />
                    </TableCell>
                    <TableCell className="font-medium">{e.nome_empresa}</TableCell>
                    <TableCell className="text-muted-foreground text-xs font-mono">{formatCnpjCpf(e.cnpj)}</TableCell>
                    <TableCell><Badge variant="secondary">{CATEGORIA_LABELS[e.categoria]}</Badge></TableCell>
                    <TableCell>
                      {fat ? <span className="text-sm">→ {fat.nome_empresa}</span> : <span className="text-xs text-muted-foreground">Própria</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={e.ativa ? "default" : "destructive"}>{e.ativa ? "Ativa" : "Inativa"}</Badge>
                    </TableCell>
                    <TableCell>
                      {e.observacoes ? (
                        <span title={e.observacoes} className="text-xs text-muted-foreground flex items-center gap-1 max-w-[120px] truncate">
                          <MessageSquare className="h-3 w-3 shrink-0" />{e.observacoes}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openDetail(e)} title="Ver detalhes">
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(e)} title="Editar">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => setDeleteConfirm(e.id)} title="Excluir">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                    {isLoading ? "Carregando..." : "Nenhuma empresa encontrada."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Mostrar</span>
          <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(0); }}>
            <SelectTrigger className="w-[70px] h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[10, 25, 50, 100].map(n => (
                <SelectItem key={n} value={String(n)}>{n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span>por página • {filtered.length} registros</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setCurrentPage(p => p - 1)}>Anterior</Button>
          <span className="text-sm px-3">{currentPage + 1} / {Math.max(totalPages, 1)}</span>
          <Button variant="outline" size="sm" disabled={currentPage >= totalPages - 1} onClick={() => setCurrentPage(p => p + 1)}>Próximo</Button>
        </div>
      </div>

      {/* Detail Dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">Detalhes da Empresa</DialogTitle>
          </DialogHeader>
          {selectedEmpresa && (
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-muted-foreground">Nome:</span><p className="font-medium">{selectedEmpresa.nome_empresa}</p></div>
                <div><span className="text-muted-foreground">CNPJ:</span><p className="font-mono">{formatCnpjCpf(selectedEmpresa.cnpj)}</p></div>
                <div><span className="text-muted-foreground">Categoria:</span><p><Badge variant="secondary">{CATEGORIA_LABELS[selectedEmpresa.categoria]}</Badge></p></div>
                <div><span className="text-muted-foreground">Faturamento:</span><p>{selectedEmpresa.tipo_faturamento === "outra_empresa" ? `→ ${empresas.find(x => x.id === selectedEmpresa.empresa_faturadora_id)?.nome_empresa || "—"}` : "Própria Empresa"}</p></div>
                <div><span className="text-muted-foreground">Status:</span><p><Badge variant={selectedEmpresa.ativa ? "default" : "destructive"}>{selectedEmpresa.ativa ? "Ativa" : "Inativa"}</Badge></p></div>
                <div><span className="text-muted-foreground">Cadastro:</span><p>{new Date(selectedEmpresa.criado_em).toLocaleDateString("pt-BR")}</p></div>
                <div><span className="text-muted-foreground">Vidas Contrato:</span><p>{selectedEmpresa.vidas_contrato ?? "—"}</p></div>
                <div><span className="text-muted-foreground">Vidas ESO:</span><p>{selectedEmpresa.vidas_eso ?? "—"}</p></div>
                <div className="col-span-2"><span className="text-muted-foreground">Janela de fechamento:</span><p>{selectedEmpresa.janela_fechamento || "—"}</p></div>
                {selectedEmpresa.data_fechamento_especial && (
                  <div className="col-span-2"><span className="text-muted-foreground">Data especial de fechamento:</span><p>{new Date(selectedEmpresa.data_fechamento_especial).toLocaleDateString("pt-BR")}</p></div>
                )}
              </div>
              {selectedEmpresa.observacoes && (
                <div className="pt-2 border-t border-border">
                  <span className="text-sm text-muted-foreground">Observações:</span>
                  <p className="text-sm mt-1">{selectedEmpresa.observacoes}</p>
                </div>
              )}
              <div className="flex gap-2 pt-2">
                <Button variant="outline" className="flex-1" onClick={() => { setDetailOpen(false); openEdit(selectedEmpresa); }}>
                  <Pencil className="h-4 w-4 mr-2" /> Editar
                </Button>
                <Button variant={selectedEmpresa.ativa ? "secondary" : "default"} className="flex-1"
                  onClick={() => {
                    updateMutation.mutate({ id: selectedEmpresa.id, updates: { ativa: !selectedEmpresa.ativa } });
                    setDetailOpen(false);
                  }}>
                  {selectedEmpresa.ativa ? "Inativar" : "Ativar"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Bulk Category Dialog */}
      <Dialog open={bulkCatOpen} onOpenChange={setBulkCatOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-display">Alterar Categoria em Lote</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <p className="text-sm text-muted-foreground">{selectedIds.size} empresas selecionadas</p>
            <Select value={bulkCategoria} onValueChange={(v) => setBulkCategoria(v as Categoria)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {categorias.map((c) => (
                  <SelectItem key={c} value={c}>{CATEGORIA_LABELS[c]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={handleBulkCategory} className="w-full">Aplicar</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar exclusão</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir esta empresa? Esta ação não pode ser desfeita. Se houver faturamentos vinculados, a exclusão não será permitida.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (deleteConfirm) { deleteMutation.mutate(deleteConfirm); setDeleteConfirm(null); } }}>
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dialog de duplicatas */}
      <Dialog open={dupesOpen} onOpenChange={setDupesOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" />
              {duplicates.length} CNPJ{duplicates.length > 1 ? "s" : ""} duplicado{duplicates.length > 1 ? "s" : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <p className="text-sm text-muted-foreground">
              Empresas com o mesmo CNPJ. A primeira de cada grupo fica marcada como "manter" — as demais são duplicatas.
            </p>
            {duplicates.length > 0 && (() => {
              const totalDupes = duplicates.reduce((s, [, arr]) => s + (arr.length - 1), 0);
              return (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-destructive">
                      {totalDupes} duplicata{totalDupes > 1 ? "s" : ""} pra excluir
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Mantém a 1ª empresa de cada grupo, exclui as demais.
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={bulkDeleting}
                    onClick={() => setBulkConfirmOpen(true)}
                  >
                    {bulkDeleting ? `Mesclando... ${bulkProgress.ok + bulkProgress.fail}/${totalDupes}` : "Mesclar todas"}
                  </Button>
                </div>
              );
            })()}
            {duplicates.map(([cnpj, arr]) => (
              <div key={cnpj} className="rounded-lg border border-border p-3 space-y-2">
                <p className="text-xs font-mono text-muted-foreground">CNPJ: {cnpj}</p>
                {arr.map((e, i) => (
                  <div key={e.id} className="flex items-center justify-between gap-2 rounded bg-muted/30 p-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{e.nome_empresa}</p>
                      <p className="text-xs text-muted-foreground">
                        Categoria: {CATEGORIA_LABELS[e.categoria]} · {e.ativa ? "Ativa" : "Inativa"}
                        {i === 0 && <span className="ml-2 text-success">✓ manter</span>}
                      </p>
                    </div>
                    {i > 0 && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={async () => {
                          const confirmed = await confirmDialog({
                            title: "Mesclar nesta duplicata?",
                            description: `Faturamentos e treinamentos de "${e.nome_empresa}" serão movidos pra "${arr[0].nome_empresa}", e o cadastro duplicado será excluído.`,
                            confirmText: "Mesclar",
                            variant: "danger",
                          });
                          if (!confirmed) return;
                          try {
                            await mergeEmpresaDuplicate(arr[0].id, e.id);
                            queryClient.invalidateQueries({ queryKey: ["empresas"] });
                            queryClient.invalidateQueries({ queryKey: ["empresas"] });
                            queryClient.invalidateQueries({ queryKey: ["faturamentos"] });
                            queryClient.invalidateQueries({ queryKey: ["treinamentos"] });
                            setDuplicates((prev) => prev
                              .map(([k, v]): [string, any[]] => [k, v.filter((x: any) => x.id !== e.id)])
                              .filter(([, v]) => v.length > 1)
                            );
                            toast.success("Duplicata mesclada — histórico preservado.");
                          } catch (err: any) {
                            console.error("Falha no merge", err);
                            toast.error("Erro: " + (err?.message || "veja console (F12)"));
                          }
                        }}
                      >
                        Mesclar
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {duplicates.length === 0 && (
              <p className="text-center text-sm text-success py-4">Nenhuma duplicata pendente!</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirm bulk delete — AlertDialog inline (mesmo escopo, sem portal aninhado) */}
      <AlertDialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Mesclar {duplicates.reduce((s, [, arr]) => s + (arr.length - 1), 0)} duplicata
              {duplicates.reduce((s, [, arr]) => s + (arr.length - 1), 0) > 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground space-y-2">
                <p>Pra cada grupo de CNPJ duplicado:</p>
                <ul className="list-disc list-inside space-y-1 pl-2">
                  <li><strong>Faturamentos</strong> da duplicata serão movidos pra empresa "manter"</li>
                  <li><strong>Treinamentos</strong> também serão movidos</li>
                  <li>O cadastro duplicado é então excluído</li>
                </ul>
                <p className="pt-1">
                  <strong className="text-foreground">Histórico preservado.</strong> Esta ação não pode ser desfeita.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={bulkDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async (ev) => {
                ev.preventDefault();
                setBulkDeleting(true);
                setBulkProgress({ ok: 0, fail: 0, errors: [] });
                // Merge: pra cada grupo, mantém a 1ª e mescla as demais nela
                let ok = 0, fail = 0;
                const errors: string[] = [];
                for (const [, arr] of duplicates) {
                  const keep = arr[0];
                  for (const dup of arr.slice(1)) {
                    try {
                      await mergeEmpresaDuplicate(keep.id, dup.id);
                      ok++;
                    } catch (err: any) {
                      fail++;
                      errors.push(`${dup.nome_empresa}: ${err?.message || "erro"}`);
                      console.error("Falha ao mesclar", dup.nome_empresa, err);
                    }
                    setBulkProgress({ ok, fail, errors });
                  }
                }
                queryClient.invalidateQueries({ queryKey: ["empresas"] });
                queryClient.invalidateQueries({ queryKey: ["faturamentos"] });
                queryClient.invalidateQueries({ queryKey: ["treinamentos"] });
                setBulkConfirmOpen(false);
                setBulkDeleting(false);
                if (fail === 0) {
                  toast.success(`✅ ${ok} duplicata${ok > 1 ? "s" : ""} mesclada${ok > 1 ? "s" : ""}!`, {
                    description: "Faturamentos e treinamentos foram preservados na empresa mantida.",
                    duration: 6000,
                  });
                  setDuplicates([]);
                  setDupesOpen(false);
                } else {
                  toast.warning(`${ok} mesclada(s) · ${fail} falhou`, {
                    description: "Ver detalhes nos logs (F12).",
                    duration: 10000,
                  });
                }
              }}
            >
              {bulkDeleting
                ? `Mesclando ${bulkProgress.ok + bulkProgress.fail}/${duplicates.reduce((s, [, arr]) => s + (arr.length - 1), 0)}…`
                : "Mesclar todas"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
