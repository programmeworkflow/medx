import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, CheckCircle2, Clock, Trophy, Upload, AlertTriangle } from "lucide-react";
import { motion } from "framer-motion";
import { fetchCompetencias, fetchFaturamentos, MESES, CATEGORIA_LABELS, type Categoria } from "@/lib/api";

function formatBRL(value: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [selectedCompId, setSelectedCompId] = useState<string>("");

  const { data: competencias = [] } = useQuery({
    queryKey: ["competencias"],
    queryFn: fetchCompetencias,
  });

  const compId = selectedCompId || competencias[0]?.id || "";
  const currentComp = competencias.find(c => c.id === compId);

  // Fetch faturamentos for all open competências
  const openComps = competencias.filter(c => c.status === "aberto");

  const { data: allFaturamentos = {} } = useQuery({
    queryKey: ["all-faturamentos", openComps.map(c => c.id).join(",")],
    queryFn: async () => {
      const results: Record<string, any[]> = {};
      for (const comp of openComps) {
        results[comp.id] = await fetchFaturamentos(comp.id);
      }
      return results;
    },
    enabled: openComps.length > 0,
  });

  const currentFats = currentComp ? (allFaturamentos[currentComp.id] || []) : [];

  const stats = useMemo(() => {
    if (!currentComp) return null;
    const total = currentFats.length;
    const concluidos = currentFats.filter((f: any) => f.status === "concluido" || f.status === "pago_avista").length;
    const semCadastro = currentFats.filter((f: any) => f.status === "sem_cadastro").length;
    const pendentes = total - concluidos - semCadastro;
    const progresso = total > 0 ? Math.round((concluidos / total) * 100) : 0;
    const mesNome = MESES[currentComp.mes - 1];

    const pendenteFats = currentFats.filter((f: any) => f.status !== "concluido" && f.status !== "pago_avista");
    const categoriasPendentes = new Set(pendenteFats.map((f: any) => f.categoria_snapshot));

    const valorTotal = currentFats.reduce((sum: number, f: any) => sum + (f.valor || 0), 0);
    const valorConcluidos = currentFats.filter((f: any) => f.status === "concluido" || f.status === "pago_avista").reduce((sum: number, f: any) => sum + (f.valor || 0), 0);
    const valorPendentes = currentFats.filter((f: any) => f.status !== "concluido" && f.status !== "pago_avista" && f.status !== "sem_cadastro").reduce((sum: number, f: any) => sum + (f.valor || 0), 0);

    return { total, concluidos, pendentes, semCadastro, progresso, mesNome, categoriasPendentes: Array.from(categoriasPendentes), valorTotal, valorConcluidos, valorPendentes };
  }, [currentComp, currentFats]);

  if (!currentComp || !stats) {
    return (
      <div className="space-y-6">
        <h1 className="font-display text-[1.75rem] font-bold tracking-tight">Dashboard</h1>
        <Card className="border-border/50">
          <CardContent className="py-10 text-center text-muted-foreground">
            Nenhuma competência registrada. Crie uma competência ou importe uma planilha ESO para começar.
          </CardContent>
        </Card>
      </div>
    );
  }

  const trofeuConquistado = stats.progresso === 100 && stats.total > 0;

  const goToFaturamento = (status?: string) => {
    const params = new URLSearchParams();
    params.set("comp", compId);
    if (status) params.set("status", status);
    navigate(`/faturamento?${params.toString()}`);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-[1.75rem] font-bold tracking-tight text-foreground">Dashboard</h1>
          <p className="text-muted-foreground mt-1">
            Competência: {stats.mesNome} {currentComp.ano}
          </p>
        </div>
        <Select value={compId} onValueChange={setSelectedCompId}>
          <SelectTrigger className="w-[220px]"><SelectValue placeholder="Competência..." /></SelectTrigger>
          <SelectContent>
            {competencias.map((c) => (
              <SelectItem key={c.id} value={c.id}>{MESES[c.mes - 1]} {c.ano}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0 }}>
          <Card className="border-border/50 hover:shadow-lg transition-shadow cursor-pointer" onClick={() => goToFaturamento()}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Empresas</CardTitle>
              <Building2 className="h-5 w-5 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-[1.5rem] font-display font-bold tracking-tight">{stats.total}</div>
              <p className="text-xs text-muted-foreground mt-1">{formatBRL(stats.valorTotal)}</p>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <Card className="border-border/50 hover:shadow-lg transition-shadow cursor-pointer" onClick={() => goToFaturamento("concluido")}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Concluídas</CardTitle>
              <CheckCircle2 className="h-5 w-5 text-success" />
            </CardHeader>
            <CardContent>
              <div className="text-[1.5rem] font-display font-bold tracking-tight text-success">{stats.concluidos}</div>
              <p className="text-xs text-success/70 mt-1">{formatBRL(stats.valorConcluidos)}</p>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <Card className="border-border/50 hover:shadow-lg transition-shadow cursor-pointer" onClick={() => goToFaturamento("pendente")}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Pendentes</CardTitle>
              <Clock className="h-5 w-5 text-warning" />
            </CardHeader>
            <CardContent>
              <div className="text-[1.5rem] font-display font-bold tracking-tight text-warning">{stats.pendentes}</div>
              <p className="text-xs text-warning/70 mt-1">{formatBRL(stats.valorPendentes)}</p>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
          <Card className="border-border/50 hover:shadow-lg transition-shadow cursor-pointer" onClick={() => goToFaturamento("sem_cadastro")}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Sem Cadastro</CardTitle>
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-[1.5rem] font-display font-bold tracking-tight text-destructive">{stats.semCadastro}</div>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Progress + Trophy */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
        <Card className="border-border/50">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-display text-lg font-semibold">Progresso Mensal</h3>
                <p className="text-sm text-muted-foreground">
                  {trofeuConquistado
                    ? `Parabéns! Faturamento de ${stats.mesNome} concluído 🏆`
                    : stats.total > 0
                    ? `Faltam ${stats.pendentes + stats.semCadastro} empresas para o troféu de ${stats.mesNome}`
                    : "Importe a planilha ESO para começar o faturamento"}
                </p>
              </div>
              <motion.div
                animate={trofeuConquistado ? { scale: [1, 1.2, 1], rotate: [0, 10, -10, 0] } : {}}
                transition={{ duration: 0.6, repeat: trofeuConquistado ? Infinity : 0, repeatDelay: 2 }}
              >
                <Trophy className={`h-10 w-10 ${trofeuConquistado ? "text-warning" : "text-muted-foreground/30"}`} />
              </motion.div>
            </div>
            <Progress value={stats.progresso} className="h-3" />
            <p className="text-right text-sm font-semibold text-primary mt-2">{stats.progresso}%</p>
          </CardContent>
        </Card>
      </motion.div>

      {/* Categorias Pendentes */}
      {stats.categoriasPendentes.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}>
          <Card className="border-border/50">
            <CardContent className="pt-6">
              <h3 className="font-display text-lg font-semibold mb-3">Categorias Pendentes</h3>
              <div className="flex flex-wrap gap-2">
                {stats.categoriasPendentes.map((cat) => (
                  <Badge key={cat} variant="outline" className="text-warning border-warning/30">
                    {CATEGORIA_LABELS[cat as Categoria] ?? cat}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Competências com faturamento pendente */}
      {openComps.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6 }}>
          <Card className="border-border/50">
            <CardContent className="pt-6">
              <h3 className="font-display text-lg font-semibold mb-3">Meses com Faturamento Pendente</h3>
              <div className="space-y-2">
                {openComps.map(comp => {
                  const fats = allFaturamentos[comp.id] || [];
                  const total = fats.length;
                  const done = fats.filter((f: any) => f.status === "concluido" || f.status === "pago_avista").length;
                  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

                  return (
                    <div key={comp.id} className="flex items-center gap-4 p-3 rounded-lg hover:bg-muted/50 cursor-pointer transition-colors"
                      onClick={() => { setSelectedCompId(comp.id); }}>
                      <div className="flex-1">
                        <p className="font-medium text-sm">{MESES[comp.mes - 1]} {comp.ano}</p>
                        <p className="text-xs text-muted-foreground">{done}/{total} concluídos</p>
                      </div>
                      <div className="w-32">
                        <Progress value={pct} className="h-2" />
                      </div>
                      <span className="text-xs font-semibold text-primary w-10 text-right">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      <div>
        <h2 className="font-display text-lg font-semibold mb-3">Acesso Rápido</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Card className="border-border/50 cursor-pointer hover:shadow-md transition-shadow" onClick={() => goToFaturamento()}>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <Building2 className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-medium text-sm">Faturamento</p>
                <p className="text-xs text-muted-foreground">{stats.mesNome} {currentComp.ano}</p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-border/50 cursor-pointer hover:shadow-md transition-shadow" onClick={() => navigate("/importacao")}>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="h-10 w-10 rounded-lg bg-accent/10 flex items-center justify-center">
                <Upload className="h-5 w-5 text-accent" />
              </div>
              <div>
                <p className="font-medium text-sm">Importar Planilha ESO</p>
                <p className="text-xs text-muted-foreground">Upload e processamento</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
