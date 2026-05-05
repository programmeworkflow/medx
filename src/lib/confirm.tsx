// Substitui o `confirm()` nativo do browser por um diálogo bonito e tematizado.
//
// Uso:
//   const ok = await confirmDialog({
//     title: "Excluir empresa?",
//     description: "Esta ação não pode ser desfeita.",
//     confirmText: "Excluir",
//     variant: "danger",
//   });
//   if (ok) ... // procede com a ação
//
// Renderiza via React portal — não precisa de Provider.

import { createRoot, type Root } from "react-dom/client";
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, AlertCircle, CheckCircle2, Info } from "lucide-react";

export interface ConfirmOptions {
  title: string;
  description?: string | React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: "default" | "danger" | "warning" | "success";
}

const ICONS = {
  default: Info,
  danger: AlertTriangle,
  warning: AlertCircle,
  success: CheckCircle2,
};

const COLORS = {
  default: "text-primary bg-primary/10",
  danger: "text-destructive bg-destructive/10",
  warning: "text-warning bg-warning/10",
  success: "text-success bg-success/10",
};

function ConfirmDialogShell({
  options,
  onResolve,
}: {
  options: ConfirmOptions;
  onResolve: (result: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const Icon = ICONS[options.variant ?? "default"];
  const colorClass = COLORS[options.variant ?? "default"];

  // Esc fecha como cancelamento
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        onResolve(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onResolve]);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setOpen(false);
          onResolve(false);
        }
      }}
    >
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <div className={`mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full ${colorClass}`}>
            <Icon className="h-6 w-6" />
          </div>
          <AlertDialogTitle className="text-center font-display text-xl">{options.title}</AlertDialogTitle>
          {options.description && (
            <AlertDialogDescription className="text-center text-sm">
              {options.description}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter className="sm:justify-center gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
              onResolve(false);
            }}
            className="min-w-[100px]"
          >
            {options.cancelText ?? "Cancelar"}
          </Button>
          <Button
            variant={options.variant === "danger" ? "destructive" : "default"}
            onClick={() => {
              setOpen(false);
              onResolve(true);
            }}
            className="min-w-[100px]"
            autoFocus
          >
            {options.confirmText ?? "Confirmar"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

let activeRoot: Root | null = null;
let activeContainer: HTMLDivElement | null = null;

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // Cleanup anterior se houver
    if (activeRoot && activeContainer) {
      activeRoot.unmount();
      activeContainer.remove();
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    activeRoot = root;
    activeContainer = container;
    const handleResolve = (result: boolean) => {
      resolve(result);
      // Cleanup depois da animação
      setTimeout(() => {
        if (activeRoot === root) {
          root.unmount();
          container.remove();
          activeRoot = null;
          activeContainer = null;
        }
      }, 200);
    };
    root.render(<ConfirmDialogShell options={options} onResolve={handleResolve} />);
  });
}
