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
import { Plus, Pencil, Trash2, GraduationCap, Wallet, TrendingUp, Calendar } from "lucide-react";
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
  const [filterMes, setFilterMes] = useState<string>("all");

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
    if (filterMes === "all") return treinamentos;
    const [y, m] = filterMes.split("-").map(Number);
    return treinamentos.filter((t) => {
      const d = new Date(t.data_treinamento);
      return d.getFullYear() === y && d.getMonth() + 1 === m;
    });
  }, [treinamentos, filterMes]);

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
          <h1 className="font-display text-2xl font-bold">Treinamentos</h1>
          <p className="text-sm text-muted-foreground">
            {treinamentos.length} cadastrados • comissão fixa {(COMISSAO_TREINAMENTO * 100).toFixed(0)}%
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <Select value={filterMes} onValueChange={setFilterMes}>
            <SelectTrigger className="w-[180px]"><SelectValue placeholder="Período" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos períodos</SelectItem>
              {mesesDisponiveis.map((m) => {
                const [y, mm] = m.split("-");
                return <SelectItem key={m} value={m}>{mm}/{y}</SelectItem>;
              })}
            </SelectContent>
          </Select>
          <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditingId(null); resetForm(); } }}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> Novo Treinamento</Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="font-display">{editingId ? "Editar Treinamento" : "Cadastrar Treinamento"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-2">
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
                      type="number"
                      min={0}
                      step="0.01"
                      value={diariaInstrutor}
                      onChange={(e) => setDiariaInstrutor(e.target.value)}
                      disabled={modalidade === "ead"}
                      placeholder={modalidade === "ead" ? "— (EAD)" : "0,00"}
                    />
                  </div>
                </div>
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
                    type="number"
                    min={0}
                    step="0.01"
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
                <div className="space-y-2">
                  <Label>Observações</Label>
                  <Textarea value={obs} onChange={(e) => setObs(e.target.value)} />
                </div>
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
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`rounded-lg p-2 ${highlight ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className={`font-display font-bold truncate ${highlight ? "text-primary text-lg" : "text-base"}`}>{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}
