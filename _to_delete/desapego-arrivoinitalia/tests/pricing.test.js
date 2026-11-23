'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseReais,
  calcularParcelado,
  payloadPixEstatico,
  crc16,
} = require('../src/pricing');

test('parseReais aceita formatos brasileiros e ponto decimal', () => {
  assert.equal(parseReais('2.500,00'), 250000);
  assert.equal(parseReais('R$ 180'), 18000);
  assert.equal(parseReais('2500.5'), 250050);
  assert.equal(parseReais('1.300'), 130000);
  assert.equal(parseReais('2.500'), 250000);
  assert.equal(parseReais('12.345.678,90'), 1234567890);
  assert.equal(parseReais(''), null);
  assert.equal(parseReais(undefined), null);
  assert.throws(() => parseReais('abc'));
  assert.throws(() => parseReais('1,2,3'));
});

test('crc16 segue o vetor de teste CCITT-FALSE', () => {
  assert.equal(crc16('123456789'), '29B1');
});

test('parcelado repassa o custo ao comprador e o vendedor recebe o valor à vista', () => {
  const preco = 250000;
  const custo = 18.5;
  const r = calcularParcelado(preco, custo, 6);
  assert.equal(r.parcelas, 6);
  assert.equal(r.total, r.valorParcela * 6);
  assert.ok(r.total > preco, 'total parcelado deve ser maior que o à vista');
  // Líquido recebido pelo vendedor após a retenção do Mercado Pago não pode ser menor que o à vista.
  assert.ok(Math.floor(r.total * (1 - custo / 100)) >= preco);
  // Sobretaxa esperada: preço * c / (1 - c), pois o custo incide sobre o total cobrado.
  // Tolerância de alguns centavos pelo arredondamento das parcelas.
  const esperado = (preco * custo) / (100 - custo);
  assert.ok(Math.abs(r.total - preco - esperado) < 12);
});

test('parcelado com custo zero mantém o total próximo do à vista', () => {
  const r = calcularParcelado(131000, 0, 6);
  assert.ok(r.total >= 131000 && r.total - 131000 < 10);
});

test('parcelado falha sem custo configurado', () => {
  assert.throws(() => calcularParcelado(10000, null, 6), /não configurado/);
});

test('payload Pix estático tem valor, chave e CRC válido', () => {
  const payload = payloadPixEstatico({
    chave: 'teste@exemplo.com',
    nomeRecebedor: 'Cleo Garcia',
    cidade: 'Florianópolis',
    valorCents: 51125,
  });
  assert.match(payload, /^000201/);
  // Campo 54 (valor): tamanho 06 para "511.25".
  assert.ok(payload.includes('5406511.25'));
  assert.ok(payload.includes('0014BR.GOV.BCB.PIX'));
  assert.ok(payload.includes('teste@exemplo.com'));
  assert.ok(payload.includes('5303986'));
  // O CRC cobre tudo até o próprio campo "6304".
  const semCrc = payload.slice(0, -4);
  assert.equal(payload.slice(-4), crc16(semCrc));
  assert.ok(semCrc.endsWith('6304'));
});

test('payload Pix remove acentos do nome e da cidade', () => {
  const payload = payloadPixEstatico({
    chave: '+5548984443883',
    nomeRecebedor: 'José Gonçalves',
    cidade: 'Florianópolis',
    valorCents: 100,
  });
  assert.ok(payload.includes('JOSE GONCALVES'));
  assert.ok(payload.includes('FLORIANOPOLIS'));
});

test('payload Pix exige chave configurada', () => {
  assert.throws(() => payloadPixEstatico({ chave: '', nomeRecebedor: 'A', cidade: 'B', valorCents: 1 }));
});
