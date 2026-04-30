import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, CheckCircle2, ExternalLink, Mail, Wallet, XCircle } from "lucide-react";
import { toast } from "sonner";
import { formatCnpjCpf } from "@/lib/format";
import EnviarEmailDialog from "./EnviarEmailDialog";
import {
  fetchFaturamentos,
  fetchEmpresas,
  fetchCompetencias,
  calcularRetencao,
  updateFaturamentoStatus,
  MESES,
  type RetencaoPadrao,
} from "@/lib/api";

const fmtBRL = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

interface CentroCusto { id: string; nome: string; }

type NfModo = "nao_emite" | "manual" | "automatica";

interface Resultado {
  ok: boolean;
  vendaNumero?: number;
  vendaId?: string;
  nf: { status: string; erro?: string };
  boleto: { status: string; erro?: string };
  fatal?: string; // se a venda em si falhou (cadastro/auth/CA)
}

interface Linha {
  faturamentoId: string;
  empresaId: string;
  cnpj: string;
  nome: string;
  categoria: string;
  valor: number;
  semCadastro: boolean;
  nfModo: NfModo;
  linkEso: string | null;
  // editáveis
  selected: boolean;
  centroCustoId: string;
  dataVencimento: string;
  retencao: RetencaoPadrao;
  emitirNF: boolean;
  emitirBoleto: boolean;
  enviarEmail: boolean;
}

export default function FaturarEmMassaDialog({ centros: _centros }: { centros: CentroCusto[] }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const { data: competencias = [] } = useQuery({ queryKey: ["competencias"], queryFn: fetchCompetencias });
  // Competência selecionada — default = aberta (ou mais recente)
  const [compId, setCompId] = useState<string>("");
  useEffect(() => {
    if (compId) return;
    const aberta = competencias.find((c) => c.status === "aberto") || competencias[0];
    if (aberta?.id) setCompId(aberta.id);
  }, [competencias, compId]);
  const compAtual = competencias.find((c) => c.id === compId);

  const { data: faturamentos = [] } = useQuery({
    queryKey: ["faturamentos", compAtual?.id],
    queryFn: () => fetchFaturamentos(compAtual?.id ?? ""),
    enabled: !!compAtual?.id && open,
  });
  const { data: empresas = [] } = useQuery({ queryKey: ["empresas"], queryFn: fetchEmpresas, enabled: open });
  const empresasById = useMemo(() => new Map(empresas.map((e: any) => [e.id, e])), [empresas]);

  const [servicoPadrao, setServicoPadrao] = useState<string>("");
  const [categoriaPadrao, setCategoriaPadrao] = useState<string>("");
  // Vencimento padrão = hoje + 7 (formato YYYY-MM-DD)
  const [dataVencPadrao, setDataVencPadrao] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  });
  const hojeBatch = new Date();
  const [mesRefBatch, setMesRefBatch] = useState<number>(
    compAtual?.mes ?? new Date(hojeBatch.getFullYear(), hojeBatch.getMonth() - 1, 1).getMonth() + 1
  );
  const [anoRefBatch, setAnoRefBatch] = useState<number>(
    compAtual?.ano ?? hojeBatch.getFullYear()
  );
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [resultados, setResultados] = useState<Record<string, Resultado>>({});
  const [emailDialog, setEmailDialog] = useState<{ vendaId: string; numero?: number } | null>(null);
  const [ccPadrao, setCcPadrao] = useState<string>("medwork.financeiro@gmail.com");

  const servicosQ = useQuery({
    queryKey: ["ca-servicos"],
    queryFn: async () => {
      const r = await fetch("/api/contaazul/services");
      if (!r.ok) throw new Error(`services HTTP ${r.status}`);
      const j = await r.json();
      return (j?.items as { id: string; nome: string }[]) || [];
    },
    enabled: open,
  });
  const servicos = servicosQ.data || [];

  const categoriasQ = useQuery({
    queryKey: ["ca-categorias-receita"],
    queryFn: async () => {
      const r = await fetch("/api/contaazul/financial-categories?tipo=RECEITA");
      if (!r.ok) throw new Error(`categories HTTP ${r.status}`);
      const j = await r.json();
      return (j?.items as { id: string; nome: string }[]) || [];
    },
    enabled: open,
  });
  const categorias = categoriasQ.data || [];

  const placeholder = (
    q: { isLoading: boolean; isError: boolean; data: unknown },
    emptyMsg = "Sem itens"
  ) => {
    if (q.isLoading) return "Carregando...";
    if (q.isError) return "Erro ao carregar";
    if (!q.data || (Array.isArray(q.data) && q.data.length === 0)) return emptyMsg;
    return "Selecionar...";
  };

  // Sincroniza mês/ano com a competência selecionada (sempre que muda)
  useEffect(() => {
    if (compAtual?.mes) setMesRefBatch(compAtual.mes);
    if (compAtual?.ano) setAnoRefBatch(compAtual.ano);
  }, [compAtual?.id]);

  // Constroi as linhas a partir dos faturamentos pendentes — centro de custo
  // vem do cadastro da empresa (configurado em Cadastros → Empresas)
  useEffect(() => {
    if (!faturamentos.length) return;
    const novas: Linha[] = (faturamentos as any[])
      .filter((f) => f.status === "pendente" || f.status === "sem_cadastro")
      .map((f) => {
        const empresa = empresasById.get(f.empresa_executora_id) as any;
        const semCadastro = f.status === "sem_cadastro";
        const retPadrao: RetencaoPadrao = semCadastro
          ? "nenhuma"
          : (empresa?.retencao_padrao as RetencaoPadrao) ||
            (empresa?.categoria === "credenciada" ? "credenciada_auto" : "nenhuma");
        const modoSalvo = empresa?.nf_modo as string | undefined;
        const nfModo: NfModo =
          modoSalvo === "nao_emite" || modoSalvo === "automatica" || modoSalvo === "manual"
            ? modoSalvo
            : empresa?.emitir_nf_padrao
            ? "automatica"
            : "manual";
        return {
          faturamentoId: f.id,
          empresaId: f.empresa_executora_id,
          cnpj: empresa?.cnpj ?? f.cnpj_snapshot ?? "",
          nome: empresa?.nome_empresa ?? f.nome_empresa_snapshot ?? "Sem nome",
          categoria: empresa?.categoria ?? "?",
          valor: Number(f.valor) || 0,
          semCadastro,
          nfModo,
          linkEso: f.link_relatorio_eso ?? null,
          selected: !semCadastro,
          centroCustoId: empresa?.centro_custo_id || "",
          dataVencimento: dataVencPadrao,
          retencao: retPadrao,
          emitirNF: nfModo === "automatica",
          emitirBoleto: false,
          enviarEmail: !!empresa?.enviar_email_padrao,
        };
      });
    setLinhas(novas);
  }, [faturamentos, empresasById]);

  // Quando user muda data padrão, propaga pra todas as linhas que ainda
  // estavam com a data antiga (não sobrescreve customizações manuais).
  const aplicarDataVencPadrao = (nova: string) => {
    setLinhas((prev) =>
      prev.map((l) => (l.dataVencimento === dataVencPadrao ? { ...l, dataVencimento: nova } : l))
    );
    setDataVencPadrao(nova);
  };

  const semCadastroList = linhas.filter((l) => l.semCadastro);
  const validas = linhas.filter((l) => !l.semCadastro);
  const selecionadas = validas.filter((l) => l.selected);
  const totalSelecionado = selecionadas.reduce((s, l) => s + l.valor, 0);

  const toggleAll = (checked: boolean) => {
    setLinhas((prev) => prev.map((l) => (l.semCadastro ? l : { ...l, selected: checked })));
  };

  const updateLinha = (id: string, patch: Partial<Linha>) => {
    setLinhas((prev) => prev.map((l) => (l.faturamentoId === id ? { ...l, ...patch } : l)));
  };

  const handleFaturar = async () => {
    if (selecionadas.length === 0) return toast.error("Nenhuma linha selecionada");
    if (!servicoPadrao) return toast.error("Selecione o serviço");
    const servicoNomeRaw = servicos.find((s) => s.id === servicoPadrao)?.nome || "Serviço";
    let servicoNome = servicoNomeRaw.replace(/\s*\([^)]*\)\s*$/g, "").trim();
    try {
      const rIA = await fetch("/api/contaazul/nome-amigavel-servico", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: servicoNomeRaw }),
      });
      const j = await rIA.json();
      if (j?.rotulo) servicoNome = j.rotulo;
    } catch (_) {}
    setProgress({ done: 0, total: selecionadas.length });
    setResultados({});
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < selecionadas.length; i++) {
      const l = selecionadas[i];
      let res: Resultado;
      try {
        const ret = calcularRetencao(l.categoria, l.valor, l.retencao);
        const valorFmt = l.valor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const observacaoNF = `Referente ao(s) ${servicoNome} do mês de ${MESES[mesRefBatch - 1]}/${anoRefBatch}\nValor total: R$ ${valorFmt}`;
        const r = await fetch("/api/contaazul/create-receivable", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cnpj: l.cnpj,
            razao_social: l.nome,
            centro_custo_id: l.centroCustoId || undefined,
            categoria_id: categoriaPadrao || undefined,
            servico_id: servicoPadrao,
            servico: servicoNome,
            valor: l.valor,
            data_venda: new Date().toISOString().slice(0, 10),
            data_vencimento: l.dataVencimento || dataVencPadrao,
            observacoes: observacaoNF,
            mes_referencia: mesRefBatch,
            ano_referencia: anoRefBatch,
            emitir_nf: l.emitirNF,
            emitir_boleto: l.emitirBoleto,
            retencao: ret,
          }),
        });
        const j = await r.json();
        if (!r.ok || !j.ok) {
          res = {
            ok: false,
            nf: { status: "nao_solicitada" },
            boleto: { status: "nao_solicitado" },
            fatal: j.error || `HTTP ${r.status}`,
          };
        } else {
          const nfStatus = j.nf?.status || "nao_solicitada";
          const boletoStatus = j.boleto?.status || "nao_solicitado";
          // OK se a venda foi criada e (NF/Boleto solicitados não falharam)
          const nfFalhou = l.emitirNF && nfStatus === "erro";
          const boletoFalhou = l.emitirBoleto && boletoStatus === "erro";
          res = {
            ok: !nfFalhou && !boletoFalhou,
            vendaNumero: j.venda?.numero,
            vendaId: j.venda?.id,
            nf: { status: nfStatus, erro: j.nf?.erro },
            boleto: { status: boletoStatus, erro: j.boleto?.erro },
          };
        }
      } catch (e: any) {
        res = {
          ok: false,
          nf: { status: "nao_solicitada" },
          boleto: { status: "nao_solicitado" },
          fatal: e?.message || "erro",
        };
      }
      setResultados((prev) => ({ ...prev, [l.faturamentoId]: res }));
      // Persiste status no banco — sucesso vira "concluido", falha vira "ca_error".
      try {
        await updateFaturamentoStatus(
          l.faturamentoId,
          res.ok ? "concluido" : "ca_error"
        );
      } catch (e) {
        console.error("Falha ao atualizar status do faturamento:", e);
      }
      // Auto-envio de e-mail: dispara se a linha está marcada e venda OK
      if (res.ok && res.vendaId && l.enviarEmail) {
        const ccArr = ccPadrao
          .split(/[,;\s]+/)
          .map((s) => s.trim())
          .filter((s) => s.includes("@"));
        // 1. E-mail oficial via CA (sem URL — CA bloqueia)
        let destinatariosCA: string[] = [];
        try {
          const rEmail = await fetch("/api/contaazul/send-email-venda", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ vendaId: res.vendaId, cc: ccArr }),
          });
          const jEmail = await rEmail.json().catch(() => ({}));
          if (!rEmail.ok || jEmail?.ok === false) {
            const msg = jEmail?.error || `HTTP ${rEmail.status}`;
            console.error(`[Faturar] Falha email CA pra ${l.nome}:`, msg, jEmail);
            toast.warning(`E-mail CA não enviado pra ${l.nome}: ${msg}`);
          } else {
            destinatariosCA = jEmail?.emails || [];
          }
        } catch (e: any) {
          console.error(`[Faturar] Erro de rede no email CA pra ${l.nome}:`, e);
        }
        // 2. E-mail Gmail SMTP com o link da fatura ESO (CA bloqueia URLs)
        if (l.linkEso && destinatariosCA.length > 0) {
          try {
            const rLink = await fetch("/api/email/send-link", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                destinatarios: destinatariosCA.filter(
                  (e) => !ccArr.includes(e) // tira o medwork CA do "to" (vai como cc)
                ),
                cc: ccArr,
                link: l.linkEso,
                empresa_nome: l.nome,
                numero_venda: res.vendaNumero,
              }),
            });
            const jLink = await rLink.json().catch(() => ({}));
            if (!rLink.ok || jLink?.ok === false) {
              const msg = jLink?.error || `HTTP ${rLink.status}`;
              console.error(`[Faturar] Falha Gmail link pra ${l.nome}:`, msg, jLink);
              if (jLink?.limit_atingido) {
                toast.warning(`${l.nome}: limite Gmail atingido (500/dia). Reenvia o link amanhã.`);
              } else {
                toast.warning(`${l.nome}: link não enviado: ${msg}`);
              }
            }
          } catch (e: any) {
            console.error(`[Faturar] Erro de rede no Gmail link pra ${l.nome}:`, e);
          }
        }
      }
      if (res.ok) ok++;
      else fail++;
      setProgress({ done: i + 1, total: selecionadas.length });
    }
    setProgress(null);
    // Refresca a página Faturamento (status atualizado em cada linha)
    queryClient.invalidateQueries({ queryKey: ["faturamentos"] });
    queryClient.invalidateQueries({ queryKey: ["competencias"] });
    if (fail === 0) {
      toast.success(`Todos os ${ok} faturamento(s) criados com sucesso!`);
    } else {
      toast.error(`${ok} OK · ${fail} com erro — confira na coluna Resultado`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default" className="w-full sm:w-auto">
          <Wallet className="h-4 w-4 mr-1.5" /> Faturar em massa
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">
            Faturar em massa{compAtual ? ` — ${MESES[compAtual.mes - 1]}/${compAtual.ano}` : ""}
          </DialogTitle>
        </DialogHeader>

        {semCadastroList.length > 0 && (
          <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-warning" />
              <div>
                <p className="font-medium">
                  {semCadastroList.length} empresa(s) sem cadastro — vá em <b>Cadastros → Empresas</b> e cadastre antes de faturar
                </p>
                <ul className="text-xs text-muted-foreground mt-1 space-y-0.5">
                  {semCadastroList.slice(0, 5).map((l) => (
                    <li key={l.faturamentoId}>• {formatCnpjCpf(l.cnpj)} — {l.nome}</li>
                  ))}
                  {semCadastroList.length > 5 && <li>+ {semCadastroList.length - 5} outras</li>}
                </ul>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs">Competência</Label>
            <Select value={compId} onValueChange={setCompId}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Selecionar..." />
              </SelectTrigger>
              <SelectContent>
                {competencias.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {MESES[c.mes - 1]}/{c.ano}
                    {c.status === "aberto" ? " · aberta" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Serviço</Label>
            <Select value={servicoPadrao} onValueChange={setServicoPadrao}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder={placeholder(servicosQ)} />
              </SelectTrigger>
              <SelectContent>
                {servicos.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.nome}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Categoria financeira</Label>
            <Select value={categoriaPadrao} onValueChange={setCategoriaPadrao}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder={placeholder(categoriasQ)} />
              </SelectTrigger>
              <SelectContent>
                {categorias.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Vencimento padrão</Label>
            <Input
              type="date"
              className="h-9"
              value={dataVencPadrao}
              onChange={(e) => aplicarDataVencPadrao(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Mês ref.</Label>
            <div className="flex gap-2">
              <Select value={String(mesRefBatch)} onValueChange={(v) => setMesRefBatch(Number(v))}>
                <SelectTrigger className="h-9 flex-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MESES.map((m, i) => (
                    <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={String(anoRefBatch)} onValueChange={(v) => setAnoRefBatch(Number(v))}>
                <SelectTrigger className="h-9 w-[90px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[hojeBatch.getFullYear() - 1, hojeBatch.getFullYear(), hojeBatch.getFullYear() + 1].map((a) => (
                    <SelectItem key={a} value={String(a)}>{a}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">E-mail em cópia (CC)</Label>
            <Input
              type="text"
              className="h-9"
              value={ccPadrao}
              onChange={(e) => setCcPadrao(e.target.value)}
              placeholder="email@exemplo.com"
            />
          </div>
          <div className="space-y-1 flex flex-col justify-end">
            <Badge variant="secondary" className="self-start">
              {selecionadas.length} de {validas.length} | Total: {fmtBRL(totalSelecionado)}
            </Badge>
          </div>
        </div>

        <div className="border rounded-lg overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={validas.length > 0 && selecionadas.length === validas.length}
                    onCheckedChange={(c) => toggleAll(!!c)}
                  />
                </TableHead>
                <TableHead>Empresa</TableHead>
                <TableHead>CNPJ</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead>Vencimento</TableHead>
                <TableHead>Retenção</TableHead>
                <TableHead className="text-center">NF</TableHead>
                <TableHead className="text-center">Boleto</TableHead>
                <TableHead className="text-center">E-mail</TableHead>
                <TableHead className="min-w-[200px]">Resultado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {linhas.map((l) => (
                <TableRow
                  key={l.faturamentoId}
                  className={l.semCadastro ? "opacity-50" : ""}
                >
                  <TableCell>
                    <Checkbox
                      checked={l.selected}
                      onCheckedChange={(c) => updateLinha(l.faturamentoId, { selected: !!c })}
                      disabled={l.semCadastro}
                    />
                  </TableCell>
                  <TableCell className="font-medium">
                    {l.nome}
                    {l.semCadastro && <Badge variant="outline" className="ml-2 text-xs">sem cadastro</Badge>}
                    {l.categoria === "credenciada" && <Badge variant="secondary" className="ml-2 text-xs">credenciada</Badge>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{formatCnpjCpf(l.cnpj)}</TableCell>
                  <TableCell className="text-right">{fmtBRL(l.valor)}</TableCell>
                  <TableCell>
                    <Input
                      type="date"
                      className="h-8 w-[140px] text-xs"
                      value={l.dataVencimento}
                      onChange={(e) => updateLinha(l.faturamentoId, { dataVencimento: e.target.value })}
                      disabled={l.semCadastro}
                    />
                  </TableCell>
                  <TableCell>
                    <Select
                      value={l.retencao}
                      onValueChange={(v) => updateLinha(l.faturamentoId, { retencao: v as RetencaoPadrao })}
                    >
                      <SelectTrigger className="h-8 text-xs w-[180px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="nenhuma">Nenhuma</SelectItem>
                        <SelectItem value="federal">Só Federal</SelectItem>
                        <SelectItem value="iss">Só ISS</SelectItem>
                        <SelectItem value="federal_iss">Federal + ISS</SelectItem>
                        <SelectItem value="credenciada_auto">Credenciada (auto)</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-center">
                    <Checkbox
                      checked={l.emitirNF}
                      onCheckedChange={(c) => updateLinha(l.faturamentoId, { emitirNF: !!c })}
                      disabled={l.semCadastro || l.nfModo === "nao_emite"}
                      title={l.nfModo === "nao_emite" ? "Empresa configurada como 'não emite NF'" : undefined}
                    />
                  </TableCell>
                  <TableCell className="text-center">
                    <Checkbox
                      checked={l.emitirBoleto}
                      onCheckedChange={(c) => updateLinha(l.faturamentoId, { emitirBoleto: !!c })}
                      disabled={l.semCadastro}
                    />
                  </TableCell>
                  <TableCell className="text-center">
                    <Checkbox
                      checked={l.enviarEmail}
                      onCheckedChange={(c) => updateLinha(l.faturamentoId, { enviarEmail: !!c })}
                      disabled={l.semCadastro}
                      title={l.linkEso ? `Inclui link ESO: ${l.linkEso}` : "Sem link ESO no faturamento"}
                    />
                  </TableCell>
                  <TableCell>
                    <ResultadoCelula
                      resultado={resultados[l.faturamentoId]}
                      onEnviarEmail={(vendaId, numero) =>
                        setEmailDialog({ vendaId, numero })
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
              {linhas.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                    Nenhum faturamento pendente para a competência atual.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex flex-col gap-2 pt-2">
          <p className="text-xs text-muted-foreground">
            Cada selecionada vira uma <b>Venda de Serviço (Receita de serviço)</b> aprovada na Conta Azul.
            A retenção é informada nas observações. <b>Marcar "NF"</b> sinaliza pendência —
            a Conta Azul não permite emitir NFS-e via API, então a emissão é feita na UI da CA
            (Vendas → venda → Nota Fiscal) ou por contrato com emissão automática.
          </p>
          <div className="flex items-center justify-end">
            <Button
              onClick={handleFaturar}
              disabled={selecionadas.length === 0 || !!progress}
            >
              {progress
                ? `Processando ${progress.done}/${progress.total}...`
                : `Faturar ${selecionadas.length} selecionada${selecionadas.length !== 1 ? "s" : ""}`}
            </Button>
          </div>
        </div>
      </DialogContent>
      <EnviarEmailDialog
        vendaId={emailDialog?.vendaId ?? null}
        vendaNumero={emailDialog?.numero}
        open={!!emailDialog}
        onOpenChange={(v) => !v && setEmailDialog(null)}
      />
    </Dialog>
  );
}

function ResultadoCelula({
  resultado,
  onEnviarEmail,
}: {
  resultado?: Resultado;
  onEnviarEmail?: (vendaId: string, numero?: number) => void;
}) {
  if (!resultado) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  if (resultado.fatal) {
    return (
      <div className="flex items-start gap-1.5">
        <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
        <div className="text-xs">
          <div className="font-medium text-destructive">Falhou</div>
          <div className="text-muted-foreground line-clamp-2" title={resultado.fatal}>
            {resultado.fatal}
          </div>
        </div>
      </div>
    );
  }
  const Icon = resultado.ok ? CheckCircle2 : AlertTriangle;
  const cor = resultado.ok ? "text-success" : "text-warning";
  const labelNF =
    resultado.nf.status === "emitida"
      ? "NF emitida"
      : resultado.nf.status === "em_processamento"
      ? "NF em processamento"
      : resultado.nf.status === "erro"
      ? `NF erro: ${resultado.nf.erro || "?"}`
      : null;
  const labelBoleto =
    resultado.boleto.status === "solicitado" || resultado.boleto.status === "emitido"
      ? "Boleto OK"
      : resultado.boleto.status === "ja_emitido"
      ? "Boleto já existia"
      : resultado.boleto.status === "aguardando_confirmacao"
      ? "Boleto aguardando"
      : resultado.boleto.status === "erro"
      ? `Boleto erro: ${resultado.boleto.erro || "?"}`
      : null;
  return (
    <div className="flex items-start gap-1.5">
      <Icon className={`h-4 w-4 ${cor} mt-0.5 shrink-0`} />
      <div className="text-xs">
        <div className="font-medium flex items-center gap-1.5">
          {resultado.vendaNumero ? `Venda #${resultado.vendaNumero}` : "Venda criada"}
          {resultado.vendaId && (
            <a
              href={`https://app.contaazul.com/#/Vendas/${resultado.vendaId}`}
              target="_blank"
              rel="noreferrer"
              title="Abrir no Conta Azul"
              className="text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {resultado.vendaId && onEnviarEmail && (
            <button
              type="button"
              onClick={() => onEnviarEmail(resultado.vendaId!, resultado.vendaNumero)}
              title="Enviar e-mail ao cliente"
              className="text-muted-foreground hover:text-foreground"
            >
              <Mail className="h-3 w-3" />
            </button>
          )}
        </div>
        {labelNF && <div className="text-muted-foreground">{labelNF}</div>}
        {labelBoleto && <div className="text-muted-foreground">{labelBoleto}</div>}
      </div>
    </div>
  );
}
