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
  retencao: RetencaoPadrao;
  emitirNF: boolean;
}

export default function FaturarEmMassaDialog({ centros }: { centros: CentroCusto[] }) {
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

  const [centroCustoPadrao, setCentroCustoPadrao] = useState<string>("");
  const [linhas, setLinhas] = useState<Linha[]>([]);

  // Default centro custo = primeiro com "EXAMES" no nome
  useEffect(() => {
    if (centros.length && !centroCustoPadrao) {
      const exames = centros.find((c) => /exam/i.test(c.nome));
      setCentroCustoPadrao(exames?.id || centros[0].id);
    }
  }, [centros, centroCustoPadrao]);

  // Constroi as linhas a partir dos faturamentos pendentes
  useEffect(() => {
    if (!faturamentos.length || !centroCustoPadrao) return;
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
          centroCustoId: centroCustoPadrao,
          retencao: retPadrao,
          emitirNF: !!empresa?.emitir_nf_padrao,
        };
      });
    setLinhas(novas);
  }, [faturamentos, empresasById, centroCustoPadrao]);

  const semCadastroList = linhas.filter((l) => l.semCadastro);
  const validas = linhas.filter((l) => !l.semCadastro);
  const selecionadas = validas.filter((l) => l.selected);
  const totalSelecionado = selecionadas.reduce((s, l) => s + l.valor, 0);

  const aplicarCentroCustoTodas = (id: string) => {
    setCentroCustoPadrao(id);
    setLinhas((prev) => prev.map((l) => ({ ...l, centroCustoId: id })));
  };

  const toggleAll = (checked: boolean) => {
    setLinhas((prev) => prev.map((l) => (l.semCadastro ? l : { ...l, selected: checked })));
  };

  const updateLinha = (id: string, patch: Partial<Linha>) => {
    setLinhas((prev) => prev.map((l) => (l.faturamentoId === id ? { ...l, ...patch } : l)));
  };

  const handleFaturar = async () => {
    if (selecionadas.length === 0) return toast.error("Nenhuma linha selecionada");
    setProgress({ done: 0, total: selecionadas.length });
    let ok = 0;
    let fail = 0;
    const errors: { nome: string; erro: string }[] = [];
    for (let i = 0; i < selecionadas.length; i++) {
      const l = selecionadas[i];
      try {
        const ret = calcularRetencao(l.categoria, l.valor, l.retencao);
        const r = await fetch("/api/contaazul/create-receivable", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cnpj: l.cnpj,
            razao_social: l.nome,
            centro_custo_id: l.centroCustoId,
            servico: `Referente aos exames do mês de ${MESES[(compAtual?.mes ?? 1) - 1]}/${compAtual?.ano}`,
            valor: l.valor,
            data_venda: new Date().toISOString().slice(0, 10),
            observacoes: `Total ${fmtBRL(l.valor)} | Retido ${fmtBRL(ret.total_retido)} | Líquido ${fmtBRL(ret.valor_liquido)}`,
            emitir_nf: l.emitirNF,
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
                    <li key={l.faturamentoId}>• {l.cnpj} — {l.nome}</li>
                  ))}
                  {semCadastroList.length > 5 && <li>+ {semCadastroList.length - 5} outras</li>}
                </ul>
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap py-2">
          <div className="flex items-center gap-2">
            <Label className="text-xs">Centro de custo padrão:</Label>
            <Select value={centroCustoPadrao} onValueChange={aplicarCentroCustoTodas}>
              <SelectTrigger className="w-[260px] h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                {centros.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Badge variant="secondary">
            {selecionadas.length} de {validas.length} | Total: {fmtBRL(totalSelecionado)}
          </Badge>
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
                <TableHead>Centro custo</TableHead>
                <TableHead>Retenção</TableHead>
                <TableHead className="text-center">NF</TableHead>
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
                  <TableCell className="font-mono text-xs">{l.cnpj}</TableCell>
                  <TableCell className="text-right">{fmtBRL(l.valor)}</TableCell>
                  <TableCell>
                    <Select
                      value={l.centroCustoId}
                      onValueChange={(v) => updateLinha(l.faturamentoId, { centroCustoId: v })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {centros.map((c) => (
                          <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                </TableRow>
              ))}
              {linhas.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
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
