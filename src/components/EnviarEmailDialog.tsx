import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Mail, Send } from "lucide-react";
import { toast } from "sonner";

interface Props {
  vendaId: string | null;
  vendaNumero?: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export default function EnviarEmailDialog({ vendaId, vendaNumero, open, onOpenChange }: Props) {
  const [emails, setEmails] = useState<string>("");
  const [carregando, setCarregando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [customerName, setCustomerName] = useState<string>("");

  useEffect(() => {
    if (!open || !vendaId) return;
    setCarregando(true);
    setEmails("");
    setCustomerName("");
    fetch(`/api/contaazul/billing-contact-venda?vendaId=${vendaId}`)
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j?.emails)) setEmails(j.emails.join(", "));
        if (j?.customerName) setCustomerName(j.customerName);
      })
      .catch(() => {})
      .finally(() => setCarregando(false));
  }, [open, vendaId]);

  const handleEnviar = async () => {
    if (!vendaId) return;
    const lista = emails
      .split(/[,;\s]+/)
      .map((e) => e.trim())
      .filter((e) => e.includes("@"));
    if (lista.length === 0) return toast.error("Informe ao menos um email válido");
    setEnviando(true);
    try {
      const r = await fetch("/api/contaazul/send-email-venda", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendaId, emails: lista }),
      });
      const j = await r.json();
      if (!r.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${r.status}`);
      toast.success(`Email enviado para ${lista.length} destinatário(s)`);
      onOpenChange(false);
    } catch (e: any) {
      toast.error(`Erro: ${e?.message}`);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Enviar e-mail{vendaNumero ? ` — Venda #${vendaNumero}` : ""}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          {customerName && (
            <p className="text-sm text-muted-foreground">
              Cliente: <span className="font-medium text-foreground">{customerName}</span>
            </p>
          )}
          <div className="space-y-2">
            <Label>Destinatário(s)</Label>
            <Input
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder={carregando ? "Buscando emails do cliente..." : "email1@ex.com, email2@ex.com"}
              disabled={carregando}
            />
            <p className="text-xs text-muted-foreground">
              Múltiplos emails separados por vírgula. Default vem do contato de cobrança da CA.
            </p>
          </div>
          <Button onClick={handleEnviar} disabled={enviando || carregando} className="w-full">
            <Send className="h-4 w-4 mr-2" />
            {enviando ? "Enviando..." : "Enviar e-mail"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
