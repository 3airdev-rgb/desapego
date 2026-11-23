'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDb } = require('../src/db');
const { criarApp } = require('../src/app');
const { calcularParcelado, crc16 } = require('../src/pricing');

// PNG 1x1 válido (base64), suficiente para o teste de assinatura de arquivo.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function criarMpFalso() {
  const estado = { preferencias: [], referencia: null };
  return {
    estado,
    async criarPreferencia(args) {
      estado.preferencias.push(args);
      return { id: `pref-${estado.preferencias.length}`, initPoint: 'https://mp.test/checkout/1' };
    },
    async obterPagamento(id) {
      return { id, status: 'approved', external_reference: String(estado.referencia) };
    },
  };
}

async function iniciarServidor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desapego-arrivoinitalia-'));
  const config = {
    port: 0,
    publicBaseUrl: 'http://localhost',
    dataDir: dir,
    uploadsDir: path.join(dir, 'uploads'),
    adminPassword: 'senha-teste',
    reservaHoras: 48,
    whatsappNumero: '5548984443883',
    pix: { chave: 'teste@exemplo.com', nomeRecebedor: 'CLEO M GARCIA', cidade: 'FLORIANOPOLIS' },
    mercadoPago: { accessToken: 'token-teste', custoParceladoPct: 18.5, parcelasMax: 6 },
  };
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const db = openDb(':memory:');
  const mp = criarMpFalso();
  const { app } = criarApp({ config, db, mp });
  const servidor = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  return {
    base,
    mp,
    db,
    fechar: () => new Promise((resolve) => servidor.close(resolve)),
    dir,
  };
}

function cookieDe(resposta) {
  const cookies = resposta.headers.getSetCookie ? resposta.headers.getSetCookie() : [];
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

test('fluxo completo: cadastro, fotos, publicação, reserva, fila, pagamento e venda', async (t) => {
  const s = await iniciarServidor();
  t.after(() => s.fechar());
  const { base } = s;
  const json = (r) => r.json();

  // Painel protegido
  let r = await fetch(`${base}/admin/api/produtos`);
  assert.equal(r.status, 401, 'painel exige sessão');

  r = await fetch(`${base}/admin/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: 'errada' }),
  });
  assert.equal(r.status, 401);

  r = await fetch(`${base}/admin/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: 'senha-teste' }),
  });
  assert.equal(r.status, 200);
  const admin = cookieDe(r);
  assert.ok(admin.includes('admin_sessao='));
  const comAdmin = { Cookie: admin, 'Content-Type': 'application/json' };

  // Cadastro como rascunho
  r = await fetch(`${base}/admin/api/produtos`, {
    method: 'POST',
    headers: comAdmin,
    body: JSON.stringify({
      nome: 'Robô aspirador Xiaomi',
      descricao: 'Usado, funcionando.',
      precoAvista: '2.500,00',
      prazoEntrega: 'imediata',
      publicado: false,
    }),
  });
  assert.equal(r.status, 201);
  const produto = await json(r);
  assert.equal(produto.precoAvistaCents, 250000);
  assert.equal(produto.publicado, false);

  r = await fetch(`${base}/api/produtos`);
  assert.deepEqual(await json(r), [], 'rascunho não aparece para interessados');

  // Fotos (carrossel)
  const png = Buffer.from(PNG_BASE64, 'base64');
  const formulario = new FormData();
  formulario.append('fotos', new Blob([png], { type: 'image/png' }), 'frente.png');
  formulario.append('fotos', new Blob([png], { type: 'image/png' }), 'lado.png');
  r = await fetch(`${base}/admin/api/produtos/${produto.id}/fotos`, {
    method: 'POST',
    headers: { Cookie: admin },
    body: formulario,
  });
  assert.equal(r.status, 201, await r.clone().text());
  let atualizado = await json(r);
  assert.equal(atualizado.fotos.length, 2);

  const falso = new FormData();
  falso.append('fotos', new Blob(['texto qualquer'], { type: 'image/png' }), 'x.png');
  r = await fetch(`${base}/admin/api/produtos/${produto.id}/fotos`, {
    method: 'POST',
    headers: { Cookie: admin },
    body: falso,
  });
  assert.equal(r.status, 400, 'arquivo que não é imagem é recusado');

  // Reordenar carrossel
  const invertida = [...atualizado.fotos].map((f) => f.id).reverse();
  r = await fetch(`${base}/admin/api/produtos/${produto.id}/fotos/ordem`, {
    method: 'PUT',
    headers: comAdmin,
    body: JSON.stringify({ ids: invertida }),
  });
  atualizado = await json(r);
  assert.equal(atualizado.fotos[0].id, invertida[0]);

  // Publicar
  r = await fetch(`${base}/admin/api/produtos/${produto.id}`, {
    method: 'PUT',
    headers: comAdmin,
    body: JSON.stringify({ publicado: true }),
  });
  assert.equal(r.status, 200);

  r = await fetch(`${base}/api/produtos`);
  const lista = await json(r);
  assert.equal(lista.length, 1);
  assert.match(lista[0].precos.avista.texto, /2\.500,00/);
  const esperado = calcularParcelado(250000, 18.5, 6);
  assert.equal(lista[0].precos.cartao.totalCents, esperado.total);
  assert.equal(lista[0].precos.cartao.parcelas, 6);
  assert.equal(lista[0].fotos.length, 2);

  // Interesse: primeiro comprador (Ana) e segundo (Bruno)
  r = await fetch(`${base}/api/produtos/${produto.id}/interesse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'Ana Souza', telefone: '(48) 99999-1111' }),
  });
  assert.equal(r.status, 201);
  const ana = await json(r);
  assert.equal(ana.status, 'ativa');
  const cookieAna = cookieDe(r);
  assert.ok(cookieAna.includes(`reserva_${produto.id}=`));

  r = await fetch(`${base}/api/produtos/${produto.id}/interesse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'Bruno Lima', telefone: '48988882222' }),
  });
  const bruno = await json(r);
  assert.equal(bruno.status, 'fila');
  assert.equal(bruno.posicaoFila, 1);
  const cookieBruno = cookieDe(r);

  r = await fetch(`${base}/api/produtos/${produto.id}/minha-reserva`, { headers: { Cookie: cookieAna } });
  assert.equal((await json(r)).status, 'ativa');

  // Pagamento Pix: código copia e cola com o valor
  r = await fetch(`${base}/api/produtos/${produto.id}/pagar/pix`, {
    method: 'POST',
    headers: { Cookie: cookieAna },
  });
  assert.equal(r.status, 200);
  const pix = await json(r);
  assert.ok(pix.copiaECola.includes('54072500.00'), 'valor à vista no Pix');
  assert.match(pix.qrSvg, /^<svg/, 'QR code em SVG');
  assert.equal(pix.copiaECola.slice(-4), crc16(pix.copiaECola.slice(0, -4)), 'CRC do Pix confere');

  // Quem está na fila não paga
  r = await fetch(`${base}/api/produtos/${produto.id}/pagar/pix`, {
    method: 'POST',
    headers: { Cookie: cookieBruno },
  });
  assert.equal(r.status, 400);

  // Cartão parcelado: preferência com total acrescido do custo, em 6x
  r = await fetch(`${base}/api/produtos/${produto.id}/pagar/cartao`, {
    method: 'POST',
    headers: { Cookie: cookieAna },
  });
  assert.equal(r.status, 200, await r.clone().text());
  const cartao = await json(r);
  assert.equal(cartao.initPoint, 'https://mp.test/checkout/1');
  const preferencia = s.mp.estado.preferencias[0];
  assert.equal(preferencia.totalCents, esperado.total);
  assert.equal(preferencia.parcelas, 6);
  const idAna = s.db.prepare("SELECT id FROM reservations WHERE nome = 'Ana Souza'").get().id;
  assert.equal(preferencia.referenciaExterna, String(idAna));
  s.mp.estado.referencia = idAna;

  // Confirmação do Mercado Pago (webhook) converte a venda
  r = await fetch(`${base}/webhooks/mercadopago?type=payment&data.id=987654`, { method: 'POST' });
  assert.equal(r.status, 200);

  const statusProduto = s.db.prepare('SELECT status FROM products WHERE id = ?').get(produto.id).status;
  assert.equal(statusProduto, 'vendido');

  // Repetir a notificação não duplica a venda
  r = await fetch(`${base}/webhooks/mercadopago?type=payment&data.id=987654`, { method: 'POST' });
  assert.equal(r.status, 200);

  // Item vendido sai da vitrine
  r = await fetch(`${base}/api/produtos`);
  assert.deepEqual(await json(r), []);

  // Configuração pública reflete o que está ativo
  r = await fetch(`${base}/api/config`);
  const cfg = await json(r);
  assert.equal(cfg.cartaoDisponivel, true);
  assert.equal(cfg.pixDisponivel, true);

  // Página do painel e vitrine servidas
  r = await fetch(`${base}/admin`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /DESAPEGO/);
});

test('cartão indisponível sem custo configurado', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desapego-arrivoinitalia-'));
  const config = {
    port: 0,
    publicBaseUrl: 'http://localhost',
    dataDir: dir,
    uploadsDir: path.join(dir, 'uploads'),
    adminPassword: 'senha-teste',
    reservaHoras: 48,
    whatsappNumero: '5548984443883',
    pix: { chave: '', nomeRecebedor: 'X', cidade: 'Y' },
    mercadoPago: { accessToken: '', custoParceladoPct: null, parcelasMax: 6 },
  };
  const db = openDb(':memory:');
  const { app } = criarApp({ config, db, mp: null });
  const servidor = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;

  const r = await fetch(`${base}/api/config`);
  const cfg = await r.json();
  assert.equal(cfg.cartaoDisponivel, false);
  assert.equal(cfg.pixDisponivel, false);
});
