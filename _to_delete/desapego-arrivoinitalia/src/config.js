'use strict';

// Configuração lida de variáveis de ambiente (ver .env.example).
// Nenhum segredo fica no código.

const path = require('path');

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (Number.isNaN(value)) throw new Error(`Variável ${name} inválida: ${raw}`);
  return value;
}

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const config = {
  port: num('PORT', 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
  dataDir,
  dbFile: path.join(dataDir, 'desapego-arrivoinitalia.sqlite'),
  uploadsDir: path.join(dataDir, 'uploads'),

  // Acesso ao painel administrativo.
  adminPassword: process.env.ADMIN_PASSWORD || '',

  // Reserva: tempo em horas que um interessado mantém o item reservado.
  reservaHoras: num('RESERVA_HORAS', 48),

  // WhatsApp do vendedor, em formato internacional sem símbolos.
  whatsappNumero: (process.env.WHATSAPP_NUMERO || '5548984443883').replace(/\D/g, ''),

  // Pix à vista com chave estática (conta Inter). Confirmação é manual.
  pix: {
    chave: process.env.PIX_CHAVE || '',
    nomeRecebedor: process.env.PIX_NOME || 'CLEO M GARCIA',
    cidade: process.env.PIX_CIDADE || 'FLORIANOPOLIS',
  },

  // Mercado Pago (parcelado com juros pagos pelo comprador).
  mercadoPago: {
    accessToken: process.env.MP_ACCESS_TOKEN || '',
    // Percentual total que o Mercado Pago retém na venda parcelada, incluindo
    // a antecipação do valor. Deve ser informado a partir do painel do MP.
    // Sem este valor, a opção de cartão parcelado fica desativada.
    custoParceladoPct: process.env.MP_CUSTO_PARCELADO_PCT
      ? Number(process.env.MP_CUSTO_PARCELADO_PCT)
      : null,
    parcelasMax: 6,
  },
};

module.exports = config;
