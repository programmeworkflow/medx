import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, Upload } from "lucide-react";
import {
  fetchFaturamentos,
  updateFaturamentoStatus,
  MESES,
  CATEGORIA_LABELS,
  STATUS_LABELS,
  STATUS_COLORS,
  type StatusFaturamento,
  type Categoria,
} from "@/lib/api";
import { supabase } from "@/integrations/supabase/client";

const statusOptions: StatusFaturamento[] = [
  "pendente", "aguardando_oc", "conferencia", "faturado", "pago_avista", "concluido",
];

export default function ControleCompetencia() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: competencia } = useQuery({
    queryKey: ["competencia", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("competencias").select("*").eq("id", id!).single();
      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });

  const { data: faturamentos = [] } = useQuery({
    queryKey: ["faturamentos", id],
    queryFn: () => fetchFaturamentos(id!),
    enabled: !!id,
  });

  const statusMutation = useMutation({
    mutationFn: ({ fatId, status }: { fatId: string; status: StatusFaturamento }) =>
      updateFaturamentoStatus(fatId, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["faturamentos", id] }),
  });

  if (!competencia) {
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground">Carregando competência...</p>
      </div>
    );
  }

  const total = faturamentos.length;
  const concluidos = faturamentos.filter(
    (f) => f.status === "concluido" || f.status === "pago_avista"
  ).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="font-display text-[1.75rem] font-bold tracking-tight">
              {MESES[competencia.mes - 1]} {competencia.ano}
            </h1>
            <p className="text-sm text-muted-foreground">{concluidos}/{total} concluídos</p>
          </div>
        </div>
        <Button variant="outline" onClick={() => navigate("/importacao")}>
          <Upload className="h-4 w-4 mr-2" /> Importar ESO
        </Button>
      </div>

      <Card className="border-border/50">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Empresa Executora</TableHead>
                <TableHead>Empresa Faturadora</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[180px]">Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {faturamentos.map((fat: any) => (
                <TableRow key={fat.id}>
                  <TableCell className="font-medium">
                    {fat.empresa_executora?.nome_empresa ?? "—"}
                  </TableCell>
                  <TableCell>
                    {fat.empresa_faturadora?.nome_empresa ?? "—"}
                    {fat.empresa_executora_id !== fat.empresa_faturadora_id && (
                      <Badge variant="outline" className="ml-2 text-xs">Redirecionado</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {CATEGORIA_LABELS[fat.categoria_snapshot as Categoria] ?? fat.categoria_snapshot}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[fat.status as StatusFaturamento]}`}>
                      {STATUS_LABELS[fat.status as StatusFaturamento]}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={fat.status}
                      onValueChange={(v) => statusMutation.mutate({ fatId: fat.id, status: v as StatusFaturamento })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {statusOptions.map((s) => (
                          <SelectItem key={s} value={s} className="text-xs">
                            {STATUS_LABELS[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              ))}
              {faturamentos.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-10 text-muted-foreground">
                    Nenhum faturamento registrado para esta competência.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
