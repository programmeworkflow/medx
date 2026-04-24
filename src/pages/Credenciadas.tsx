import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Plus, Search, Pencil, Trash2, FileText, Download, Upload, AlertTriangle, AlarmClock } from "lucide-react";
import { toast } from "sonner";
import {
  fetchCredenciadas,
  insertCredenciada,
  updateCredenciada,
  deleteCredenciada,
  uploadCredenciadaFile,
  getCredenciadaFileUrl,
  classificaReajusteCredenciada,
  type Credenciada,
  type CredenciadaInsert,
} from "@/lib/api";

export default function Credenciadas() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Form state
  const [nome, setNome] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [possuiContrato, setPossuiContrato] = useState(false);
  const [dataContrato, setDataContrato] = useState("");
  const [emailFat, setEmailFat] = useState("");
  const [enviaCorreios, setEnviaCorreios] = useState(false);
  const [enderecoDespacho, setEnderecoDespacho] = useState("");
  const [cep, setCep] = useState("");
  const [obs, setObs] = useState("");
  const [ativa, setAtiva] = useState(true);
  const [tabelaPrecoFile, setTabelaPrecoFile] = useState<File | null>(null);
  const [contratoFile, setContratoFile] = useState<File | null>(null);
  const [existingTabelaPrecoUrl, setExistingTabelaPrecoUrl] = useState<string | null>(null);
  const [existingContratoUrl, setExistingContratoUrl] = useState<string | null>(null);

  const { data: credenciadas = [], isLoading } = useQuery({
    queryKey: ["credenciadas"],
    queryFn: fetchCredenciadas,
  });

  const insertMutation = useMutation({
    mutationFn: async (payload: CredenciadaInsert & { _tabelaPrecoFile?: File; _contratoFile?: File }) => {
      const { _tabelaPrecoFile, _contratoFile, ...insert } = payload;
      const created = await insertCredenciada(insert);
      const patch: Partial<CredenciadaInsert> = {};
      if (_tabelaPrecoFile) {
        patch.tabela_preco_url = await uploadCredenciadaFile("tabelas-preco", created.id, _tabelaPrecoFile);
      }
      if (_contratoFile) {
        patch.contrato_url = await uploadCredenciadaFile("contratos-credenciadas", created.id, _contratoFile);
      }
      if (Object.keys(patch).length > 0) {
        await updateCredenciada(created.id, patch);
      }
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credenciadas"] });
      setOpen(false);
      resetForm();
      toast.success("Credenciada cadastrada!");
    },
    onError: (err: any) => {
      toast.error(err.message?.includes("duplicate") ? "CNPJ já cadastrado." : `Erro: ${err.message}`);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      updates,
      _tabelaPrecoFile,
      _contratoFile,
    }: {
      id: string;
      updates: Partial<CredenciadaInsert>;
      _tabelaPrecoFile?: File;
      _contratoFile?: File;
    }) => {
      const patch: Partial<CredenciadaInsert> = { ...updates };
      if (_tabelaPrecoFile) {
        patch.tabela_preco_url = await uploadCredenciadaFile("tabelas-preco", id, _tabelaPrecoFile);
      }
      if (_contratoFile) {
        patch.contrato_url = await uploadCredenciadaFile("contratos-credenciadas", id, _contratoFile);
      }
      await updateCredenciada(id, patch);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credenciadas"] });
      setOpen(false);
      setEditingId(null);
      resetForm();
      toast.success("Credenciada atualizada!");
    },
    onError: (err: any) => toast.error(`Erro ao atualizar: ${err.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteCredenciada,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credenciadas"] });
      toast.success("Credenciada excluída!");
    },
    onError: () => toast.error("Erro ao excluir. Pode ter vínculos em outras tabelas."),
  });

  const resetForm = () => {
    setNome(""); setCnpj(""); setPossuiContrato(false); setDataContrato("");
    setEmailFat(""); setEnviaCorreios(false); setEnderecoDespacho(""); setCep("");
    setObs(""); setAtiva(true); setTabelaPrecoFile(null); setContratoFile(null);
    setExistingTabelaPrecoUrl(null); setExistingContratoUrl(null);
  };

  const openEdit = (c: Credenciada) => {
    setEditingId(c.id);
    setNome(c.nome);
    setCnpj(c.cnpj);
    setPossuiContrato(c.possui_contrato);
    setDataContrato(c.data_contrato || "");
    setEmailFat(c.email_faturamento || "");
    setEnviaCorreios(c.envia_correios);
    setEnderecoDespacho(c.endereco_despacho || "");
    setCep(c.cep || "");
    setObs(c.observacoes || "");
    setAtiva(c.ativa);
    setTabelaPrecoFile(null);
    setContratoFile(null);
    setExistingTabelaPrecoUrl(c.tabela_preco_url);
    setExistingContratoUrl(c.contrato_url);
    setOpen(true);
  };

  const handleSave = () => {
    if (!nome || !cnpj) {
      toast.error("Nome e CNPJ são obrigatórios.");
      return;
    }
    const payload: CredenciadaInsert = {
      nome,
      cnpj,
      possui_contrato: possuiContrato,
      data_contrato: possuiContrato && dataContrato ? dataContrato : null,
      email_faturamento: emailFat || null,
      envia_correios: enviaCorreios,
      endereco_despacho: enviaCorreios && enderecoDespacho ? enderecoDespacho : null,
      cep: enviaCorreios && cep ? cep : null,
      observacoes: obs || null,
      ativa,
    };
    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        updates: payload,
        _tabelaPrecoFile: tabelaPrecoFile || undefined,
        _contratoFile: contratoFile || undefined,
      });
    } else {
      insertMutation.mutate({
        ...payload,
        _tabelaPrecoFile: tabelaPrecoFile || undefined,
        _contratoFile: contratoFile || undefined,
      });
    }
  };

  const openFile = useCallback(async (bucket: "contratos-credenciadas" | "tabelas-preco", path: string) => {
    try {
      const url = await getCredenciadaFileUrl(bucket, path);
      window.open(url, "_blank");
    } catch (err: any) {
      toast.error(`Erro ao abrir arquivo: ${err.message}`);
    }
  }, []);

  const filtered = credenciadas.filter((c) =>
    c.nome.toLowerCase().includes(search.toLowerCase()) || c.cnpj.includes(search)
  );

  const alertasReajuste = filtered
    .map((c) => ({ c, cat: classificaReajusteCredenciada(c.data_contrato) }))
    .filter((x) => x.cat !== null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="font-display text-xl font-bold">Credenciadas</h2>
          <p className="text-sm text-muted-foreground">{credenciadas.length} cadastradas</p>
        </div>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditingId(null); resetForm(); } }}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 mr-2" /> Nova Credenciada</Button>
          </DialogTrigger>
          <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="font-display">{editingId ? "Editar Credenciada" : "Cadastrar Credenciada"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2 col-span-2">
                  <Label>Nome</Label>
                  <Input value={nome} onChange={(e) => setNome(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>CNPJ</Label>
                  <Input value={cnpj} onChange={(e) => setCnpj(e.target.value)} placeholder="00.000.000/0000-00" />
                </div>
                <div className="space-y-2">
                  <Label>E-mail para faturamento</Label>
                  <Input type="email" value={emailFat} onChange={(e) => setEmailFat(e.target.value)} placeholder="financeiro@credenciada.com" />
                </div>
              </div>

              <div className="rounded-lg border border-border p-3 space-y-3">
                <div className="flex items-center gap-3">
                  <Switch id="possui-contrato" checked={possuiContrato} onCheckedChange={setPossuiContrato} />
                  <Label htmlFor="possui-contrato">Possui contrato</Label>
                </div>
                {possuiContrato && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>Data do contrato</Label>
                      <Input type="date" value={dataContrato} onChange={(e) => setDataContrato(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Upload do contrato (PDF)</Label>
                      <Input type="file" accept=".pdf,.doc,.docx,image/*" onChange={(e) => setContratoFile(e.target.files?.[0] || null)} />
                      {existingContratoUrl && !contratoFile && (
                        <button
                          type="button"
                          onClick={() => openFile("contratos-credenciadas", existingContratoUrl!)}
                          className="text-xs text-primary flex items-center gap-1 hover:underline"
                        >
                          <FileText className="h-3 w-3" /> Ver contrato atual
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-border p-3 space-y-3">
                <div className="flex items-center gap-3">
                  <Switch id="envia-correios" checked={enviaCorreios} onCheckedChange={setEnviaCorreios} />
                  <Label htmlFor="envia-correios">Despacha por Correios</Label>
                </div>
                {enviaCorreios && (
                  <div className="grid grid-cols-[1fr,140px] gap-3">
                    <div className="space-y-2">
                      <Label>Endereço de despacho</Label>
                      <Input value={enderecoDespacho} onChange={(e) => setEnderecoDespacho(e.target.value)} placeholder="Rua, número, bairro, cidade/UF" />
                    </div>
                    <div className="space-y-2">
                      <Label>CEP</Label>
                      <Input value={cep} onChange={(e) => setCep(e.target.value)} placeholder="00000-000" />
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label>Tabela de preços (arquivo)</Label>
                <Input type="file" accept=".pdf,.xlsx,.xls,.csv,image/*" onChange={(e) => setTabelaPrecoFile(e.target.files?.[0] || null)} />
                {existingTabelaPrecoUrl && !tabelaPrecoFile && (
                  <button
                    type="button"
                    onClick={() => openFile("tabelas-preco", existingTabelaPrecoUrl!)}
                    className="text-xs text-primary flex items-center gap-1 hover:underline"
                  >
                    <FileText className="h-3 w-3" /> Ver tabela atual
                  </button>
                )}
              </div>

              <div className="space-y-2">
                <Label>Observações</Label>
                <Textarea value={obs} onChange={(e) => setObs(e.target.value)} />
              </div>

              <div className="flex items-center gap-3">
                <Switch id="ativa" checked={ativa} onCheckedChange={setAtiva} />
                <Label htmlFor="ativa">Ativa</Label>
              </div>

              <Button
                onClick={handleSave}
                className="w-full"
                disabled={insertMutation.isPending || updateMutation.isPending}
              >
                {insertMutation.isPending || updateMutation.isPending
                  ? "Salvando..."
                  : editingId ? "Atualizar Credenciada" : "Salvar Credenciada"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Alert summary */}
      {alertasReajuste.length > 0 && (
        <Card className="border-warning/30 bg-warning/5">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-sm">Atenção: contratos precisando de atualização</p>
              <p className="text-xs text-muted-foreground mt-1">
                {alertasReajuste.filter(a => a.cat === "reajuste_proximo").length} próximos de 1 ano •{" "}
                {alertasReajuste.filter(a => a.cat === "atrasado_1ano").length} vencidos 1+ ano •{" "}
                {alertasReajuste.filter(a => a.cat === "atrasado_2anos").length} vencidos 2+ anos
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Buscar por nome ou CNPJ..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10" />
      </div>

      <Card className="border-border/50">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Credenciada</TableHead>
                <TableHead>CNPJ</TableHead>
                <TableHead>Contrato</TableHead>
                <TableHead>Correios</TableHead>
                <TableHead>Arquivos</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((c) => {
                const cat = classificaReajusteCredenciada(c.data_contrato);
                return (
                  <TableRow key={c.id} className={!c.ativa ? "opacity-50" : ""}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {c.nome}
                        {cat === "reajuste_proximo" && (
                          <Badge variant="outline" className="border-warning text-warning text-[10px]">
                            <AlarmClock className="h-3 w-3 mr-1" />1 ano próximo
                          </Badge>
                        )}
                        {cat === "atrasado_1ano" && (
                          <Badge variant="outline" className="border-warning text-warning text-[10px]">
                            <AlertTriangle className="h-3 w-3 mr-1" />reajuste vencido
                          </Badge>
                        )}
                        {cat === "atrasado_2anos" && (
                          <Badge variant="destructive" className="text-[10px]">
                            <AlertTriangle className="h-3 w-3 mr-1" />+2 anos
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs font-mono">{c.cnpj}</TableCell>
                    <TableCell className="text-xs">
                      {c.possui_contrato ? (
                        <div>
                          <Badge variant="default" className="text-[10px]">Sim</Badge>
                          {c.data_contrato && (
                            <div className="text-muted-foreground mt-0.5">{new Date(c.data_contrato).toLocaleDateString("pt-BR")}</div>
                          )}
                        </div>
                      ) : <Badge variant="secondary" className="text-[10px]">Não</Badge>}
                    </TableCell>
                    <TableCell>
                      {c.envia_correios ? <Badge variant="default" className="text-[10px]">Sim</Badge> : <span className="text-xs text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {c.contrato_url && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openFile("contratos-credenciadas", c.contrato_url!)} title="Ver contrato">
                            <FileText className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {c.tabela_preco_url && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openFile("tabelas-preco", c.tabela_preco_url!)} title="Ver tabela">
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.ativa ? "default" : "destructive"} className="text-[10px]">{c.ativa ? "Ativa" : "Inativa"}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(c)} title="Editar">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setDeleteConfirm(c.id)} title="Excluir">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                    {isLoading ? "Carregando..." : "Nenhuma credenciada cadastrada."}
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
              Tem certeza que deseja excluir esta credenciada? Esta ação não pode ser desfeita.
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
