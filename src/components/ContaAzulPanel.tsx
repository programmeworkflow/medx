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
import { CheckCircle2, AlertCircle, Plus, ExternalLink, Power, KeyRound } from "lucide-react";
import { formatCnpjCpf } from "@/lib/format";
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

interface CognitoStatus {
  connected: boolean;
  email?: string;
  access_token_expires_at?: string;
  access_token_expires_in_seconds?: number;
}

export default function ContaAzulPanel() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<CAStatus | null>(null);
  const [cogStatus, setCogStatus] = useState<CognitoStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [cogOpen, setCogOpen] = useState(false);
  const [cogEmail, setCogEmail] = useState("");
  const [cogSenha, setCogSenha] = useState("");
  const [cogTotp, setCogTotp] = useState("");
  const [cogSubmitting, setCogSubmitting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // form fields
  const [empresaId, setEmpresaId] = useState<string>("");
  const [servicoId, setServicoId] = useState<string>("");
  const [valor, setValor] = useState("");
  const [dataVenda, setDataVenda] = useState(new Date().toISOString().slice(0, 10));
  // Mês de referência (default: mês anterior)
  const hoje = new Date();
  const mesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  const [mesRef, setMesRef] = useState<number>(mesAnterior.getMonth() + 1);
  const [anoRef, setAnoRef] = useState<number>(mesAnterior.getFullYear());
  const [obsModo, setObsModo] = useState<"auto" | "manual">("auto");
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
  const { data: servicos = [] } = useQuery({
    queryKey: ["ca-servicos"],
    queryFn: async () => {
      const r = await fetch(`${API_BASE}/api/contaazul/services`);
      const j = await r.json();
      return (j?.items as { id: string; nome: string; valor?: number }[]) || [];
    },
    enabled: !!status?.connected,
  });

  const MESES = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
  ];
  const servicoSelecionado = servicos.find((s) => s.id === servicoId);
  const observacaoAutomatica = (() => {
    const nome = servicoSelecionado?.nome || "—";
    const v = Number(valor.replace(",", ".") || 0);
    const valorFmt = v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `Referente ao(s) ${nome} do mês de ${MESES[mesRef - 1]}/${anoRef}\nValor total: R$ ${valorFmt}`;
  })();

  // Em modo auto, o texto regenera quando dependências mudam — desde que o
  // user não tenha editado (compara com último template aplicado).
  const [obsLastTemplate, setObsLastTemplate] = useState("");
  useEffect(() => {
    if (obsModo === "auto") {
      if (obs === "" || obs === obsLastTemplate) {
        setObs(observacaoAutomatica);
        setObsLastTemplate(observacaoAutomatica);
      }
    }
  }, [obsModo, observacaoAutomatica]);

  const loadStatus = async () => {
    try {
      const r = await fetch(`${API_BASE}/api/contaazul/status`);
      const j = await r.json();
      setStatus(j);
    } catch (_) {
      setStatus({ connected: false });
    }
    try {
      const r = await fetch(`${API_BASE}/api/contaazul/cognito-status`);
      const j = await r.json();
      setCogStatus(j);
    } catch (_) {
      setCogStatus({ connected: false });
    }
  };

  const handleCognitoLogin = async () => {
    if (!cogEmail || !cogSenha) {
      return toast.error("Email e senha obrigatórios");
    }
    setCogSubmitting(true);
    try {
      const r = await fetch(`${API_BASE}/api/contaazul/cognito-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: cogEmail,
          senha: cogSenha,
          totp_code: cogTotp || undefined,
        }),
      });
      const j = await r.json();
      if (j.mfa_required) {
        toast.warning("Conta exige código TOTP do app autenticador");
        setCogSubmitting(false);
        return;
      }
      if (!j.ok) throw new Error(j.error || "erro");
      toast.success("Login Cognito ok — sessão renovará automática por ~30 dias");
      setCogOpen(false);
      setCogSenha("");
      setCogTotp("");
      loadStatus();
    } catch (e: any) {
      toast.error(`Erro: ${e?.message}`);
    } finally {
      setCogSubmitting(false);
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
    if (!servicoId) return toast.error("Selecione o serviço");
    if (!valor) return toast.error("Informe o valor");
    const empresaCC = (empresa as any).centro_custo_id;
    if (!empresaCC) {
      return toast.error(
        `Empresa "${empresa.nome_empresa}" sem centro de custo cadastrado. Configure em Cadastros → Empresas.`
      );
    }
    const observacaoFinal = obs;
    setSubmitting(true);
    try {
      const r = await fetch(`${API_BASE}/api/contaazul/create-receivable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cnpj: empresa.cnpj,
          razao_social: empresa.nome_empresa,
          centro_custo_id: empresaCC,
          servico_id: servicoId,
          servico: servicoSelecionado?.nome || "Serviço",
          valor: Number(valor.replace(",", ".")),
          data_venda: dataVenda,
          observacoes: observacaoFinal,
          mes_referencia: mesRef,
          ano_referencia: anoRef,
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
      setServicoId(""); setValor(""); setObs(""); setEmitirNF(false); setEmitirBoleto(false);
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
            Token OAuth2 válido por mais {Math.max(0, Math.floor(status.expires_in_seconds / 60))} minutos
            (renovação automática quando expirar)
          </p>
        )}

        {/* Sessão Cognito (BFF) — usada pra emitir NF e boleto */}
        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="font-medium">Sessão Cognito (NF + boleto)</div>
                <div className="text-xs text-muted-foreground">
                  {cogStatus?.connected
                    ? `Conectado como ${cogStatus.email} — token expira em ${
                        cogStatus.access_token_expires_in_seconds != null
                          ? Math.max(0, Math.floor(cogStatus.access_token_expires_in_seconds / 3600))
                          : "?"
                      }h (renovação automática)`
                    : "Não conectado — login válido por ~30 dias"}
                </div>
              </div>
            </div>
            <Dialog open={cogOpen} onOpenChange={setCogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  {cogStatus?.connected ? "Re-logar" : "Logar Cognito"}
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle className="font-display">Login Conta Azul (Cognito)</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 mt-2">
                  <p className="text-xs text-muted-foreground">
                    Login direto no AWS Cognito da Conta Azul. O refresh token salvo aqui vale
                    ~30 dias e renova o acesso à NF/boleto sozinho. Você só faz isso de novo quando
                    o sistema avisar.
                  </p>
                  <div className="space-y-2">
                    <Label>Email Conta Azul</Label>
                    <Input
                      type="email"
                      value={cogEmail}
                      onChange={(e) => setCogEmail(e.target.value)}
                      placeholder="financeiro@empresa.com.br"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Senha</Label>
                    <Input
                      type="password"
                      value={cogSenha}
                      onChange={(e) => setCogSenha(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Código do app autenticador (TOTP)</Label>
                    <Input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={cogTotp}
                      onChange={(e) => setCogTotp(e.target.value.replace(/\D/g, ""))}
                      placeholder="6 dígitos"
                    />
                    <p className="text-xs text-muted-foreground">
                      Abra Google Authenticator (ou similar), pegue o código atual da Conta Azul.
                    </p>
                  </div>
                  <Button
                    onClick={handleCognitoLogin}
                    disabled={cogSubmitting}
                    className="w-full"
                  >
                    {cogSubmitting ? "Logando..." : "Logar"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

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
                          {e.nome_empresa} ({formatCnpjCpf(e.cnpj)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Serviço</Label>
                  <Select value={servicoId} onValueChange={setServicoId}>
                    <SelectTrigger>
                      <SelectValue placeholder={servicos.length ? "Selecionar..." : "Carregando..."} />
                    </SelectTrigger>
                    <SelectContent>
                      {servicos.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.nome}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-3 gap-3">
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
                    <Label>Mês de referência</Label>
                    <Select
                      value={String(mesRef)}
                      onValueChange={(v) => setMesRef(Number(v))}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {MESES.map((m, i) => (
                          <SelectItem key={i + 1} value={String(i + 1)}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Ano</Label>
                    <Select
                      value={String(anoRef)}
                      onValueChange={(v) => setAnoRef(Number(v))}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {[hoje.getFullYear() - 1, hoje.getFullYear(), hoje.getFullYear() + 1].map((a) => (
                          <SelectItem key={a} value={String(a)}>{a}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Data da venda</Label>
                  <Input
                    type="date"
                    value={dataVenda}
                    onChange={(e) => setDataVenda(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <Label>Observações da NF</Label>
                    <div className="flex items-center gap-2">
                      {obsModo === "auto" && (
                        <button
                          type="button"
                          onClick={() => {
                            setObs(observacaoAutomatica);
                            setObsLastTemplate(observacaoAutomatica);
                          }}
                          className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                        >
                          ↻ Regenerar
                        </button>
                      )}
                      <div className="flex gap-1 rounded-md border p-0.5">
                        <button
                          type="button"
                          onClick={() => {
                            setObsModo("auto");
                            setObs(observacaoAutomatica);
                            setObsLastTemplate(observacaoAutomatica);
                          }}
                          className={`px-2 py-0.5 text-xs rounded ${obsModo === "auto" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                        >
                          Gerar automático
                        </button>
                        <button
                          type="button"
                          onClick={() => setObsModo("manual")}
                          className={`px-2 py-0.5 text-xs rounded ${obsModo === "manual" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                        >
                          Manual
                        </button>
                      </div>
                    </div>
                  </div>
                  <Textarea
                    value={obs}
                    onChange={(e) => setObs(e.target.value)}
                    placeholder={
                      obsModo === "auto"
                        ? "Texto gerado automaticamente — pode editar"
                        : "Texto livre que vai no campo Observações da NF"
                    }
                    rows={4}
                  />
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
