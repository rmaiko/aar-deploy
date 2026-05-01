// js/cloud-config.js — Supabase project credentials (AMD-003, D-004).
//
// Anon key + project URL are PUBLIC values per Supabase's RLS-as-security
// model (NFR-A2). The service-role key is NEVER present here, in this
// repository, or in any deployed asset.
//
// Until provisioning (AMD-003 Appendix A) the values are null and
// cloudConfigured() returns false; auth.js / sync.js use that to short-
// circuit, preserving FR-200 (zero outbound Supabase requests when cloud
// is off — and trivially when cloud cannot be configured at all).
//
// At provisioning, replace the three constants below with the Supabase
// dashboard values and update the __SUPABASE_PROJECT_REF__ sentinel in
// index.html's CSP to the same project ref.

export const SUPABASE_URL = 'https://wkitzikustlkhlmrtnuu.supabase.co';       // e.g. 'https://abcd1234.supabase.co'
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndraXR6aWt1c3Rsa2hsbXJ0bnV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1MDA3OTQsImV4cCI6MjA5MzA3Njc5NH0.TkWodn7rfFE-J0i_ldXShPOTf7lh3AzRH1ARyO5qU1s';  // e.g. 'eyJhbGciOi…' (public anon key)
export const SUPABASE_REGION = 'West EU (Paris)'; // FR-219 privacy notice copy

export function cloudConfigured() {
  return typeof SUPABASE_URL === 'string'
      && SUPABASE_URL.length > 0
      && typeof SUPABASE_ANON_KEY === 'string'
      && SUPABASE_ANON_KEY.length > 0;
}
