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
          tax_category: string | null
          account_title: string | null
          file_hash: string | null
          calendar_event_id: string | null
          registrant_id: string | null
          document_staff_id: string | null
          payment_status: string
          payment_method: string | null
          bank_info: Json | null
          payment_purpose: string | null
          split_group: string | null
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
          tax_category?: string | null
          account_title?: string | null
          file_hash?: string | null
          calendar_event_id?: string | null
          registrant_id?: string | null
          document_staff_id?: string | null
          payment_status?: string
          payment_method?: string | null
          bank_info?: Json | null
          payment_purpose?: string | null
          split_group?: string | null
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
          tax_category?: string | null
          account_title?: string | null
          file_hash?: string | null
          calendar_event_id?: string | null
          registrant_id?: string | null
          document_staff_id?: string | null
          payment_status?: string
          payment_method?: string | null
          bank_info?: Json | null
          payment_purpose?: string | null
          split_group?: string | null
          user_id?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      registrants: {
        Row: {
          id: string
          name: string
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          created_at?: string
        }
        Relationships: []
      }
      document_staff: {
        Row: {
          id: string
          name: string
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          created_at?: string
        }
        Relationships: []
      }
      analysis_reports: {
        Row: {
          id: string
          title: string
          year: number
          month: number
          total_amount: number
          doc_count: number
          category_breakdown: Json
          weekly_breakdown: Json
          ai_summary: string | null
          ai_suggestions: Json | null
          created_at: string
        }
        Insert: {
          id?: string
          title: string
          year: number
          month: number
          total_amount?: number
          doc_count?: number
          category_breakdown?: Json
          weekly_breakdown?: Json
          ai_summary?: string | null
          ai_suggestions?: Json | null
          created_at?: string
        }
        Update: {
          id?: string
          title?: string
          year?: number
          month?: number
          total_amount?: number
          doc_count?: number
          category_breakdown?: Json
          weekly_breakdown?: Json
          ai_summary?: string | null
          ai_suggestions?: Json | null
          created_at?: string
        }
        Relationships: []
      }
      tax_folder_copy_runs: {
        Row: {
          id: string
          run_at: string
          run_by: string | null
          run_type: string
          period_start: string
          period_end: string
          target_folders: string[]
          summary: Json
          issues: Json | null
          created_at: string
        }
        Insert: {
          id?: string
          run_at?: string
          run_by?: string | null
          run_type: string
          period_start: string
          period_end: string
          target_folders?: string[]
          summary: Json
          issues?: Json | null
          created_at?: string
        }
        Update: {
          id?: string
          run_at?: string
          run_by?: string | null
          run_type?: string
          period_start?: string
          period_end?: string
          target_folders?: string[]
          summary?: Json
          issues?: Json | null
          created_at?: string
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
      download_sources: {
        Row: {
          id: string
          name: string
          url: string | null
          description: string | null
          schedule: string
          last_downloaded_at: string | null
          is_active: boolean
          login_info_encrypted: string | null
          user_id: string
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          url?: string | null
          description?: string | null
          schedule?: string
          last_downloaded_at?: string | null
          is_active?: boolean
          login_info_encrypted?: string | null
          user_id: string
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          url?: string | null
          description?: string | null
          schedule?: string
          last_downloaded_at?: string | null
          is_active?: boolean
          login_info_encrypted?: string | null
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
      document_items: {
        Row: {
          id: string
          document_id: string
          user_id: string
          item_name: string
          quantity: number | null
          unit_price: number | null
          amount: number
          category: string
          tax_rate: string
          notes: string
          created_at: string
        }
        Insert: {
          id?: string
          document_id: string
          user_id: string
          item_name?: string
          quantity?: number | null
          unit_price?: number | null
          amount?: number
          category?: string
          tax_rate?: string
          notes?: string
          created_at?: string
        }
        Update: {
          id?: string
          document_id?: string
          user_id?: string
          item_name?: string
          quantity?: number | null
          unit_price?: number | null
          amount?: number
          category?: string
          tax_rate?: string
          notes?: string
          created_at?: string
        }
        Relationships: []
      }
      scan_items: {
        Row: {
          id: string
          dropbox_path: string
          file_name: string
          file_hash: string | null
          status: string
          review_reasons: string[] | null
          error_message: string | null
          document_id: string | null
          user_id: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          dropbox_path: string
          file_name: string
          file_hash?: string | null
          status?: string
          review_reasons?: string[] | null
          error_message?: string | null
          document_id?: string | null
          user_id: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          dropbox_path?: string
          file_name?: string
          file_hash?: string | null
          status?: string
          review_reasons?: string[] | null
          error_message?: string | null
          document_id?: string | null
          user_id?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      staff_members: {
        Row: {
          id: string
          name: string
          line_user_id: string | null
          created_at: string
          // 031_first_atc_claimed.sql で追加（履歴保持のため残置。読み書きは停止）
          first_atc_claimed_at: string | null
          // 032_seminar_repeat_claimed.sql で追加（セミナー2回目以降の登録完了日時。非NULL=以降「初回ATC＋アカデミー会員費」を非表示）
          seminar_repeat_claimed_at: string | null
          // 033_staff_home_station.sql で追加（領収書なし交通費の電車運賃AI推定に使う自宅最寄り駅）
          home_station: string | null
          home_station_pref: string | null
          // 035_staff_is_test.sql で追加（テストスタッフ＝保存先分離・集計/通知から除外）
          is_test: boolean
        }
        Insert: {
          id?: string
          name: string
          line_user_id?: string | null
          created_at?: string
          first_atc_claimed_at?: string | null
          seminar_repeat_claimed_at?: string | null
          home_station?: string | null
          home_station_pref?: string | null
          is_test?: boolean
        }
        Update: {
          id?: string
          name?: string
          line_user_id?: string | null
          created_at?: string
          first_atc_claimed_at?: string | null
          seminar_repeat_claimed_at?: string | null
          home_station?: string | null
          home_station_pref?: string | null
          is_test?: boolean
        }
        Relationships: []
      }
      line_transit_sessions: {
        // 034_line_transit_sessions.sql で追加（LINE「領収書なし交通費」申請の対話セッション）
        Row: {
          line_user_id: string
          staff_member_id: string | null
          step: string
          data: Json
          updated_at: string
        }
        Insert: {
          line_user_id: string
          staff_member_id?: string | null
          step: string
          data?: Json
          updated_at?: string
        }
        Update: {
          line_user_id?: string
          staff_member_id?: string | null
          step?: string
          data?: Json
          updated_at?: string
        }
        Relationships: []
      }
      staff_receipts: {
        Row: {
          id: string
          staff_member_id: string
          file_name: string
          dropbox_path: string
          document_type: string | null
          date: string | null
          amount: number | null
          store_name: string | null
          tax_category: string | null
          account_title: string | null
          ai_raw: Json | null
          created_at: string
          // 030_staff_receipt_image_hash.sql で追加（重複検知用の画像SHA-256）
          image_hash: string | null
        }
        Insert: {
          id?: string
          staff_member_id: string
          file_name: string
          dropbox_path: string
          document_type?: string | null
          date?: string | null
          amount?: number | null
          store_name?: string | null
          tax_category?: string | null
          account_title?: string | null
          ai_raw?: Json | null
          created_at?: string
          image_hash?: string | null
        }
        Update: {
          id?: string
          staff_member_id?: string
          file_name?: string
          dropbox_path?: string
          document_type?: string | null
          date?: string | null
          amount?: number | null
          store_name?: string | null
          tax_category?: string | null
          account_title?: string | null
          ai_raw?: Json | null
          created_at?: string
          image_hash?: string | null
        }
        Relationships: []
      }
      manual_categories: {
        Row: {
          id: string
          name: string
          emoji: string
          description: string | null
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          emoji?: string
          description?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          emoji?: string
          description?: string | null
          created_at?: string
        }
        Relationships: []
      }
      manuals: {
        Row: {
          id: string
          category_id: string | null
          title: string
          content: string
          source: string | null
          created_at: string
        }
        Insert: {
          id?: string
          category_id?: string | null
          title: string
          content: string
          source?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          category_id?: string | null
          title?: string
          content?: string
          source?: string | null
          created_at?: string
        }
        Relationships: []
      }
      business_cards: {
        Row: {
          id: string
          company_name: string | null
          department: string | null
          name: string | null
          title: string | null
          email: string | null
          phone: string | null
          mobile: string | null
          address: string | null
          website: string | null
          memo: string | null
          dropbox_path: string | null
          file_name: string | null
          created_at: string
        }
        Insert: {
          id?: string
          company_name?: string | null
          department?: string | null
          name?: string | null
          title?: string | null
          email?: string | null
          phone?: string | null
          mobile?: string | null
          address?: string | null
          website?: string | null
          memo?: string | null
          dropbox_path?: string | null
          file_name?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          company_name?: string | null
          department?: string | null
          name?: string | null
          title?: string | null
          email?: string | null
          phone?: string | null
          mobile?: string | null
          address?: string | null
          website?: string | null
          memo?: string | null
          dropbox_path?: string | null
          file_name?: string | null
          created_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          user_id: string
          role: string
          display_name: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          role?: string
          display_name?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          role?: string
          display_name?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      petty_cash_settings: {
        Row: {
          id: string
          balance: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          balance?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          balance?: number
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      petty_cash_transactions: {
        Row: {
          id: string
          type: string
          amount: number
          description: string | null
          staff_member_id: string | null
          staff_receipt_id: string | null
          document_id: string | null
          receipt_image_url: string | null
          dropbox_path: string | null
          registered_by: string | null
          created_at: string
          // 023_petty_cash_unified.sql で追加
          category: string | null
          subcategory: string | null
          receipt_urls: Json | null
          note: string | null
          created_by: string | null
          transaction_date: string | null
          balance_after: number | null
          // 024_staff_refund_settlement.sql で追加
          settlement_method: string | null
          payroll_refund_status: string | null
          payroll_refunded_at: string | null
          // 026_subsidy_category.sql で追加
          subsidy_category: string | null
          // 029_staff_receipt_expense_detail.sql で追加（スタッフ立替の詳細区分）
          expense_detail: string | null
        }
        Insert: {
          id?: string
          type: string
          amount: number
          description?: string | null
          staff_member_id?: string | null
          staff_receipt_id?: string | null
          document_id?: string | null
          receipt_image_url?: string | null
          dropbox_path?: string | null
          registered_by?: string | null
          created_at?: string
          category?: string | null
          subcategory?: string | null
          receipt_urls?: Json | null
          note?: string | null
          created_by?: string | null
          transaction_date?: string | null
          balance_after?: number | null
          settlement_method?: string | null
          payroll_refund_status?: string | null
          payroll_refunded_at?: string | null
          subsidy_category?: string | null
          expense_detail?: string | null
        }
        Update: {
          id?: string
          type?: string
          amount?: number
          description?: string | null
          staff_member_id?: string | null
          staff_receipt_id?: string | null
          document_id?: string | null
          receipt_image_url?: string | null
          dropbox_path?: string | null
          registered_by?: string | null
          created_at?: string
          category?: string | null
          subcategory?: string | null
          receipt_urls?: Json | null
          note?: string | null
          created_by?: string | null
          transaction_date?: string | null
          balance_after?: number | null
          settlement_method?: string | null
          payroll_refund_status?: string | null
          payroll_refunded_at?: string | null
          subsidy_category?: string | null
          expense_detail?: string | null
        }
        Relationships: []
      }
      refund_records: {
        Row: {
          id: string
          user_id: string
          patient_name: string | null
          amount: number | null
          cancel_date: string | null
          refund_date: string | null
          service_name: string | null
          staff_name: string | null
          description: string | null
          dropbox_path: string | null
          file_hash: string | null
          ocr_raw: Json | null
          status: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          patient_name?: string | null
          amount?: number | null
          cancel_date?: string | null
          refund_date?: string | null
          service_name?: string | null
          staff_name?: string | null
          description?: string | null
          dropbox_path?: string | null
          file_hash?: string | null
          ocr_raw?: Json | null
          status?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          patient_name?: string | null
          amount?: number | null
          cancel_date?: string | null
          refund_date?: string | null
          service_name?: string | null
          staff_name?: string | null
          description?: string | null
          dropbox_path?: string | null
          file_hash?: string | null
          ocr_raw?: Json | null
          status?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      payment_memos: {
        Row: {
          id: string
          raw_text: string | null
          image_url: string | null
          ai_summary: string | null
          created_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          raw_text?: string | null
          image_url?: string | null
          ai_summary?: string | null
          created_by?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          raw_text?: string | null
          image_url?: string | null
          ai_summary?: string | null
          created_by?: string | null
          created_at?: string
        }
        Relationships: []
      }
      payment_memo_items: {
        Row: {
          id: string
          memo_id: string | null
          vendor_name: string | null
          amount: number | null
          due_date: string | null
          payment_method: string | null
          note: string | null
          payment_status: string
          linked_document_id: string | null
          created_at: string
        }
        Insert: {
          id?: string
          memo_id?: string | null
          vendor_name?: string | null
          amount?: number | null
          due_date?: string | null
          payment_method?: string | null
          note?: string | null
          payment_status?: string
          linked_document_id?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          memo_id?: string | null
          vendor_name?: string | null
          amount?: number | null
          due_date?: string | null
          payment_method?: string | null
          note?: string | null
          payment_status?: string
          linked_document_id?: string | null
          created_at?: string
        }
        Relationships: []
      }
      vendor_payment_methods: {
        // 036_vendor_payment_methods.sql で追加（支払先ごとの支払方法マスタ・AI判定より優先）
        Row: {
          vendor_name: string
          method: string
          updated_at: string
        }
        Insert: {
          vendor_name: string
          method?: string
          updated_at?: string
        }
        Update: {
          vendor_name?: string
          method?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
  }
}
