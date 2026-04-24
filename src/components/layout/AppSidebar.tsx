import { NavLink, useNavigate } from "react-router-dom";
import { LayoutDashboard, Building2, FileSpreadsheet, Receipt, Settings, LogOut, Upload, GraduationCap } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import logo from "@/assets/logo-medx.png";
import { cn } from "@/lib/utils";

const links = [
  { to: "/dashboard",    icon: LayoutDashboard, label: "Dashboard" },
  { to: "/cadastro",     icon: Building2,       label: "Cadastro" },
  { to: "/treinamentos", icon: GraduationCap,   label: "Treinamentos" },
  { to: "/importacao",   icon: Upload,          label: "Importação ESO" },
  { to: "/faturamento",  icon: Receipt,         label: "Faturamento" },
  { to: "/configuracoes",icon: Settings,        label: "Configurações" },
];

export default function AppSidebar() {
  const { logout, user } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <aside className="flex flex-col w-64 min-h-screen bg-sidebar border-r border-sidebar-border">
      <div className="flex items-center gap-3 px-6 py-5 border-b border-sidebar-border">
        <img src={logo} alt="MedX" className="h-9 w-auto" />
        <span className="font-display text-xl font-bold text-sidebar-foreground tracking-tight">MedX</span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {links.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-primary"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              )
            }
          >
            <Icon className="h-5 w-5" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="px-3 py-4 border-t border-sidebar-border">
        <div className="px-3 py-2 text-xs text-sidebar-foreground/50 truncate">{user?.email}</div>
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-destructive transition-colors"
        >
          <LogOut className="h-5 w-5" />
          Sair
        </button>
      </div>
    </aside>
  );
}
