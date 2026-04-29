import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthProvider } from "@/contexts/AuthContext";
import AppLayout from "@/components/layout/AppLayout";

// Code splitting por rota — cada página vira um chunk separado.
// Reduz bundle inicial em ~60% (só baixa a página que abrir).
const Index = lazy(() => import("./pages/Index"));
const Login = lazy(() => import("./pages/Login"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const ControleCompetencia = lazy(() => import("./pages/ControleCompetencia"));
const Empresas = lazy(() => import("./pages/Empresas"));
const Cadastro = lazy(() => import("./pages/Cadastro"));
const Credenciadas = lazy(() => import("./pages/Credenciadas"));
const Treinamentos = lazy(() => import("./pages/Treinamentos"));
const Importacao = lazy(() => import("./pages/Importacao"));
const Faturamento = lazy(() => import("./pages/Faturamento"));
const Configuracoes = lazy(() => import("./pages/Configuracoes"));
const NotFound = lazy(() => import("./pages/NotFound"));

const queryClient = new QueryClient();

const PageLoader = () => (
  <div className="flex items-center justify-center min-h-[40vh] text-muted-foreground text-sm">
    Carregando…
  </div>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/login" element={<Login />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route element={<AppLayout />}>
                  <Route path="/dashboard" element={<Dashboard />} />
                  <Route path="/competencia/:id" element={<ControleCompetencia />} />
                  <Route path="/empresas" element={<Empresas />} />
                  <Route path="/cadastro" element={<Cadastro />} />
                  <Route path="/cadastro/empresas" element={<Cadastro />} />
                  <Route path="/cadastro/credenciadas" element={<Cadastro />} />
                  <Route path="/credenciadas" element={<Credenciadas />} />
                  <Route path="/treinamentos" element={<Treinamentos />} />
                  <Route path="/importacao" element={<Importacao />} />
                  <Route path="/faturamento" element={<Faturamento />} />
                  <Route path="/configuracoes" element={<Configuracoes />} />
                </Route>
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </TooltipProvider>
      </AuthProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
