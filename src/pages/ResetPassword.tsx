import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Sun, Moon } from "lucide-react";
import logo from "@/assets/logo-medx.png";

export default function ResetPassword() {
  const [senha, setSenha] = useState("");
  const [confirmacao, setConfirmacao] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { isAuthenticated, loading, updatePassword } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const isRecoveryFlow = useMemo(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    return params.get("type") === "recovery";
  }, []);

  useEffect(() => {
    setError("");
    setSuccess("");
  }, [isRecoveryFlow]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!isRecoveryFlow && !isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background relative overflow-hidden px-4">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -top-40 -right-40 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
          <div className="absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-accent/5 blur-3xl" />
        </div>

        <div className="absolute top-6 right-6 z-20 flex items-center gap-2">
          <Sun className="h-4 w-4 text-muted-foreground" />
          <Switch checked={theme === "dark"} onCheckedChange={toggleTheme} />
          <Moon className="h-4 w-4 text-muted-foreground" />
        </div>

        <Card className="relative z-10 w-full max-w-[420px] border-border/50 shadow-2xl">
          <CardContent className="px-8 py-8 text-center">
            <img src={logo} alt="MedX" className="mx-auto mb-4 h-16 w-auto" />
            <h1 className="font-display text-[1.75rem] font-bold tracking-tight text-foreground">Link inválido ou expirado</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Solicite um novo link na tela de login para redefinir sua senha.
            </p>
            <Button asChild className="mt-6 w-full font-semibold">
              <Link to="/login">Voltar para login</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!senha || !confirmacao) {
      setError("Preencha os dois campos.");
      return;
    }

    if (senha.length < 6) {
      setError("A senha deve ter pelo menos 6 caracteres.");
      return;
    }

    if (senha !== confirmacao) {
      setError("As senhas não coincidem.");
      return;
    }

    setSubmitting(true);
    const { error: updateError } = await updatePassword(senha);
    setSubmitting(false);

    if (updateError) {
      setError("Não foi possível redefinir a senha.");
      return;
    }

    setSuccess("Senha atualizada com sucesso. Redirecionando...");
    window.history.replaceState({}, document.title, window.location.pathname);
    setTimeout(() => navigate("/dashboard", { replace: true }), 1200);
  };

  if (success && isAuthenticated && !isRecoveryFlow) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background relative overflow-hidden px-4">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 -right-40 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-accent/5 blur-3xl" />
      </div>

      <div className="absolute top-6 right-6 z-20 flex items-center gap-2">
        <Sun className="h-4 w-4 text-muted-foreground" />
        <Switch checked={theme === "dark"} onCheckedChange={toggleTheme} />
        <Moon className="h-4 w-4 text-muted-foreground" />
      </div>

      <Card className="relative z-10 w-full max-w-[420px] border-border/50 shadow-2xl">
        <CardContent className="px-8 py-8">
          <div className="mb-8 flex flex-col items-center">
            <img src={logo} alt="MedX" className="mb-4 h-16 w-auto" />
            <h1 className="font-display text-[1.75rem] font-bold tracking-tight text-foreground">Redefinir senha</h1>
            <p className="mt-1 text-center text-sm text-muted-foreground">
              Digite sua nova senha para recuperar o acesso.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="nova-senha">Nova senha</Label>
              <Input
                id="nova-senha"
                type="password"
                autoComplete="new-password"
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmacao-senha">Confirmar nova senha</Label>
              <Input
                id="confirmacao-senha"
                type="password"
                autoComplete="new-password"
                value={confirmacao}
                onChange={(e) => setConfirmacao(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            {error && <p className="text-sm font-medium text-destructive">{error}</p>}
            {success && <p className="text-sm font-medium text-success">{success}</p>}

            <Button type="submit" className="w-full font-semibold" disabled={submitting}>
              {submitting ? "Salvando..." : "Salvar nova senha"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
