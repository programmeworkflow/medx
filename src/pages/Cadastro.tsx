import { useLocation, useNavigate } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Empresas from "./Empresas";
import Credenciadas from "./Credenciadas";

export default function Cadastro() {
  const location = useLocation();
  const navigate = useNavigate();

  // Derive active sub-tab from the URL so a direct link to
  // /cadastro/credenciadas opens the right tab on load.
  const sub = location.pathname.endsWith("/credenciadas") ? "credenciadas" : "empresas";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold">Cadastro</h1>
        <p className="text-sm text-muted-foreground">Empresas atendidas e credenciadas parceiras</p>
      </div>

      <Tabs
        value={sub}
        onValueChange={(v) => navigate(v === "credenciadas" ? "/cadastro/credenciadas" : "/cadastro/empresas")}
        className="space-y-4"
      >
        <TabsList>
          <TabsTrigger value="empresas">01 — Empresas</TabsTrigger>
          <TabsTrigger value="credenciadas">02 — Credenciadas</TabsTrigger>
        </TabsList>

        <TabsContent value="empresas" className="space-y-4">
          <Empresas />
        </TabsContent>

        <TabsContent value="credenciadas" className="space-y-4">
          <Credenciadas />
        </TabsContent>
      </Tabs>
    </div>
  );
}
