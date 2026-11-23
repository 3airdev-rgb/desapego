'use strict';

// Regras de preço. Todos os valores monetários são inteiros em centavos.

/**
 * Converte texto digitado ("2.500,00", "2500", "2500.5", "R$ 180") em centavos.
 * Retorna null para entrada vazia. Lança erro para valor inválido.
 */
function parseReais(texto) {
  if (texto === undefined || texto === null) return null;
  const limpo = String(texto).replace(/R\$/gi, '').replace(/\s/g, '');
  if (limpo === '') return null;
  let normalizado;
  if (limpo.includes(',')) {
    normalizado = limpo.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(limpo)) {
    // Milhar sem vírgula, como "1.300" ou "2.500": separador de milhar.
    normalizado = limpo.replace(/\./g, '');
  } else {
    normalizado = limpo;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(normalizado)) {
    throw new Error(`Valor monetário inválido: ${texto}`);
  }
  return Math.round(Number(normalizado) * 100);
}

function formatBRL(cents) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * Calcula o parcelamento em que todo o custo do Mercado Pago é repassado ao comprador
 * e o vendedor recebe o valor à vista, como se fosse venda à vista.
 *
 * custoPct: percentual retido pelo Mercado Pago sobre o total cobrado do comprador
 * (taxa do parcelamento somada à antecipação). Net recebido = total * (1 - custoPct/100).
 *
 * Retorna { parcelas, valorParcela, total, acrescimo } em centavos.
 */
function calcularParcelado(precoCents, custoPct, parcelas = 6) {
  if (!Number.isInteger(precoCents) || precoCents <= 0) {
    throw new Error('Preço à vista inválido');
  }
  if (custoPct === null || custoPct === undefined || Number.isNaN(custoPct)) {
    throw new Error('Custo do parcelamento não configurado');
  }
  if (custoPct < 0 || custoPct >= 100) {
    throw new Error('Custo do parcelamento fora do intervalo válido');
  }
  const fator = 1 - custoPct / 100;

  // Menor total que, após a retenção, entrega ao vendedor pelo menos o preço à vista.
  let total = Math.ceil(precoCents / fator);
  let valorParcela = Math.ceil(total / parcelas);
  total = valorParcela * parcelas;

  // Garante a propriedade por arredondamento.
  while (Math.floor(total * fator) < precoCents) {
    valorParcela += 1;
    total = valorParcela * parcelas;
  }

  return {
    parcelas,
    valorParcela,
    total,
    acrescimo: total - precoCents,
  };
}

/** Remove acentos e caracteres fora do ASCII, exigidos pelo padrão Pix. */
function limparTextoPix(texto, maximo) {
  return String(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .toUpperCase()
    .slice(0, maximo);
}

function campo(id, valor) {
  const s = String(valor);
  return id + String(s.length).padStart(2, '0') + s;
}

/** CRC-16/CCITT-FALSE, exigido pelo BR Code do Pix. */
function crc16(texto) {
  let crc = 0xffff;
  for (let i = 0; i < texto.length; i += 1) {
    crc ^= texto.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Gera o código "copia e cola" do Pix estático com valor fixo (BR Code).
 * chave: chave Pix cadastrada no banco (CPF, e-mail, telefone +55..., ou aleatória).
 */
function payloadPixEstatico({ chave, nomeRecebedor, cidade, valorCents, txid = '***' }) {
  if (!chave) throw new Error('Chave Pix não configurada');
  const valor = (valorCents / 100).toFixed(2);
  const contaPix = campo('00', 'BR.GOV.BCB.PIX') + campo('01', chave);
  const semCrc =
    campo('00', '01') +
    campo('01', '11') +
    campo('26', contaPix) +
    campo('52', '0000') +
    campo('53', '986') +
    campo('54', valor) +
    campo('58', 'BR') +
    campo('59', limparTextoPix(nomeRecebedor, 25)) +
    campo('60', limparTextoPix(cidade, 15)) +
    campo('62', campo('05', txid)) +
    '6304';
  return semCrc + crc16(semCrc);
}

module.exports = {
  parseReais,
  formatBRL,
  calcularParcelado,
  payloadPixEstatico,
  crc16,
};
