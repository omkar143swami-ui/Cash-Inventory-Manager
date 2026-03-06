-- ============================================================
--  Cash Inventory Manager — Supabase PostgreSQL Schema
--  Run this entire script in: Supabase Dashboard → SQL Editor
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. PROFILES TABLE (extends auth.users with roles)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id        UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email     TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'Cashier'
              CHECK (role IN ('Admin', 'Cashier', 'Auditor')),
  full_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-create profile on user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1))
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ────────────────────────────────────────────────────────────
-- 2. DENOMINATIONS TABLE
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.denominations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  value        INTEGER NOT NULL UNIQUE,   -- e.g. 500, 200, 100
  label        TEXT NOT NULL,             -- e.g. '₹500'
  available    INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS denominations_updated_at ON public.denominations;
CREATE TRIGGER denominations_updated_at
  BEFORE UPDATE ON public.denominations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ────────────────────────────────────────────────────────────
-- 3. TRANSACTIONS TABLE
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  denomination_id UUID NOT NULL REFERENCES public.denominations(id) ON DELETE RESTRICT,
  notes_in        INTEGER NOT NULL DEFAULT 0 CHECK (notes_in >= 0),
  notes_out       INTEGER NOT NULL DEFAULT 0 CHECK (notes_out >= 0),
  note            TEXT,                   -- optional description
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS transactions_updated_at ON public.transactions;
CREATE TRIGGER transactions_updated_at
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auto-adjust denomination stock when a transaction is inserted
CREATE OR REPLACE FUNCTION public.apply_transaction()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.denominations
  SET available = available + NEW.notes_in - NEW.notes_out
  WHERE id = NEW.denomination_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_transaction_insert ON public.transactions;
CREATE TRIGGER on_transaction_insert
  AFTER INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.apply_transaction();

-- Reverse old values and apply new values on UPDATE
CREATE OR REPLACE FUNCTION public.reapply_transaction()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.denominations
  SET available = available - (OLD.notes_in - OLD.notes_out) + (NEW.notes_in - NEW.notes_out)
  WHERE id = NEW.denomination_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_transaction_update ON public.transactions;
CREATE TRIGGER on_transaction_update
  AFTER UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.reapply_transaction();

-- Reverse values on DELETE
CREATE OR REPLACE FUNCTION public.reverse_transaction()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.denominations
  SET available = available - OLD.notes_in + OLD.notes_out
  WHERE id = OLD.denomination_id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS on_transaction_delete ON public.transactions;
CREATE TRIGGER on_transaction_delete
  AFTER DELETE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.reverse_transaction();


-- ────────────────────────────────────────────────────────────
-- 4. AUDIT LOG TABLE
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  details     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);


-- ────────────────────────────────────────────────────────────
-- 5. ROW LEVEL SECURITY (RLS)
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.denominations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log      ENABLE ROW LEVEL SECURITY;

-- Helper: get caller's role
CREATE OR REPLACE FUNCTION public.my_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

-- ── profiles ────────────────────────────────────────────────
CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Admin can read all profiles"
  ON public.profiles FOR SELECT
  USING (public.my_role() = 'Admin');

CREATE POLICY "Admin can update all profiles"
  ON public.profiles FOR UPDATE
  USING (public.my_role() = 'Admin');

-- ── denominations ────────────────────────────────────────────
CREATE POLICY "All authenticated users can read denominations"
  ON public.denominations FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admin can manage denominations"
  ON public.denominations FOR ALL
  USING (public.my_role() = 'Admin');

-- ── transactions ─────────────────────────────────────────────
CREATE POLICY "All authenticated users can read transactions"
  ON public.transactions FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Cashier and Admin can insert transactions"
  ON public.transactions FOR INSERT
  WITH CHECK (public.my_role() IN ('Admin', 'Cashier'));

CREATE POLICY "Cashier can update own transactions"
  ON public.transactions FOR UPDATE
  USING (
    (public.my_role() = 'Cashier' AND user_id = auth.uid())
    OR public.my_role() = 'Admin'
  );

CREATE POLICY "Admin can delete transactions"
  ON public.transactions FOR DELETE
  USING (public.my_role() = 'Admin');

-- ── audit_log ────────────────────────────────────────────────
CREATE POLICY "Admin and Auditor can read audit log"
  ON public.audit_log FOR SELECT
  USING (public.my_role() IN ('Admin', 'Auditor'));

CREATE POLICY "System can insert audit log"
  ON public.audit_log FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');


-- ────────────────────────────────────────────────────────────
-- 6. SEED DATA — Indian Rupee Denominations
-- ────────────────────────────────────────────────────────────
INSERT INTO public.denominations (value, label, available, sort_order) VALUES
  (500,  '₹500',  0, 2),
  (200,  '₹200',  0, 3),
  (100,  '₹100',  0, 4),
  (50,   '₹50',   0, 5),
  (20,   '₹20',   0, 6),
  (10,   '₹10',   0, 7)
ON CONFLICT (value) DO NOTHING;

-- ────────────────────────────────────────────────────────────
-- 7. ENABLE REALTIME on key tables
-- ────────────────────────────────────────────────────────────
-- Run these in the Supabase Dashboard under Database → Replication
-- or use the SQL below (requires supabase_realtime publication):
ALTER PUBLICATION supabase_realtime ADD TABLE public.denominations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.audit_log;
