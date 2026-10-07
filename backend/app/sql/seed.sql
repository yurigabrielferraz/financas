-- Dados iniciais (só quando as tabelas estão vazias). Compartilhado com o app Android.
INSERT INTO categories (name, kind, color)
SELECT column1, column2, column3 FROM (VALUES
  ('Moradia', 'expense', '#6366f1'),
  ('Contas de consumo', 'expense', '#0ea5e9'),
  ('Mercado', 'expense', '#22c55e'),
  ('Alimentação', 'expense', '#f97316'),
  ('Transporte', 'expense', '#eab308'),
  ('Saúde', 'expense', '#ef4444'),
  ('Educação', 'expense', '#8b5cf6'),
  ('Lazer', 'expense', '#ec4899'),
  ('Assinaturas', 'expense', '#14b8a6'),
  ('Compras', 'expense', '#f43f5e'),
  ('Impostos e taxas', 'expense', '#78716c'),
  ('Outros', 'expense', '#64748b'),
  ('Salário', 'income', '#16a34a'),
  ('Freelance', 'income', '#0891b2'),
  ('Investimentos', 'income', '#7c3aed'),
  ('Outras receitas', 'income', '#64748b')
) WHERE NOT EXISTS (SELECT 1 FROM categories);

INSERT INTO accounts (name, type)
SELECT 'Conta principal', 'checking' WHERE NOT EXISTS (SELECT 1 FROM accounts);
