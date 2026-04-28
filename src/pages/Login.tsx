import { useState } from "react";
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

export default function Login() {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [error, setError] = useState("");
  const [resetMessage, setResetMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const { login, resetPassword, isAuthenticated, loading: authLoading } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (isAuthenticated) return <Navigate to="/dashboard" replace />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setResetMessage("");

    if (!email || !senha) {
      setError("Preencha email e senha.");
      return;
    }

    setLoading(true);
    const { error: err } = await login(email, senha);
    setLoading(false);

    if (err) {
      setError("Credenciais inválidas.");
      return;
    }

    navigate("/dashboard");
  };

  const handleForgotPassword = async () => {
    setError("");
    setResetMessage("");

    if (!email) {
      setError("Digite seu email para receber o link de redefinição.");
      return;
    }

    setResetLoading(true);
    const { error: resetError } = await resetPassword(email);
    setResetLoading(false);

    if (resetError) {
      setError("Não foi possível enviar o email de redefinição.");
      return;
    }

    setResetMessage("Enviamos um link de redefinição para o seu email.");
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 -right-40 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-accent/5 blur-3xl" />
      </div>

      <div className="absolute right-6 top-6 z-20 flex items-center gap-2">
        <Sun className="h-4 w-4 text-muted-foreground" />
        <Switch checked={theme === "dark"} onCheckedChange={toggleTheme} />
        <Moon className="h-4 w-4 text-muted-foreground" />
      </div>

      <div className="relative z-10 w-full max-w-[400px]">
        <Card className="border-border/50 shadow-2xl">
          <CardContent className="px-8 pb-8 pt-8">
            <div className="mb-8 flex flex-col items-center">
              <img src={logo} alt="MedX" className="mb-4 h-16 w-auto" />
              <h1 className="font-display text-[1.75rem] font-bold tracking-tight text-foreground">MedX</h1>
              <p className="mt-1 text-sm text-muted-foreground">Gestão de Faturamento</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoFocus
                  placeholder="seu@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="senha">Senha</Label>
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    disabled={resetLoading}
                    className="text-sm font-medium text-primary transition-opacity hover:opacity-80 disabled:pointer-events-none disabled:opacity-50"
                  >
                    {resetLoading ? "Enviando..." : "Esqueci a senha"}
                  </button>
                </div>
                <Input
                  id="senha"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                />
              </div>

              {error && <p className="text-sm font-medium text-destructive">{error}</p>}
              {resetMessage && <p className="text-sm font-medium text-success">{resetMessage}</p>}

              <Button type="submit" className="w-full font-semibold" disabled={loading}>
                {loading ? "Entrando..." : "Entrar"}
              </Button>
            </form>

            <p className="mt-5 text-center text-sm text-muted-foreground">
              Problemas para acessar? <Link to="/login" className="font-medium text-primary">Tente novamente</Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
