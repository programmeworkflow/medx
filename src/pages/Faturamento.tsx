import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { CheckCircle, ExternalLink, Search, ArrowUpDown, RefreshCw, Trash2, Pencil } from "lucide-react";
import { toast } from "sonner";
import {
  fetchCompetencias,
  fetchFaturamentos,
  fetchEmpresas,
  updateFaturamentoStatus,
  updateFaturamento,
  MESES,
  CATEGORIA_LABELS,
  STATUS_LABELS,
  STATUS_COLORS,
  type StatusFaturamento,
  type Categoria,
} from "@/lib/api";
import { supabase } from "@/integrations/supabase/client";
import ContaAzulPanel from "@/components/ContaAzulPanel";
import { formatCnpjCpf, onlyDigits } from "@/lib/format";

type SortKey = "nome" | "valor" | "status";
type SortDir = "asc" | "desc";

function normalizeCnpj(raw: string): string {
  return onlyDigits(raw);
}

function formatBRL(value: number | null): string {
  if (value == null) return "R$ 0,00";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

export default function Faturamento() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const initialStatus = searchParams.get("status") || "all";
  const initialCompId = searchParams.get("comp") || "";

  const [selectedCompId, setSelectedCompId] = useState<string>(initialCompId);
  const [search, setSearch] = useState("");
  const [filterCategoria, setFilterCategoria] = useState("all");
  const [filterFaturamento, setFilterFaturamento] = useState("all");
  const [filterStatus, setFilterStatus] = useState(initialStatus);
  const [sortKey, setSortKey] = useState<SortKey>("nome");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pageSize, setPageSize] = useState(25);
  const [currentPage, setCurrentPage] = useState(0);

  const { data: competencias = [] } = useQuery({
    queryKey: ["competencias"],
    queryFn: fetchCompetencias,
  });

  const compId = selectedCompId || competencias[0]?.id || "";

  const { data: faturamentos = [], isLoading } = useQuery({
    queryKey: ["faturamentos", compId],
    queryFn: () => fetchFaturamentos(compId),
    enabled: !!compId,
  });

  const currentComp = competencias.find(c => c.id === compId);

  const statusMutation = useMutation({
    mutationFn: ({ fatId, status }: { fatId: string; status: StatusFaturamento }) =>
      updateFaturamentoStatus(fatId, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["faturamentos", compId] });
      queryClient.invalidateQueries({ queryKey: ["competencias"] });
      toast.success("Status atualizado!");
    },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: any }) => updateFaturamento(id, updates),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["faturamentos", compId] }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("faturamentos").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["faturamentos", compId] });
      toast.success("Faturamento excluído!");
    },
  });

  const [editingValorId, setEditingValorId] = useState<string | null>(null);
  const [editingValorValue, setEditingValorValue] = useState("");

  const handleConcluir = (fatId: string) => {
    statusMutation.mutate({ fatId, status: "concluido" });
  };

  const handleBulkConcluir = async () => {
    if (selectedIds.size === 0) return;
    for (const id of selectedIds) {
      await updateFaturamentoStatus(id, "concluido");
    }
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["faturamentos", compId] });
    queryClient.invalidateQueries({ queryKey: ["competencias"] });
    toast.success(`${selectedIds.size} empresas concluídas!`);
  };

  // Re-vincula faturamentos sem_cadastro a empresas que ganharam cadastro depois.
  // Sempre compara por CNPJ (não por id). Se há outra empresa com mesmo CNPJ
  // (ou a placeholder original foi classificada), aponta o faturamento pra ela.
  const reconciliarSemCadastro = async (silencioso: boolean = false) => {
    const empresas = await fetchEmpresas();
    // Index: cnpj normalizado → preferir empresas com categoria != medwork (cadastros reais)
    const empresasByCnpj = new Map<string, any[]>();
    for (const e of empresas) {
      const k = normalizeCnpj(e.cnpj);
      if (!k) continue;
      const arr = empresasByCnpj.get(k) || [];
      arr.push(e);
      empresasByCnpj.set(k, arr);
    }
    const escolherCadastro = (cnpjNorm: string, currentExecId: string) => {
      const arr = empresasByCnpj.get(cnpjNorm) || [];
      // Prioriza: outra empresa com categoria != medwork
      const real = arr.find((e) => e.id !== currentExecId && e.categoria !== "medwork");
      if (real) return real;
      // 2º: a própria empresa, se já foi classificada
      const self = arr.find((e) => e.id === currentExecId && e.categoria !== "medwork");
      if (self) return self;
      // 3º: qualquer outra empresa com mesmo CNPJ (mesmo categoria=medwork mas diferente)
      const outra = arr.find((e) => e.id !== currentExecId);
      return outra || null;
    };

    let updated = 0;
    for (const fat of faturamentos) {
      if ((fat as any).status !== "sem_cadastro") continue;
      const exec = (fat as any).empresa_executora;
      if (!exec) continue;
      const cnpjNorm = normalizeCnpj(exec.cnpj);
      const escolhida = escolherCadastro(cnpjNorm, exec.id);
      if (!escolhida) continue;
      // Só atualiza se: (a) achou cadastro real (categoria != medwork) ou
      // (b) a empresa atual mudou de categoria (não é mais placeholder)
      const ehReal = escolhida.categoria !== "medwork";
      const idMudou = escolhida.id !== exec.id;
      if (!ehReal && !idMudou) continue;
      await supabase.from("faturamentos").update({
        status: "pendente",
        categoria_snapshot: escolhida.categoria,
        empresa_executora_id: escolhida.id,
        empresa_faturadora_id: escolhida.empresa_faturadora_id || escolhida.id,
      }).eq("id", (fat as any).id);
      updated++;
    }

    if (updated > 0) {
      queryClient.invalidateQueries({ queryKey: ["faturamentos", compId] });
      if (!silencioso) toast.success(`${updated} empresa(s) re-vinculada(s) ao cadastro`);
    } else if (!silencioso) {
      toast.info("Nenhum sem_cadastro encontrou cadastro real ainda");
    }
    return updated;
  };

  const handleRefresh = () => reconciliarSemCadastro(false);

  // Auto-reconcilia quando a lista de faturamentos carrega/troca de competência
  useEffect(() => {
    if (!faturamentos.length) return;
    const semCad = faturamentos.filter((f: any) => f.status === "sem_cadastro");
    if (semCad.length === 0) return;
    reconciliarSemCadastro(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faturamentos.length, compId]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  const filtered = useMemo(() => {
    return faturamentos.filter((f: any) => {
      const s = search.toLowerCase();
      const searchDigits = onlyDigits(search);
      const matchSearch = !search ||
        f.empresa_executora?.nome_empresa?.toLowerCase().includes(s) ||
        (searchDigits && onlyDigits(f.empresa_executora?.cnpj).includes(searchDigits));
      const matchCat = filterCategoria === "all" || f.categoria_snapshot === filterCategoria;
      const matchFat = filterFaturamento === "all" ||
        (filterFaturamento === "propria" ? f.empresa_executora_id === f.empresa_faturadora_id : f.empresa_executora_id !== f.empresa_faturadora_id);
      const matchStatus = filterStatus === "all" || f.status === filterStatus;
      return matchSearch && matchCat && matchFat && matchStatus;
    });
  }, [faturamentos, search, filterCategoria, filterFaturamento, filterStatus]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a: any, b: any) => {
      let cmp = 0;
      if (sortKey === "nome") {
        cmp = (a.empresa_executora?.nome_empresa || "").localeCompare(b.empresa_executora?.nome_empresa || "");
      } else if (sortKey === "valor") {
        cmp = (a.valor || 0) - (b.valor || 0);
      } else if (sortKey === "status") {
        const order: Record<string, number> = { sem_cadastro: 0, pendente: 1, aguardando_oc: 2, conferencia: 3, faturado: 4, pago_avista: 5, concluido: 6 };
        cmp = (order[a.status] ?? 0) - (order[b.status] ?? 0);
      }
      return sortDir === "desc" ? -cmp : cmp;
    });
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.ceil(sorted.length / pageSize);
  const paginated = sorted.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  const stats = useMemo(() => {
    const total = faturamentos.length;
    const concluidos = faturamentos.filter((f: any) => f.status === "concluido" || f.status === "pago_avista").length;
    const semCadastro = faturamentos.filter((f: any) => f.status === "sem_cadastro").length;
    return { total, concluidos, pendentes: total - concluidos - semCadastro, semCadastro };
  }, [faturamentos]);

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
      setSelectedIds(new Set(paginated.map((f: any) => f.id)));
    }
  };

  return (
    <div className="space-y-6">
      <ContaAzulPanel />
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-[1.75rem] font-bold tracking-tight">Faturamento</h1>
          <p className="text-sm text-muted-foreground">
            {currentComp ? `${MESES[currentComp.mes - 1]} ${currentComp.ano}` : "Selecione uma competência"} — {stats.concluidos}/{stats.total} concluídos
            {stats.semCadastro > 0 && <span className="text-destructive ml-1">• {stats.semCadastro} sem cadastro</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} title="Atualizar dados do cadastro">
            <RefreshCw className="h-4 w-4 mr-1" /> Atualizar
          </Button>
          <Select value={compId} onValueChange={(v) => { setSelectedCompId(v); setCurrentPage(0); }}>
            <SelectTrigger className="w-[220px]"><SelectValue placeholder="Competência..." /></SelectTrigger>
            <SelectContent>
              {competencias.map((c) => (
                <SelectItem key={c.id} value={c.id}>{MESES[c.mes - 1]} {c.ano}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar empresa..." value={search} onChange={e => { setSearch(e.target.value); setCurrentPage(0); }} className="pl-10" />
        </div>
        <Select value={filterCategoria} onValueChange={(v) => { setFilterCategoria(v); setCurrentPage(0); }}>
          <SelectTrigger className="w-[160px]"><SelectValue placeholder="Categoria" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas Categorias</SelectItem>
            {Object.entries(CATEGORIA_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterFaturamento} onValueChange={(v) => { setFilterFaturamento(v); setCurrentPage(0); }}>
          <SelectTrigger className="w-[160px]"><SelectValue placeholder="Faturamento" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="propria">Própria</SelectItem>
            <SelectItem value="outra">Outra Empresa</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterStatus} onValueChange={(v) => { setFilterStatus(v); setCurrentPage(0); }}>
          <SelectTrigger className="w-[180px]"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos Status</SelectItem>
            {Object.entries(STATUS_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Bulk actions */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/10 border border-primary/20">
          <span className="text-sm font-medium">{selectedIds.size} selecionadas</span>
          <Button size="sm" onClick={handleBulkConcluir}>
            <CheckCircle className="h-4 w-4 mr-1" /> Concluir Selecionadas
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
                <TableHead className="w-[40px]"></TableHead>
                <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("nome")}>
                  Empresa <ArrowUpDown className="inline h-3 w-3 ml-1" />
                </TableHead>
                <TableHead>CNPJ</TableHead>
                <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("valor")}>
                  Valor <ArrowUpDown className="inline h-3 w-3 ml-1" />
                </TableHead>
                <TableHead>Link ESO</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead>Faturamento</TableHead>
                <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("status")}>
                  Status <ArrowUpDown className="inline h-3 w-3 ml-1" />
                </TableHead>
                <TableHead className="w-[80px]">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginated.map((fat: any) => {
                const isFinished = fat.status === "concluido" || fat.status === "pago_avista";
                const isSemCadastro = fat.status === "sem_cadastro";
                const exec = fat.empresa_executora;
                const fatur = fat.empresa_faturadora;
                const isOutra = fat.empresa_executora_id !== fat.empresa_faturadora_id;

                return (
                  <TableRow key={fat.id} className={isFinished ? "bg-muted/30" : isSemCadastro ? "bg-destructive/5" : ""}>
                    <TableCell>
                      <Checkbox
                        checked={selectedIds.has(fat.id)}
                        onCheckedChange={() => toggleSelect(fat.id)}
                      />
                    </TableCell>
                    <TableCell>
                      <button
                        onClick={() => !isFinished && handleConcluir(fat.id)}
                        disabled={isFinished}
                        className={`h-7 w-7 rounded-full border-2 flex items-center justify-center transition-colors ${
                          isFinished
                            ? "bg-success border-success text-white"
                            : "border-muted-foreground/30 hover:border-success hover:bg-success/10 text-transparent hover:text-success"
                        }`}
                        title={isFinished ? "Concluído" : "Marcar como concluído"}
                      >
                        <CheckCircle className="h-4 w-4" />
                      </button>
                    </TableCell>
                    <TableCell className={`font-medium ${isFinished ? "line-through text-muted-foreground" : ""}`}>
                      {exec?.nome_empresa ?? "—"}
                      {fat.observacoes_mes && (
                        <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1 max-w-[200px]">{fat.observacoes_mes}</p>
                      )}
                    </TableCell>
                    <TableCell className={`text-xs font-mono ${isFinished ? "line-through text-muted-foreground" : "text-muted-foreground"}`}>
                      {exec?.cnpj ? formatCnpjCpf(exec.cnpj) : "—"}
                    </TableCell>
                    <TableCell className="text-sm font-medium">
                      {editingValorId === fat.id ? (
                        <Input
                          className="h-7 w-28 text-xs"
                          defaultValue={fat.valor != null ? String(fat.valor).replace(".", ",") : ""}
                          autoFocus
                          onBlur={(e) => {
                            const parsed = parseFloat(e.target.value.replace(/\./g, "").replace(",", "."));
                            if (!isNaN(parsed)) updateMut.mutate({ id: fat.id, updates: { valor: parsed } });
                            setEditingValorId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            if (e.key === "Escape") setEditingValorId(null);
                          }}
                        />
                      ) : (
                        <span
                          className="cursor-pointer hover:text-primary"
                          onClick={() => { setEditingValorId(fat.id); setEditingValorValue(String(fat.valor || "")); }}
                          title="Clique para editar"
                        >
                          {formatBRL(fat.valor)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {fat.link_relatorio_eso ? (
                        <a href={fat.link_relatorio_eso} target="_blank" rel="noopener" className="text-primary hover:underline flex items-center gap-1 text-xs">
                          <ExternalLink className="h-3 w-3" /> Ver
                        </a>
                      ) : (
                        <Input
                          className="h-7 w-28 text-xs"
                          placeholder="URL..."
                          onBlur={(e) => {
                            if (e.target.value) updateMut.mutate({ id: fat.id, updates: { link_relatorio_eso: e.target.value } });
                          }}
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={isFinished ? "opacity-50" : ""}>
                        {CATEGORIA_LABELS[fat.categoria_snapshot as Categoria] ?? fat.categoria_snapshot}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {isOutra ? (
                        <span className="text-xs">→ {fatur?.nome_empresa ?? "—"}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Própria</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge className={STATUS_COLORS[fat.status as StatusFaturamento] || ""}>
                        {STATUS_LABELS[fat.status as StatusFaturamento]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <button
                        onClick={() => {
                          if (confirm("Excluir este faturamento?")) deleteMut.mutate(fat.id);
                        }}
                        className="h-7 w-7 rounded flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        title="Excluir"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {faturamentos.length === 0 && !isLoading && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-10 text-muted-foreground">
                    {competencias.length === 0 ? "Nenhuma competência criada. Importe uma planilha ESO primeiro." : "Nenhum faturamento para esta competência."}
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
          <span>por página • {sorted.length} registros</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setCurrentPage(p => p - 1)}>Anterior</Button>
          <span className="text-sm px-3">{currentPage + 1} / {Math.max(totalPages, 1)}</span>
          <Button variant="outline" size="sm" disabled={currentPage >= totalPages - 1} onClick={() => setCurrentPage(p => p + 1)}>Próximo</Button>
        </div>
      </div>
    </div>
  );
}
