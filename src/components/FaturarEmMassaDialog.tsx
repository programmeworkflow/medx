import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { AlertTriangle, Wallet } from "lucide-react";
import { toast } from "sonner";
import { formatCnpjCpf } from "@/lib/format";
import {
  fetchFaturamentos,
  fetchEmpresas,
  fetchCompetencias,
  calcularRetencao,
  MESES,
  type RetencaoPadrao,
} from "@/lib/api";

const fmtBRL = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

interface CentroCusto { id: string; nome: string; }

interface Linha {
  faturamentoId: string;
  empresaId: string;
  cnpj: string;
  nome: string;
  categoria: string;
  valor: number;
  semCadastro: boolean;
  // editáveis
  selected: boolean;
  centroCustoId: string;
  dataVencimento: string;
  retencao: RetencaoPadrao;
  emitirNF: boolean;
  emitirBoleto: boolean;
}

export default function FaturarEmMassaDialog({ centros: _centros }: { centros: CentroCusto[] }) {
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const { data: competencias = [] } = useQuery({ queryKey: ["competencias"], queryFn: fetchCompetencias });
  const compAtual = competencias.find((c) => c.status === "aberto") || competencias[0];

  const { data: faturamentos = [] } = useQuery({
    queryKey: ["faturamentos", compAtual?.id],
    queryFn: () => fetchFaturamentos(compAtual?.id ?? ""),
    enabled: !!compAtual?.id && open,
  });
  const { data: empresas = [] } = useQuery({ queryKey: ["empresas"], queryFn: fetchEmpresas, enabled: open });
  const empresasById = useMemo(() => new Map(empresas.map((e: any) => [e.id, e])), [empresas]);

  const [servicoPadrao, setServicoPadrao] = useState<string>("");
  const [categoriaPadrao, setCategoriaPadrao] = useState<string>("");
  const [centroCustoPadrao, setCentroCustoPadrao] = useState<string>("");
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

  const { data: servicos = [] } = useQuery({
    queryKey: ["ca-servicos"],
    queryFn: async () => {
      const r = await fetch("/api/contaazul/services");
      const j = await r.json();
      return (j?.items as { id: string; nome: string }[]) || [];
    },
    enabled: open,
  });

  const { data: categorias = [] } = useQuery({
    queryKey: ["ca-categorias-receita"],
    queryFn: async () => {
      const r = await fetch("/api/contaazul/financial-categories?tipo=RECEITA");
      const j = await r.json();
      return (j?.items as { id: string; nome: string }[]) || [];
    },
    enabled: open,
  });

  const { data: centrosCustoCA = [] } = useQuery({
    queryKey: ["ca-cost-centers"],
    queryFn: async () => {
      const r = await fetch("/api/contaazul/cost-centers");
      const j = await r.json();
      return (j?.items as { id: string; nome: string }[]) || [];
    },
    enabled: open,
  });

  // Sincroniza mês/ano com a competência atual quando o dialog abrir
  useEffect(() => {
    if (compAtual?.mes) setMesRefBatch(compAtual.mes);
    if (compAtual?.ano) setAnoRefBatch(compAtual.ano);
  }, [compAtual?.mes, compAtual?.ano]);

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
        return {
          faturamentoId: f.id,
          empresaId: f.empresa_executora_id,
          cnpj: empresa?.cnpj ?? f.cnpj_snapshot ?? "",
          nome: empresa?.nome_empresa ?? f.nome_empresa_snapshot ?? "Sem nome",
          categoria: empresa?.categoria ?? "?",
          valor: Number(f.valor) || 0,
          semCadastro,
          selected: !semCadastro,
          centroCustoId: empresa?.centro_custo_id || "",
          dataVencimento: dataVencPadrao,
          retencao: retPadrao,
          emitirNF: !!empresa?.emitir_nf_padrao,
          emitirBoleto: false,
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
    // Pede rótulo amigável (regex/IA) ao backend pra usar na observação da NF
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
    let ok = 0;
    let fail = 0;
    const errors: { nome: string; erro: string }[] = [];
    for (let i = 0; i < selecionadas.length; i++) {
      const l = selecionadas[i];
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
            centro_custo_id: l.centroCustoId || centroCustoPadrao || undefined,
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
        if (!r.ok || !j.ok) throw new Error(j.error || "erro");
        ok++;
      } catch (e: any) {
        fail++;
        errors.push({ nome: l.nome, erro: e?.message || "erro" });
      }
      setProgress({ done: i + 1, total: selecionadas.length });
    }
    setProgress(null);
    if (fail === 0) {
      toast.success(`${ok} faturamento(s) criado(s) na Conta Azul!`);
      setOpen(false);
    } else {
      toast.error(`${ok} OK / ${fail} falharam — ver detalhes`);
      console.error("Falhas:", errors);
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
            Faturar em massa — {compAtual ? `${MESES[compAtual.mes - 1]}/${compAtual.ano}` : "—"}
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
            <Label className="text-xs">Serviço</Label>
            <Select value={servicoPadrao} onValueChange={setServicoPadrao}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder={servicos.length ? "Selecionar..." : "Carregando..."} />
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
                <SelectValue placeholder={categorias.length ? "Selecionar..." : "Carregando..."} />
              </SelectTrigger>
              <SelectContent>
                {categorias.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Centro de custo padrão</Label>
            <Select value={centroCustoPadrao} onValueChange={setCentroCustoPadrao}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder={centrosCustoCA.length ? "(usar do cadastro)" : "Carregando..."} />
              </SelectTrigger>
              <SelectContent>
                {centrosCustoCA.map((c) => (
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
                      disabled={l.semCadastro}
                    />
                  </TableCell>
                  <TableCell className="text-center">
                    <Checkbox
                      checked={l.emitirBoleto}
                      onCheckedChange={(c) => updateLinha(l.faturamentoId, { emitirBoleto: !!c })}
                      disabled={l.semCadastro}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {linhas.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
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
    </Dialog>
  );
}
