// Supabase データベース型定義
// CLAUDE.md の DBスキーマに基づく

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      documents: {
        Row: {
          id: string
          type: string
          vendor_name: string
          amount: number | null
          issue_date: string | null
          due_date: string | null
          description: string | null
          input_method: string
          status: string
          dropbox_path: string | null
          thumbnail_url: string | null
          ocr_raw: Json | null
          user_id: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          type: string
          vendor_name: string
          amount?: number | null
          issue_date?: string | null
          due_date?: string | null
          description?: string | null
          input_method: string
          status?: string
          dropbox_path?: string | null
          thumbnail_url?: string | null
          ocr_raw?: Json | null
          user_id: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          type?: string
          vendor_name?: string
          amount?: number | null
          issue_date?: string | null
          due_date?: string | null
          description?: string | null
          input_method?: string
          status?: string
          dropbox_path?: string | null
          thumbnail_url?: string | null
          ocr_raw?: Json | null
          user_id?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      mail_pending: {
        Row: {
          id: string
          file_name: string
          sender: string
          received_at: string | null
          ai_type: string | null
          ai_confidence: number | null
          temp_path: string | null
          status: string
          user_id: string
          created_at: string
        }
        Insert: {
          id?: string
          file_name: string
          sender: string
          received_at?: string | null
          ai_type?: string | null
          ai_confidence?: number | null
          temp_path?: string | null
          status?: string
          user_id: string
          created_at?: string
        }
        Update: {
          id?: string
          file_name?: string
          sender?: string
          received_at?: string | null
          ai_type?: string | null
          ai_confidence?: number | null
          temp_path?: string | null
          status?: string
          user_id?: string
          created_at?: string
        }
        Relationships: []
      }
      settings: {
        Row: {
          id: string
          key: string
          value: Json | null
          user_id: string
          updated_at: string
        }
        Insert: {
          id?: string
          key: string
          value?: Json | null
          user_id: string
          updated_at?: string
        }
        Update: {
          id?: string
          key?: string
          value?: Json | null
          user_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      allowed_senders: {
        Row: {
          id: string
          email: string
          display_name: string | null
          user_id: string
        }
        Insert: {
          id?: string
          email: string
          display_name?: string | null
          user_id: string
        }
        Update: {
          id?: string
          email?: string
          display_name?: string | null
          user_id?: string
        }
        Relationships: []
      }
      notify_recipients: {
        Row: {
          id: string
          email: string
          display_name: string | null
          user_id: string
        }
        Insert: {
          id?: string
          email: string
          display_name?: string | null
          user_id: string
        }
        Update: {
          id?: string
          email?: string
          display_name?: string | null
          user_id?: string
        }
        Relationships: []
      }
      document_types: {
        Row: {
          id: string
          name: string
          dropbox_folder: string | null
          icon: string | null
          sort_order: number
          is_default: boolean
          user_id: string
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          dropbox_folder?: string | null
          icon?: string | null
          sort_order?: number
          is_default?: boolean
          user_id: string
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          dropbox_folder?: string | null
          icon?: string | null
          sort_order?: number
          is_default?: boolean
          user_id?: string
          created_at?: string
        }
        Relationships: []
      }
      auto_classify_rules: {
        Row: {
          id: string
          keyword: string
          document_type: string
          priority: number
          is_active: boolean
          user_id: string
          created_at: string
        }
        Insert: {
          id?: string
          keyword: string
          document_type: string
          priority?: number
          is_active?: boolean
          user_id: string
          created_at?: string
        }
        Update: {
          id?: string
          keyword?: string
          document_type?: string
          priority?: number
          is_active?: boolean
          user_id?: string
          created_at?: string
        }
        Relationships: []
      }
      custom_folders: {
        Row: {
          id: string
          name: string
          monthly: boolean
          status_split: boolean
          date_field: string
          user_id: string
        }
        Insert: {
          id?: string
          name: string
          monthly?: boolean
          status_split?: boolean
          date_field?: string
          user_id: string
        }
        Update: {
          id?: string
          name?: string
          monthly?: boolean
          status_split?: boolean
          date_field?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
  }
}
