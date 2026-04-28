import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { fetchCompetencias, MESES } from "@/lib/api";
import { Search, X, SlidersHorizontal, ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

type Status = "all" | "aberto" | "concluido";
type Sort = "recent" | "old" | "mes" | "status";

export default function Historico() {
  const navigate = useNavigate();
  const { data: competencias = [] } = useQuery({
    queryKey: ["competencias"],
    queryFn: fetchCompetencias,
  });

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [mes, setMes] = useState<string>("all");
  const [anoDe, setAnoDe] = useState<string>("");
  const [anoAte, setAnoAte] = useState<string>("");
  const [sort, setSort] = useState<Sort>("recent");

  const anos = useMemo(() => {
    const set = new Set<number>(competencias.map((c) => c.ano));
    return Array.from(set).sort((a, b) => b - a);
  }, [competencias]);

  const filtered = useMemo(() => {
    let arr = [...competencias];
    if (search.trim()) {
      const q = search.toLowerCase();
      arr = arr.filter((c) => {
        const nome = `${MESES[c.mes - 1]} ${c.ano}`.toLowerCase();
        return nome.includes(q) || String(c.ano).includes(q);
      });
    }
    if (status !== "all") arr = arr.filter((c) => c.status === status);
    if (mes !== "all") arr = arr.filter((c) => c.mes === Number(mes));
    if (anoDe) arr = arr.filter((c) => c.ano >= Number(anoDe));
    if (anoAte) arr = arr.filter((c) => c.ano <= Number(anoAte));

    arr.sort((a, b) => {
      if (sort === "recent") return b.ano - a.ano || b.mes - a.mes;
      if (sort === "old") return a.ano - b.ano || a.mes - b.mes;
      if (sort === "mes") return a.mes - b.mes || b.ano - a.ano;
      if (sort === "status") return a.status.localeCompare(b.status);
      return 0;
    });
    return arr;
  }, [competencias, search, status, mes, anoDe, anoAte, sort]);

  const clearAll = () => {
    setSearch("");
    setStatus("all");
    setMes("all");
    setAnoDe("");
    setAnoAte("");
    setSort("recent");
  };

  const activeFilters =
    Number(!!search) +
    Number(status !== "all") +
    Number(mes !== "all") +
    Number(!!anoDe) +
    Number(!!anoAte);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-[1.75rem] font-bold tracking-tight">Histórico de Competências</h1>
          <p className="text-sm text-muted-foreground">
            Todas as competências registradas
          </p>
        </div>
        <Badge variant="secondary">
          {filtered.length} de {competencias.length}
        </Badge>
      </div>

      <Card className="border-border/50">
        <CardContent className="p-4 space-y-3">
          <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
            <div className="flex gap-2 items-center flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input className="pl-8" placeholder="Buscar mês ou ano..." value={search} onChange={(e) => setSearch(e.target.value)} />
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
              {activeFilters > 0 && (
                <Button variant="ghost" size="sm" onClick={clearAll}>
                  <X className="h-3.5 w-3.5 mr-1" /> Limpar
                </Button>
              )}
            </div>
            <CollapsibleContent className="mt-3 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Status</Label>
                  <Select value={status} onValueChange={(v) => setStatus(v as Status)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos</SelectItem>
                      <SelectItem value="aberto">Aberto</SelectItem>
                      <SelectItem value="concluido">Concluído</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Mês</Label>
                  <Select value={mes} onValueChange={setMes}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos</SelectItem>
                      {MESES.map((nome, i) => (
                        <SelectItem key={i + 1} value={String(i + 1)}>{nome}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Ano de</Label>
                  <Select value={anoDe || "any"} onValueChange={(v) => setAnoDe(v === "any" ? "" : v)}>
                    <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Qualquer</SelectItem>
                      {anos.map((a) => <SelectItem key={a} value={String(a)}>{a}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Ano até</Label>
                  <Select value={anoAte || "any"} onValueChange={(v) => setAnoAte(v === "any" ? "" : v)}>
                    <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Qualquer</SelectItem>
                      {anos.map((a) => <SelectItem key={a} value={String(a)}>{a}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Ordenar por</Label>
                  <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="recent">Mais recentes</SelectItem>
                      <SelectItem value="old">Mais antigas</SelectItem>
                      <SelectItem value="mes">Mês (jan→dez)</SelectItem>
                      <SelectItem value="status">Status</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      <Card className="border-border/50">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mês/Ano</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium font-display">
                    {MESES[c.mes - 1]} {c.ano}
                  </TableCell>
                  <TableCell>
                    <Badge variant={c.status === "concluido" ? "default" : "secondary"}>
                      {c.status === "concluido" ? "Concluído" : "Aberto"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => navigate(`/competencia/${c.id}`)}>
                      Abrir
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center py-10 text-muted-foreground">
                    {competencias.length === 0
                      ? "Nenhuma competência registrada."
                      : "Nenhuma competência corresponde aos filtros."}
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
