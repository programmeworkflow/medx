import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, GraduationCap, Wallet, TrendingUp, Calendar, Search, X, SlidersHorizontal, ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { toast } from "sonner";
import {
  fetchTreinamentos,
  insertTreinamento,
  updateTreinamento,
  deleteTreinamento,
  fetchEmpresas,
  COMISSAO_TREINAMENTO,
  type ModalidadeTreinamento,
  type TreinamentoInsert,
} from "@/lib/api";

const fmtBRL = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export default function Treinamentos() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterMes, setFilterMes] = useState<string>("all");
  const [filterSearch, setFilterSearch] = useState("");
  const [filterEmpresa, setFilterEmpresa] = useState<string>("all");
  const [filterModalidade, setFilterModalidade] = useState<string>("all");
  const [filterValorMin, setFilterValorMin] = useState<string>("");
  const [filterValorMax, setFilterValorMax] = useState<string>("");
  const [filterDataDe, setFilterDataDe] = useState<string>("");
  const [filterDataAte, setFilterDataAte] = useState<string>("");
  const [filterPgto, setFilterPgto] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("data-desc");

  // Form state
  const [nome, setNome] = useState("");
  const [empresaId, setEmpresaId] = useState<string>("");
  const [modalidade, setModalidade] = useState<ModalidadeTreinamento>("presencial");
  const [diariaInstrutor, setDiariaInstrutor] = useState<string>("");
  const [valorBruto, setValorBruto] = useState<string>("");
  const [dataTreinamento, setDataTreinamento] = useState("");
  const [dataPagamento, setDataPagamento] = useState("");
  const [obs, setObs] = useState("");

  const { data: treinamentos = [], isLoading } = useQuery({
    queryKey: ["treinamentos"],
    queryFn: fetchTreinamentos,
  });

  const { data: empresas = [] } = useQuery({
    queryKey: ["empresas"],
    queryFn: fetchEmpresas,
  });

  const insertMutation = useMutation({
    mutationFn: insertTreinamento,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["treinamentos"] });
      setOpen(false); resetForm();
      toast.success("Treinamento cadastrado!");
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<TreinamentoInsert> }) => updateTreinamento(id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["treinamentos"] });
      setOpen(false); setEditingId(null); resetForm();
      toast.success("Treinamento atualizado!");
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteTreinamento,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["treinamentos"] });
      toast.success("Treinamento excluído!");
    },
    onError: () => toast.error("Erro ao excluir treinamento."),
  });

  const resetForm = () => {
    setNome(""); setEmpresaId(""); setModalidade("presencial");
    setDiariaInstrutor(""); setValorBruto(""); setDataTreinamento("");
    setDataPagamento(""); setObs("");
  };

  const openEdit = (t: any) => {
    setEditingId(t.id);
    setNome(t.nome);
    setEmpresaId(t.empresa_id || "");
    setModalidade(t.modalidade);
    setDiariaInstrutor(t.diaria_instrutor != null ? String(t.diaria_instrutor) : "");
    setValorBruto(String(t.valor_bruto));
    setDataTreinamento(t.data_treinamento);
    setDataPagamento(t.data_pagamento || "");
    setObs(t.observacoes || "");
    setOpen(true);
  };

  const handleSave = () => {
    if (!nome || !dataTreinamento) {
      toast.error("Nome e data do treinamento são obrigatórios.");
      return;
    }
    const vb = parseFloat(valorBruto.replace(",", "."));
    if (!isFinite(vb) || vb < 0) {
      toast.error("Valor bruto inválido.");
      return;
    }
    const di = modalidade === "presencial" && diariaInstrutor
      ? parseFloat(diariaInstrutor.replace(",", "."))
      : null;

    const payload: TreinamentoInsert = {
      nome,
      empresa_id: empresaId || null,
      modalidade,
      diaria_instrutor: di,
      valor_bruto: vb,
      data_treinamento: dataTreinamento,
      data_pagamento: dataPagamento || null,
      observacoes: obs || null,
    };
    if (editingId) {
      updateMutation.mutate({ id: editingId, updates: payload });
    } else {
      insertMutation.mutate(payload);
    }
  };

  // Dashboard stats
  const now = new Date();
  const filtered = useMemo(() => {
    let arr = [...treinamentos];
    if (filterSearch.trim()) {
      const q = filterSearch.toLowerCase();
      arr = arr.filter((t) => (t.nome || "").toLowerCase().includes(q));
    }
    if (filterMes !== "all") {
      const [y, m] = filterMes.split("-").map(Number);
      arr = arr.filter((t) => {
        const d = new Date(t.data_treinamento);
        return d.getFullYear() === y && d.getMonth() + 1 === m;
      });
    }
    if (filterEmpresa !== "all") arr = arr.filter((t) => t.empresa_id === filterEmpresa);
    if (filterModalidade !== "all") arr = arr.filter((t) => t.modalidade === filterModalidade);
    if (filterValorMin) arr = arr.filter((t) => Number(t.valor_bruto) >= Number(filterValorMin));
    if (filterValorMax) arr = arr.filter((t) => Number(t.valor_bruto) <= Number(filterValorMax));
    if (filterDataDe) arr = arr.filter((t) => t.data_treinamento >= filterDataDe);
    if (filterDataAte) arr = arr.filter((t) => t.data_treinamento <= filterDataAte);
    if (filterPgto === "pago") arr = arr.filter((t) => !!t.data_pagamento);
    if (filterPgto === "pendente") arr = arr.filter((t) => !t.data_pagamento);

    arr.sort((a, b) => {
      switch (sortBy) {
        case "data-asc":  return (a.data_treinamento || "").localeCompare(b.data_treinamento || "");
        case "data-desc": return (b.data_treinamento || "").localeCompare(a.data_treinamento || "");
        case "valor-asc": return Number(a.valor_bruto) - Number(b.valor_bruto);
        case "valor-desc":return Number(b.valor_bruto) - Number(a.valor_bruto);
        case "nome-asc":  return (a.nome || "").localeCompare(b.nome || "");
        case "nome-desc": return (b.nome || "").localeCompare(a.nome || "");
        default: return 0;
      }
    });
    return arr;
  }, [treinamentos, filterSearch, filterMes, filterEmpresa, filterModalidade, filterValorMin, filterValorMax, filterDataDe, filterDataAte, filterPgto, sortBy]);

  const activeFilters =
    Number(!!filterSearch) +
    Number(filterMes !== "all") +
    Number(filterEmpresa !== "all") +
    Number(filterModalidade !== "all") +
    Number(!!filterValorMin) +
    Number(!!filterValorMax) +
    Number(!!filterDataDe) +
    Number(!!filterDataAte) +
    Number(filterPgto !== "all");

  const clearAllFilters = () => {
    setFilterSearch(""); setFilterMes("all"); setFilterEmpresa("all"); setFilterModalidade("all");
    setFilterValorMin(""); setFilterValorMax(""); setFilterDataDe(""); setFilterDataAte("");
    setFilterPgto("all"); setSortBy("data-desc");
  };

  const stats = useMemo(() => {
    const totalBruto = filtered.reduce((s, t) => s + (Number(t.valor_bruto) || 0), 0);
    const totalComissao = filtered.reduce((s, t) => s + (Number(t.valor_comissao) || 0), 0);
    const totalDiaria = filtered
      .filter((t) => t.modalidade === "presencial")
      .reduce((s, t) => s + (Number(t.diaria_instrutor) || 0), 0);
    const count = filtered.length;
    return {
      count,
      totalBruto,
      totalComissao,
      totalDiaria,
      media: count > 0 ? totalBruto / count : 0,
    };
  }, [filtered]);

  // Available months (filter options)
  const mesesDisponiveis = useMemo(() => {
    const s = new Set<string>();
    treinamentos.forEach((t) => {
      const d = new Date(t.data_treinamento);
      s.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    });
    return Array.from(s).sort().reverse();
  }, [treinamentos]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-[1.75rem] font-bold tracking-tight">Treinamentos</h1>
          <p className="text-sm text-muted-foreground">
            {treinamentos.length} cadastrados • comissão fixa {(COMISSAO_TREINAMENTO * 100).toFixed(0)}%
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditingId(null); resetForm(); } }}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> Novo Treinamento</Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="font-display">{editingId ? "Editar Treinamento" : "Cadastrar Treinamento"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 mt-2">
                <Accordion type="multiple" defaultValue={["basicos","financeiro"]} className="w-full">
                  <AccordionItem value="basicos">
                    <AccordionTrigger className="font-display text-sm">Dados básicos</AccordionTrigger>
                    <AccordionContent className="space-y-4 pt-2">
                      <div className="space-y-2">
                        <Label>Nome do treinamento</Label>
                        <Input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex: NR-35 turma jan/2026" />
                      </div>
                      <div className="space-y-2">
                        <Label>Empresa contratante</Label>
                        <Select value={empresaId || "none"} onValueChange={(v) => setEmpresaId(v === "none" ? "" : v)}>
                          <SelectTrigger><SelectValue placeholder="Selecionar..." /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">— Sem empresa vinculada —</SelectItem>
                            {empresas.map((e) => (
                              <SelectItem key={e.id} value={e.id}>{e.nome_empresa}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <Label>Modalidade</Label>
                          <Select value={modalidade} onValueChange={(v) => setModalidade(v as ModalidadeTreinamento)}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="presencial">Presencial</SelectItem>
                              <SelectItem value="ead">EAD</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Diária do Instrutor (R$)</Label>
                          <Input
                            type="number" min={0} step="0.01"
                            value={diariaInstrutor}
                            onChange={(e) => setDiariaInstrutor(e.target.value)}
                            disabled={modalidade === "ead"}
                            placeholder={modalidade === "ead" ? "— (EAD)" : "0,00"}
                          />
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="financeiro">
                    <AccordionTrigger className="font-display text-sm">Financeiro & datas</AccordionTrigger>
                    <AccordionContent className="space-y-4 pt-2">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <Label>Data do treinamento</Label>
                          <Input type="date" value={dataTreinamento} onChange={(e) => setDataTreinamento(e.target.value)} />
                        </div>
                        <div className="space-y-2">
                          <Label>Data do pagamento</Label>
                          <Input type="date" value={dataPagamento} onChange={(e) => setDataPagamento(e.target.value)} />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Valor bruto (R$)</Label>
                        <Input
                          type="number" min={0} step="0.01"
                          value={valorBruto}
                          onChange={(e) => setValorBruto(e.target.value)}
                          placeholder="0,00"
                        />
                        {valorBruto && isFinite(parseFloat(valorBruto.replace(",", "."))) && (
                          <p className="text-xs text-muted-foreground">
                            Comissão calculada: <span className="font-medium text-foreground">
                              {fmtBRL(parseFloat(valorBruto.replace(",", ".")) * COMISSAO_TREINAMENTO)}
                            </span>
                          </p>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="obs">
                    <AccordionTrigger className="font-display text-sm">Observações</AccordionTrigger>
                    <AccordionContent className="pt-2">
                      <Textarea value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Notas internas sobre esse treinamento..." />
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>

                <Button onClick={handleSave} className="w-full" disabled={insertMutation.isPending || updateMutation.isPending}>
                  {insertMutation.isPending || updateMutation.isPending
                    ? "Salvando..."
                    : editingId ? "Atualizar Treinamento" : "Salvar Treinamento"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Filtros */}
      <Card className="border-border/50">
        <CardContent className="p-4 space-y-3">
          <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
            <div className="flex gap-2 items-center flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input className="pl-8" placeholder="Buscar treinamento..." value={filterSearch} onChange={(e) => setFilterSearch(e.target.value)} />
              </div>
              <CollapsibleTrigger asChild>
                <Button variant="outline" size="sm">
                  <SlidersHorizontal className="h-4 w-4 mr-1.5" />
                  Filtros
                  {activeFilters > 0 && (
                    <Badge variant="secondary" className="ml-2 h-5 min-w-5 px-1.5">{activeFilters}</Badge>
                  )}
                  <ChevronDown className={`h-4 w-4 ml-1 transition-transform ${filtersOpen ? "rotate-180" : ""}`} />
                </Button>
              </CollapsibleTrigger>
              <Badge variant="secondary">{filtered.length} de {treinamentos.length}</Badge>
              {activeFilters > 0 && (
                <Button variant="ghost" size="sm" onClick={clearAllFilters}>
                  <X className="h-3.5 w-3.5 mr-1" /> Limpar
                </Button>
              )}
            </div>
            <CollapsibleContent className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 mt-3 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Empresa</Label>
                  <Select value={filterEmpresa} onValueChange={setFilterEmpresa}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todas</SelectItem>
                      {empresas.map((em) => (
                        <SelectItem key={em.id} value={em.id}>{em.razao_social || em.nome_fantasia}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Modalidade</Label>
                  <Select value={filterModalidade} onValueChange={setFilterModalidade}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todas</SelectItem>
                      <SelectItem value="presencial">Presencial</SelectItem>
                      <SelectItem value="ead">EAD</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Mês/Ano</Label>
                  <Select value={filterMes} onValueChange={setFilterMes}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos</SelectItem>
                      {mesesDisponiveis.map((m) => {
                        const [y, mm] = m.split("-");
                        return <SelectItem key={m} value={m}>{mm}/{y}</SelectItem>;
                      })}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Data de</Label>
                  <Input type="date" value={filterDataDe} onChange={(e) => setFilterDataDe(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Data até</Label>
                  <Input type="date" value={filterDataAte} onChange={(e) => setFilterDataAte(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Valor mín. (R$)</Label>
                  <Input type="number" placeholder="0" value={filterValorMin} onChange={(e) => setFilterValorMin(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Valor máx. (R$)</Label>
                  <Input type="number" placeholder="∞" value={filterValorMax} onChange={(e) => setFilterValorMax(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Pagamento</Label>
                  <Select value={filterPgto} onValueChange={setFilterPgto}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos</SelectItem>
                      <SelectItem value="pago">Pago</SelectItem>
                      <SelectItem value="pendente">Pendente</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Ordenar por</Label>
                  <Select value={sortBy} onValueChange={setSortBy}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="data-desc">Data (recente)</SelectItem>
                      <SelectItem value="data-asc">Data (antiga)</SelectItem>
                      <SelectItem value="valor-desc">Valor (maior)</SelectItem>
                      <SelectItem value="valor-asc">Valor (menor)</SelectItem>
                      <SelectItem value="nome-asc">Nome (A-Z)</SelectItem>
                      <SelectItem value="nome-desc">Nome (Z-A)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      {/* Dashboard */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <StatCard icon={GraduationCap} label="Treinamentos" value={String(stats.count)} />
        <StatCard icon={Wallet} label="Valor bruto" value={fmtBRL(stats.totalBruto)} />
        <StatCard icon={TrendingUp} label="Comissão (7%)" value={fmtBRL(stats.totalComissao)} highlight />
        <StatCard icon={Calendar} label="Média / treinamento" value={fmtBRL(stats.media)} />
      </div>

      <Card className="border-border/50">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Treinamento</TableHead>
                <TableHead>Empresa</TableHead>
                <TableHead>Modalidade</TableHead>
                <TableHead>Data</TableHead>
                <TableHead className="text-right">Valor bruto</TableHead>
                <TableHead className="text-right">Comissão</TableHead>
                <TableHead>Pagamento</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((t: any) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.nome}</TableCell>
                  <TableCell className="text-sm">{t.empresa?.nome_empresa || <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>
                    <Badge variant={t.modalidade === "ead" ? "secondary" : "default"} className="text-[10px]">
                      {t.modalidade === "ead" ? "EAD" : "Presencial"}
                    </Badge>
                    {t.modalidade === "presencial" && t.diaria_instrutor != null && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">diária {fmtBRL(Number(t.diaria_instrutor))}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{new Date(t.data_treinamento).toLocaleDateString("pt-BR")}</TableCell>
                  <TableCell className="text-right text-sm font-mono">{fmtBRL(Number(t.valor_bruto))}</TableCell>
                  <TableCell className="text-right text-sm font-mono text-success">{fmtBRL(Number(t.valor_comissao))}</TableCell>
                  <TableCell className="text-sm">
                    {t.data_pagamento
                      ? new Date(t.data_pagamento).toLocaleDateString("pt-BR")
                      : <Badge variant="outline" className="text-[10px]">pendente</Badge>}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(t)} title="Editar">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setDeleteConfirm(t.id)} title="Excluir">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                    {isLoading ? "Carregando..." : "Nenhum treinamento cadastrado neste período."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AlertDialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar exclusão</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir este treinamento?
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
    </div>
  );
}

function StatCard({ icon: Icon, label, value, highlight }: { icon: any; label: string; value: string; highlight?: boolean }) {
  return (
    <Card className={highlight ? "border-primary/40" : "border-border/50"}>
      <CardContent className="p-5 flex items-center gap-3">
        <div className={`rounded-lg p-2.5 ${highlight ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">{label}</p>
          <p className={`font-display font-bold tracking-tight truncate text-2xl mt-1 ${highlight ? "text-primary" : ""}`}>{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}
