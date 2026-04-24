export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      competencias: {
        Row: {
          ano: number
          criado_em: string
          id: string
          mes: number
          status: Database["public"]["Enums"]["status_competencia"]
        }
        Insert: {
          ano: number
          criado_em?: string
          id?: string
          mes: number
          status?: Database["public"]["Enums"]["status_competencia"]
        }
        Update: {
          ano?: number
          criado_em?: string
          id?: string
          mes?: number
          status?: Database["public"]["Enums"]["status_competencia"]
        }
        Relationships: []
      }
      empresas: {
        Row: {
          ativa: boolean
          categoria: Database["public"]["Enums"]["categoria_empresa"]
          cnpj: string
          criado_em: string
          empresa_faturadora_id: string | null
          id: string
          nome_empresa: string
          observacoes: string | null
          tipo_faturamento: Database["public"]["Enums"]["tipo_faturamento"]
          vidas_contrato: number | null
          vidas_eso: number | null
          data_fechamento_especial: string | null
          janela_fechamento: string | null
        }
        Insert: {
          ativa?: boolean
          categoria: Database["public"]["Enums"]["categoria_empresa"]
          cnpj: string
          criado_em?: string
          empresa_faturadora_id?: string | null
          id?: string
          nome_empresa: string
          observacoes?: string | null
          tipo_faturamento?: Database["public"]["Enums"]["tipo_faturamento"]
          vidas_contrato?: number | null
          vidas_eso?: number | null
          data_fechamento_especial?: string | null
          janela_fechamento?: string | null
        }
        Update: {
          ativa?: boolean
          categoria?: Database["public"]["Enums"]["categoria_empresa"]
          cnpj?: string
          criado_em?: string
          empresa_faturadora_id?: string | null
          id?: string
          nome_empresa?: string
          observacoes?: string | null
          tipo_faturamento?: Database["public"]["Enums"]["tipo_faturamento"]
          vidas_contrato?: number | null
          vidas_eso?: number | null
          data_fechamento_especial?: string | null
          janela_fechamento?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "empresas_empresa_faturadora_id_fkey"
            columns: ["empresa_faturadora_id"]
            isOneToOne: false
            referencedRelation: "empresas"
            referencedColumns: ["id"]
          },
        ]
      }
      credenciadas: {
        Row: {
          id: string
          nome: string
          cnpj: string
          possui_contrato: boolean
          data_contrato: string | null
          email_faturamento: string | null
          envia_correios: boolean
          endereco_despacho: string | null
          cep: string | null
          tabela_preco_url: string | null
          contrato_url: string | null
          observacoes: string | null
          ativa: boolean
          criado_em: string
          atualizado_em: string
        }
        Insert: {
          id?: string
          nome: string
          cnpj: string
          possui_contrato?: boolean
          data_contrato?: string | null
          email_faturamento?: string | null
          envia_correios?: boolean
          endereco_despacho?: string | null
          cep?: string | null
          tabela_preco_url?: string | null
          contrato_url?: string | null
          observacoes?: string | null
          ativa?: boolean
          criado_em?: string
          atualizado_em?: string
        }
        Update: {
          id?: string
          nome?: string
          cnpj?: string
          possui_contrato?: boolean
          data_contrato?: string | null
          email_faturamento?: string | null
          envia_correios?: boolean
          endereco_despacho?: string | null
          cep?: string | null
          tabela_preco_url?: string | null
          contrato_url?: string | null
          observacoes?: string | null
          ativa?: boolean
          criado_em?: string
          atualizado_em?: string
        }
        Relationships: []
      }
      treinamentos: {
        Row: {
          id: string
          empresa_id: string | null
          nome: string
          modalidade: Database["public"]["Enums"]["modalidade_treinamento"]
          diaria_instrutor: number | null
          valor_bruto: number
          valor_comissao: number
          data_treinamento: string
          data_pagamento: string | null
          observacoes: string | null
          criado_em: string
        }
        Insert: {
          id?: string
          empresa_id?: string | null
          nome: string
          modalidade?: Database["public"]["Enums"]["modalidade_treinamento"]
          diaria_instrutor?: number | null
          valor_bruto?: number
          data_treinamento: string
          data_pagamento?: string | null
          observacoes?: string | null
          criado_em?: string
        }
        Update: {
          id?: string
          empresa_id?: string | null
          nome?: string
          modalidade?: Database["public"]["Enums"]["modalidade_treinamento"]
          diaria_instrutor?: number | null
          valor_bruto?: number
          data_treinamento?: string
          data_pagamento?: string | null
          observacoes?: string | null
          criado_em?: string
        }
        Relationships: [
          {
            foreignKeyName: "treinamentos_empresa_id_fkey"
            columns: ["empresa_id"]
            isOneToOne: false
            referencedRelation: "empresas"
            referencedColumns: ["id"]
          },
        ]
      }
      faturamentos: {
        Row: {
          categoria_snapshot: string
          competencia_id: string
          criado_em: string
          empresa_executora_id: string
          empresa_faturadora_id: string
          id: string
          link_relatorio_eso: string | null
          observacoes_mes: string | null
          status: Database["public"]["Enums"]["status_faturamento"]
          valor: number | null
        }
        Insert: {
          categoria_snapshot: string
          competencia_id: string
          criado_em?: string
          empresa_executora_id: string
          empresa_faturadora_id: string
          id?: string
          link_relatorio_eso?: string | null
          observacoes_mes?: string | null
          status?: Database["public"]["Enums"]["status_faturamento"]
          valor?: number | null
        }
        Update: {
          categoria_snapshot?: string
          competencia_id?: string
          criado_em?: string
          empresa_executora_id?: string
          empresa_faturadora_id?: string
          id?: string
          link_relatorio_eso?: string | null
          observacoes_mes?: string | null
          status?: Database["public"]["Enums"]["status_faturamento"]
          valor?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "faturamentos_competencia_id_fkey"
            columns: ["competencia_id"]
            isOneToOne: false
            referencedRelation: "competencias"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "faturamentos_empresa_executora_id_fkey"
            columns: ["empresa_executora_id"]
            isOneToOne: false
            referencedRelation: "empresas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "faturamentos_empresa_faturadora_id_fkey"
            columns: ["empresa_faturadora_id"]
            isOneToOne: false
            referencedRelation: "empresas"
            referencedColumns: ["id"]
          },
        ]
      }
      importacoes_eso: {
        Row: {
          competencia_id: string
          data_importacao: string
          id: string
          nome_arquivo: string
          usuario_id: string
        }
        Insert: {
          competencia_id: string
          data_importacao?: string
          id?: string
          nome_arquivo: string
          usuario_id: string
        }
        Update: {
          competencia_id?: string
          data_importacao?: string
          id?: string
          nome_arquivo?: string
          usuario_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "importacoes_eso_competencia_id_fkey"
            columns: ["competencia_id"]
            isOneToOne: false
            referencedRelation: "competencias"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      categoria_empresa:
        | "medwork"
        | "medwork_porto"
        | "avista"
        | "especial"
        | "credenciada"
        | "mensalidade"
        | "labore"
      modalidade_treinamento: "presencial" | "ead"
      status_competencia: "aberto" | "concluido"
      status_faturamento:
        | "pendente"
        | "aguardando_oc"
        | "conferencia"
        | "faturado"
        | "pago_avista"
        | "concluido"
        | "sem_cadastro"
      tipo_faturamento: "propria_empresa" | "outra_empresa"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      categoria_empresa: [
        "medwork",
        "medwork_porto",
        "avista",
        "especial",
        "credenciada",
        "mensalidade",
        "labore",
      ],
      status_competencia: ["aberto", "concluido"],
      status_faturamento: [
        "pendente",
        "aguardando_oc",
        "conferencia",
        "faturado",
        "pago_avista",
        "concluido",
        "sem_cadastro",
      ],
      tipo_faturamento: ["propria_empresa", "outra_empresa"],
    },
  },
} as const
