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

// Referência: tarifa de crédito com recebimento na hora (4,98%) somada à taxa de parcelamento
// publicada pelo Mercado Pago para link de pagamento (2x 2,53% ... 6x 9,96%). Os valores podem
// mudar e variar por conta: confirme no simulador do Mercado Pago e ajuste MP_TAXAS_PARCELAS.
const TAXAS_PADRAO = { 1: 4.98, 2: 7.51, 3: 9.6, 4: 11.67, 5: 13.64, 6: 14.94 };

function taxasParcelas(raw) {
  if (!raw) return { ...TAXAS_PADRAO };
  const taxas = {};
  for (const par of raw.split(',')) {
    const [n, pct] = par.split(':').map((x) => Number(x.trim().replace(',', '.')));
    if (!Number.isInteger(n) || n < 1 || n > 6 || Number.isNaN(pct) || pct < 0 || pct >= 100) {
      throw new Error(`MP_TAXAS_PARCELAS inválida: ${par}`);
    }
    taxas[n] = pct;
  }
  return taxas;
}

const TAXAS_MAQUININHA = { 1: 3.09, 2: 5.79, 3: 6.09, 4: 7.99, 5: 8.09, 6: 8.19 };

function taxasMaquininha(raw) {
  if (!raw) return { ...TAXAS_MAQUININHA };
  const taxas = {};
  for (const par of raw.split(',')) {
    const [n, pct] = par.split(':').map((x) => Number(x.trim().replace(',', '.')));
    if (!Number.isInteger(n) || n < 1 || n > 6 || Number.isNaN(pct) || pct < 0 || pct >= 100) {
      throw new Error(`MAQ_TAXAS_PARCELAS inválida: ${par}`);
    }
    taxas[n] = pct;
  }
  return taxas;
}

function jurosLink(raw, seis) {
  const base = { 2: 9.64, 3: 11.23, 4: 11.36, 5: 14.31 };
  if (raw) {
    const j = {};
    for (const par of raw.split(',')) {
      const [n, pct] = par.split(':').map((x) => Number(x.trim().replace(',', '.')));
      if (!Number.isInteger(n) || n < 2 || n > 6 || Number.isNaN(pct) || pct < 0 || pct >= 100) {
        throw new Error(`LINK_JUROS_PARCELAS inválida: ${par}`);
      }
      j[n] = pct;
    }
    return j;
  }
  if (seis) {
    const v = Number(String(seis).replace(',', '.'));
    if (Number.isNaN(v) || v < 0 || v >= 100) throw new Error('LINK_JUROS_6X inválida');
    base[6] = v;
  }
  return base;
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
    // Exibidos no aviso "Atenção" do Pix, para o comprador conferir o destinatário.
    titular: process.env.PIX_TITULAR || '',
    banco: process.env.PIX_BANCO || '',
    cpf: (process.env.PIX_CPF || '').replace(/\D/g, ''),
  },

  // Cartão por link de pagamento do Mercado Pago (um link por produto, cadastrado no painel).
  // Regras exibidas pelo simulador do Mercado Pago (Link de pagamento, cartão de crédito):
  // - à vista: preço do Pix / (1 - tarifa de processamento); o vendedor recebe o preço do Pix;
  // - parcelado: juros do comprador (% sobre o valor à vista no cartão), sem alterar o líquido.
  // Referência (venda de R$ 520,00): à vista R$ 547,25; 2x 9,64%; 3x 11,23%; 4x 11,36%; 5x 14,31%.
  // O percentual de 6x não aparece no exemplo: informe em LINK_JUROS_6X (ou todos em LINK_JUROS_PARCELAS).
  linkCartao: {
    tarifaPct: num('LINK_TARIFA_PCT', 4.98),
    jurosPct: jurosLink(process.env.LINK_JUROS_PARCELAS, process.env.LINK_JUROS_6X),
    parcelasMax: 6,
  },

  // Mercado Pago (parcelado com juros pagos pelo comprador).
  mercadoPago: {
    accessToken: process.env.MP_ACCESS_TOKEN || '',
    // Taxa total (%) retida pelo Mercado Pago por número de parcelas, já somando a tarifa
    // de recebimento na hora e a taxa de parcelamento. Repassada integralmente ao comprador.
    taxasPct: taxasParcelas(process.env.MP_TAXAS_PARCELAS),
    parcelasMax: 6,
    // 'comprador' (padrão): o site envia o valor da venda à vista no cartão (com a tarifa de
    // recebimento na hora) e o Mercado Pago calcula e cobra os juros do parcelamento do comprador.
    // 'embutido': o site calcula cada parcela e embute as taxas no valor (exige conta do
    // Mercado Pago com parcelamento sem acréscimo).
    // No modo 'comprador', por padrão o site envia exatamente o preço do produto e o Mercado Pago
    // calcula o resto. A tarifa de 4,98% então sai do vendedor. Com MP_REPASSAR_TARIFA=sim, o
    // site soma a tarifa de 1x ao valor enviado, e o comprador a paga.
    repassarTarifa: process.env.MP_REPASSAR_TARIFA === 'sim',
    modoJuros:
      process.env.MP_MODO_JUROS === 'embutido'
        ? 'embutido'
        : process.env.MP_MODO_JUROS === 'comprador'
          ? 'comprador'
          : 'link',
  },
};

module.exports = config;
