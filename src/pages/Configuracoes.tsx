import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useTheme } from "@/contexts/ThemeContext";
import { Sun, Moon } from "lucide-react";

export default function Configuracoes() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-[1.75rem] font-bold tracking-tight">Configurações</h1>
        <p className="text-sm text-muted-foreground">Preferências do sistema</p>
      </div>

      <Card className="border-border/50 max-w-lg">
        <CardHeader>
          <CardTitle className="font-display text-lg">Aparência</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {theme === "dark" ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
              <div>
                <Label className="font-medium">Modo Escuro</Label>
                <p className="text-xs text-muted-foreground">Alternar entre modo claro e escuro</p>
              </div>
            </div>
            <Switch checked={theme === "dark"} onCheckedChange={toggleTheme} />
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/50 max-w-lg opacity-50">
        <CardHeader>
          <CardTitle className="font-display text-lg">Gestão de Usuários</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Em breve — gestão de acessos e permissões.</p>
        </CardContent>
      </Card>
    </div>
  );
}
