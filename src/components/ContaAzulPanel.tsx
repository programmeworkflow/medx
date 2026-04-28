import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CheckCircle2, AlertCircle, Plus, ExternalLink, Power } from "lucide-react";
import { toast } from "sonner";
import { fetchEmpresas, type Empresa } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import FaturarEmMassaDialog from "./FaturarEmMassaDialog";

const API_BASE = "";

interface CAStatus {
  connected: boolean;
  expires_at?: string;
  expires_in_seconds?: number;
}

export default function ContaAzulPanel() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<CAStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // form fields
  const [empresaId, setEmpresaId] = useState<string>("");
  const [centroCustoId, setCentroCustoId] = useState<string>("");
  const [servico, setServico] = useState("");
  const [valor, setValor] = useState("");
  const [dataVenda, setDataVenda] = useState(new Date().toISOString().slice(0, 10));
  const [obs, setObs] = useState("");
  const [emitirNF, setEmitirNF] = useState(false);
  const [emitirBoleto, setEmitirBoleto] = useState(false);

  const { data: empresas = [] } = useQuery({ queryKey: ["empresas"], queryFn: fetchEmpresas });
  const { data: centros = [] } = useQuery({
    queryKey: ["ca-centros-custo"],
    queryFn: async () => {
      const r = await fetch(`${API_BASE}/api/contaazul/cost-centers`);
      const j = await r.json();
      return (j?.items as { id: string; nome: string }[]) || [];
    },
    enabled: !!status?.connected,
  });

  const loadStatus = async () => {
    try {
      const r = await fetch(`${API_BASE}/api/contaazul/status`);
      const j = await r.json();
      setStatus(j);
    } catch (_) {
      setStatus({ connected: false });
    }
  };

  useEffect(() => {
    loadStatus();
    if (params.get("ca_connected") === "1") {
      toast.success("Conta Azul conectada com sucesso!");
      params.delete("ca_connected");
      setParams(params, { replace: true });
    }
    const err = params.get("ca_error");
    if (err) {
      toast.error(`Conta Azul: ${err}`);
      params.delete("ca_error");
      setParams(params, { replace: true });
    }
  }, []);

  const handleConnect = async () => {
    try {
      const r = await fetch(`${API_BASE}/api/contaazul/authorize`);
      const j = await r.json();
      if (!j.url) return toast.error("URL OAuth não retornada");
      // Abre em nova aba (sai do iframe). Após autorizar, callback redireciona
      // pra /faturamento?ca_connected=1, e essa página atualiza o status no proximo poll.
      window.open(j.url, "_blank", "noopener,noreferrer");
      toast.info("Autorizando na Conta Azul em nova aba…");
      // Polling do status por 60s pra detectar quando conectar
      let tries = 0;
      const poll = setInterval(async () => {
        tries++;
        const r = await fetch(`${API_BASE}/api/contaazul/status`);
        const j = await r.json();
        if (j.connected) {
          clearInterval(poll);
          setStatus(j);
          toast.success("Conta Azul conectada!");
        } else if (tries > 30) {
          clearInterval(poll);
        }
      }, 2000);
    } catch (e: any) {
      toast.error(`Erro: ${e?.message}`);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("Desconectar Conta Azul?")) return;
    await fetch(`${API_BASE}/api/contaazul/disconnect`, { method: "POST" });
    toast.success("Desconectado");
    loadStatus();
  };

  const handleCreateSale = async () => {
    const empresa = empresas.find((e) => e.id === empresaId);
    if (!empresa) return toast.error("Selecione uma empresa");
    if (!centroCustoId) return toast.error("Selecione o centro de custo");
    if (!servico) return toast.error("Informe a descrição");
    if (!valor) return toast.error("Informe o valor");
    setSubmitting(true);
    try {
      const r = await fetch(`${API_BASE}/api/contaazul/create-receivable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cnpj: empresa.cnpj,
          razao_social: empresa.nome_empresa,
          centro_custo_id: centroCustoId,
          servico,
          valor: Number(valor.replace(",", ".")),
          data_venda: dataVenda,
          observacoes: obs,
          emitir_nf: emitirNF,
          emitir_boleto: emitirBoleto,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Erro ao criar venda");
      const partes: string[] = ["Venda criada"];
      if (j?.nf?.status === "emitida") partes.push("NF emitida");
      else if (j?.nf?.status === "em_processamento") partes.push("NF em processamento");
      else if (j?.nf?.status === "erro") partes.push(`NF erro: ${j.nf.erro || "?"}`);
      if (j?.boleto?.status === "solicitado") partes.push("boleto gerado");
      else if (j?.boleto?.status === "erro") partes.push(`boleto erro: ${j.boleto.erro || "?"}`);
      toast.success(partes.join(" — "));
      setOpen(false);
      setServico(""); setValor(""); setObs(""); setEmitirNF(false); setEmitirBoleto(false); setCentroCustoId("");
    } catch (e: any) {
      toast.error(`${e?.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="border-border/50">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="font-display text-[1.375rem] font-semibold tracking-tight">
              Conta Azul
            </h2>
            <p className="text-sm text-muted-foreground">
              Lance vendas de serviço direto no Conta Azul a partir das empresas cadastradas
            </p>
          </div>
          {status?.connected ? (
            <div className="flex items-center gap-2">
              <Badge variant="default" className="gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> Conectado
              </Badge>
              <Button variant="outline" size="sm" onClick={handleDisconnect}>
                <Power className="h-4 w-4 mr-1.5" /> Desconectar
              </Button>
            </div>
          ) : (
            <Button onClick={handleConnect}>
              <ExternalLink className="h-4 w-4 mr-1.5" /> Conectar Conta Azul
            </Button>
          )}
        </div>

        {status?.connected && status.expires_in_seconds != null && (
          <p className="text-xs text-muted-foreground">
            Token válido por mais {Math.max(0, Math.floor(status.expires_in_seconds / 60))} minutos
            (renovação automática quando expirar)
          </p>
        )}

        {!status?.connected && (
          <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 text-warning" />
              <div>
                <p className="font-medium">Conexão pendente</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Clique em "Conectar Conta Azul" pra autorizar o MedX a criar vendas em sua conta.
                </p>
              </div>
            </div>
          </div>
        )}

        {status?.connected && (
          <div className="flex flex-wrap gap-2">
            <FaturarEmMassaDialog centros={centros} />
            <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" className="w-full sm:w-auto">
                <Plus className="h-4 w-4 mr-1.5" /> Faturar avulso
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle className="font-display">Faturar — Conta Azul</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-2">
                <div className="space-y-2">
                  <Label>Empresa cliente</Label>
                  <Select value={empresaId} onValueChange={setEmpresaId}>
                    <SelectTrigger><SelectValue placeholder="Selecionar..." /></SelectTrigger>
                    <SelectContent>
                      {empresas.map((e: Empresa) => (
                        <SelectItem key={e.id} value={e.id}>
                          {e.nome_empresa} ({e.cnpj})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Centro de custo</Label>
                  <Select value={centroCustoId} onValueChange={setCentroCustoId}>
                    <SelectTrigger><SelectValue placeholder="Selecionar..." /></SelectTrigger>
                    <SelectContent>
                      {centros.map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Descrição</Label>
                  <Input
                    value={servico}
                    onChange={(e) => setServico(e.target.value)}
                    placeholder="Ex: Referente aos exames do mês de abril/2026"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>Valor (R$)</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={valor}
                      onChange={(e) => setValor(e.target.value)}
                      placeholder="0,00"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Data da venda</Label>
                    <Input
                      type="date"
                      value={dataVenda}
                      onChange={(e) => setDataVenda(e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Observações</Label>
                  <Textarea value={obs} onChange={(e) => setObs(e.target.value)} />
                </div>
                <label className="flex items-start gap-2 cursor-pointer p-3 rounded-lg border border-border hover:border-primary/50 transition-colors">
                  <input
                    type="checkbox"
                    checked={emitirNF}
                    onChange={(e) => setEmitirNF(e.target.checked)}
                    className="mt-0.5"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium">Emitir NFS-e automaticamente</div>
                    <div className="text-xs text-muted-foreground">
                      Após criar a venda, transmite a NFS-e à prefeitura via Conta Azul.
                    </div>
                  </div>
                </label>
                <label className="flex items-start gap-2 cursor-pointer p-3 rounded-lg border border-border hover:border-primary/50 transition-colors">
                  <input
                    type="checkbox"
                    checked={emitirBoleto}
                    onChange={(e) => setEmitirBoleto(e.target.checked)}
                    className="mt-0.5"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium">Gerar boleto bancário</div>
                    <div className="text-xs text-muted-foreground">
                      Emite boleto pela conta Receba Fácil cadastrada na Conta Azul.
                    </div>
                  </div>
                </label>
                <Button
                  onClick={handleCreateSale}
                  disabled={submitting}
                  className="w-full"
                >
                  {submitting ? "Criando..." : "Faturar"}
                </Button>
              </div>
            </DialogContent>
            </Dialog>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
