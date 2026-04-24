import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthProvider } from "@/contexts/AuthContext";
import AppLayout from "@/components/layout/AppLayout";
import Index from "./pages/Index";
import Login from "./pages/Login";
import ResetPassword from "./pages/ResetPassword";
import Dashboard from "./pages/Dashboard";
import ControleCompetencia from "./pages/ControleCompetencia";
import Empresas from "./pages/Empresas";
import Cadastro from "./pages/Cadastro";
import Credenciadas from "./pages/Credenciadas";
import Treinamentos from "./pages/Treinamentos";
import Importacao from "./pages/Importacao";
import Faturamento from "./pages/Faturamento";
import Configuracoes from "./pages/Configuracoes";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
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
          </BrowserRouter>
        </TooltipProvider>
      </AuthProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
