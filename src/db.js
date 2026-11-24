'use strict';

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  descricao TEXT NOT NULL DEFAULT '',
  preco_avista_cents INTEGER,
  prazo_entrega TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'disponivel'
    CHECK (status IN ('disponivel', 'reservado', 'vendido')),
  publicado INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  arquivo TEXT NOT NULL,
  ordem INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  telefone TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('ativa', 'fila', 'expirada', 'cancelada', 'convertida')),
  criada_em TEXT NOT NULL,
  expira_em TEXT,
  aviso_pendente INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  metodo TEXT NOT NULL CHECK (metodo IN ('pix', 'cartao')),
  valor_cents INTEGER NOT NULL,
  parcelas INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'aprovado', 'recusado')),
  mp_preference_id TEXT,
  mp_payment_id TEXT,
  criado_em TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reservations_product ON reservations(product_id, status);
CREATE INDEX IF NOT EXISTS idx_photos_product ON photos(product_id, ordem);
`;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  // Modo DELETE (padrão): WAL falha em pastas montadas do Windows no Docker Desktop
  // ("disk I/O error"). Para este volume de dados, o desempenho é suficiente.
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = DELETE;');
  db.exec(SCHEMA);
  // Migração: link de pagamento do Mercado Pago por produto.
  const colunas = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
  if (!colunas.includes('link_cartao')) db.exec("ALTER TABLE products ADD COLUMN link_cartao TEXT NOT NULL DEFAULT ''");
  // Migração: forma de pagamento escolhida (pix, cartao_link, cartao_local). Com ela preenchida,
  // a reserva deixa de expirar e só termina com a venda, o cancelamento ou a reabertura do item.
  const colunasReserva = db.prepare('PRAGMA table_info(reservations)').all().map((c) => c.name);
  if (!colunasReserva.includes('pagamento_escolhido')) db.exec('ALTER TABLE reservations ADD COLUMN pagamento_escolhido TEXT');
  return db;
}

module.exports = { openDb };
