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

async function iniciarServidor(modoJuros = 'embutido') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desapego-arrivoinitalia-'));
  const config = {
    port: 0,
    publicBaseUrl: 'http://localhost',
    dataDir: dir,
    uploadsDir: path.join(dir, 'uploads'),
    adminPassword: 'senha-teste',
    reservaHoras: 48,
    whatsappNumero: '5548984443883',
    pix: { chave: 'teste@exemplo.com', nomeRecebedor: 'CLEO M GARCIA', cidade: 'FLORIANOPOLIS', titular: 'Cleo Marcus Garcia', banco: 'Banco Inter', cpf: '03292966981' },
    linkCartao: { tarifaPct: 4.98, jurosPct: { 2: 9.64, 3: 11.23, 4: 11.36, 5: 14.31, 6: 15 }, parcelasMax: 6 },
    mercadoPago: { accessToken: 'token-teste', taxasPct: { 1: 4.98, 2: 7.51, 3: 9.6, 4: 11.67, 5: 13.64, 6: 14.94 }, parcelasMax: 6, modoJuros },
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
  const esperado = calcularParcelado(250000, 14.94, 6);
  assert.equal(lista[0].precos.cartao.length, 6, 'opções de 1x a 6x');
  assert.equal(lista[0].precos.cartao[0].parcelas, 1);
  assert.equal(lista[0].precos.cartao[5].totalCents, esperado.total);
  const totais = lista[0].precos.cartao.map((c) => c.totalCents);
  assert.ok(totais.every((t, i) => t > 250000 && (i === 0 || t > totais[i - 1])), 'total cresce com as parcelas');
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
    headers: { Cookie: cookieAna, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parcelas: 9 }),
  });
  assert.equal(r.status, 400, 'parcelas fora de 1 a 6 são recusadas');

  r = await fetch(`${base}/api/produtos/${produto.id}/pagar/cartao`, {
    method: 'POST',
    headers: { Cookie: cookieAna, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parcelas: 6 }),
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

  // Item vendido continua na vitrine (com selo), mas sem poder ser comprado
  r = await fetch(`${base}/api/produtos`);
  const aposVenda = await json(r);
  assert.equal(aposVenda.length, 1);
  assert.equal(aposVenda[0].status, 'vendido');
  r = await fetch(`${base}/api/produtos/${produto.id}`);
  assert.equal(r.status, 200);
  r = await fetch(`${base}/api/produtos/${produto.id}/interesse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'Dani Rocha', telefone: '48966664444' }),
  });
  assert.equal(r.status, 400, 'vendido não aceita novo interesse');
  r = await fetch(`${base}/api/produtos/${produto.id}/pagar/pix`, { method: 'POST', headers: { Cookie: cookieAna } });
  assert.equal(r.status, 400, 'vendido não gera pagamento');

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
    linkCartao: { tarifaPct: 4.98, jurosPct: { 2: 9.64, 3: 11.23, 4: 11.36, 5: 14.31, 6: 15 }, parcelasMax: 6 },
    mercadoPago: { accessToken: '', taxasPct: { 1: 4.98 }, parcelasMax: 6, modoJuros: 'embutido' },
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

test('modo comprador: envia o valor do cartão à vista e deixa o Mercado Pago calcular os juros', async (t) => {
  const s = await iniciarServidor('comprador');
  t.after(() => s.fechar());
  const { base } = s;
  const H = { 'Content-Type': 'application/json' };
  let r = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ senha: 'senha-teste' }) });
  const admin = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  await fetch(`${base}/admin/api/produtos`, {
    method: 'POST', headers: { ...H, Cookie: admin },
    body: JSON.stringify({ nome: 'JBL Xtreme', precoAvista: '520', publicado: true }),
  });
  r = await fetch(`${base}/api/produtos`);
  const [p] = await r.json();
  const esperado = { total: 52000 }; // o preço do Pix, sem acréscimo
  assert.equal(p.precos.cartaoModo, 'comprador');
  assert.equal(p.precos.cartao.length, 1);
  assert.equal(p.precos.cartao[0].totalCents, esperado.total);

  r = await fetch(`${base}/api/produtos/${p.id}/interesse`, { method: 'POST', headers: H, body: JSON.stringify({ nome: 'Ana Souza', telefone: '48999991111' }) });
  const cookie = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  r = await fetch(`${base}/api/produtos/${p.id}/pagar/cartao`, { method: 'POST', headers: { ...H, Cookie: cookie }, body: JSON.stringify({ parcelas: 4 }) });
  assert.equal(r.status, 200, await r.clone().text());
  const pref = s.mp.estado.preferencias[0];
  assert.equal(pref.totalCents, esperado.total, 'valor enviado é o do cartão à vista');
  assert.equal(pref.parcelas, 4, 'parcelas escolhidas vão como padrão');
  assert.equal(pref.parcelasMax, 6, 'checkout permite até 6x');
});

test('modo link: valores do simulador do Mercado Pago, link por produto e venda no cartão', async (t) => {
  const s = await iniciarServidor('link');
  t.after(() => s.fechar());
  const { base } = s;
  const H = { 'Content-Type': 'application/json' };
  let r = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ senha: 'senha-teste' }) });
  const admin = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  r = await fetch(`${base}/admin/api/produtos`, {
    method: 'POST', headers: { ...H, Cookie: admin },
    body: JSON.stringify({ nome: 'JBL Xtreme', precoAvista: '520', publicado: true, linkCartao: 'https://mpago.la/abc123' }),
  });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).linkCartao, undefined, 'o painel não tem mais link de pagamento');
  r = await fetch(`${base}/api/produtos`);
  const [p] = await r.json();
  assert.equal(p.precos.cartaoModo, 'link');
  assert.equal(p.precos.linkCartao, undefined);
  const por = Object.fromEntries(p.precos.cartao.map((c) => [c.parcelas, c]));
  assert.equal(por[1].totalCents, 54725);
  assert.equal(por[2].valorParcelaCents, 30000);
  assert.equal(por[3].valorParcelaCents, 20290);
  assert.equal(por[4].valorParcelaCents, 15235);
  assert.equal(por[5].valorParcelaCents, 12511);
  assert.equal(p.precos.cartao.length, 6);

  r = await fetch(`${base}/api/produtos/${p.id}/interesse`, { method: 'POST', headers: H, body: JSON.stringify({ nome: 'Ana Souza', telefone: '48999991111' }) });
  const cookie = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  r = await fetch(`${base}/api/produtos/${p.id}/pagar/cartao`, { method: 'POST', headers: { ...H, Cookie: cookie }, body: JSON.stringify({ parcelas: 3 }) });
  assert.equal(r.status, 400);
  assert.equal(s.mp.estado.preferencias.length, 0);

  r = await fetch(`${base}/admin/api/produtos/${p.id}/vender`, { method: 'POST', headers: { ...H, Cookie: admin }, body: JSON.stringify({ metodo: 'cartao' }) });
  assert.equal(r.status, 200);
  assert.equal(s.db.prepare('SELECT metodo FROM payments').all()[0].metodo, 'cartao');
});

test('modo link: com reserva ativa, links de WhatsApp para pedir o link ou pagar no local', async (t) => {
  const s = await iniciarServidor('link');
  t.after(() => s.fechar());
  const { base } = s;
  const H = { 'Content-Type': 'application/json' };
  let r = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ senha: 'senha-teste' }) });
  const admin = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  r = await fetch(`${base}/admin/api/produtos`, {
    method: 'POST', headers: { ...H, Cookie: admin },
    body: JSON.stringify({ nome: 'JBL Xtreme', precoAvista: '520', publicado: true }),
  });
  const { id } = await r.json();

  // Sem reserva, nenhum link é exposto.
  r = await fetch(`${base}/api/produtos/${id}/minha-reserva`);
  assert.equal((await r.json()).whatsappCartao, undefined);

  r = await fetch(`${base}/api/produtos/${id}/interesse`, { method: 'POST', headers: H, body: JSON.stringify({ nome: 'Ana Souza', telefone: '48999991111' }) });
  const cookie = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  r = await fetch(`${base}/api/produtos/${id}/minha-reserva`, { headers: { Cookie: cookie } });
  const estado = await r.json();
  assert.equal(estado.status, 'ativa');

  const texto = (link) => {
    const u = new URL(link);
    assert.equal(u.origin + u.pathname, 'https://wa.me/5548984443883');
    return u.searchParams.get('text');
  };
  const avista = 'R$\u00a0547,25'; // cartão à vista (Pix 520 + tarifa 4,98%)
  assert.equal(
    texto(estado.whatsappCartao.solicitarLink).replace(/\s/g, ' '),
    `Olá sou Ana Souza gostaria de receber o link de pagamento para o produto JBL Xtreme com o valor de ${avista}`.replace(/\s/g, ' ')
  );
  assert.equal(
    texto(estado.whatsappCartao.pagamentoNoLocal).replace(/\s/g, ' '),
    `Olá sou Ana Souza e quero adquirir o produto JBL Xtreme com o valor de ${avista} para pagamento com cartão direto a você.`.replace(/\s/g, ' ')
  );
});

test('escolher Pix ou WhatsApp fixa a reserva, bloqueia outros e o Pix traz o aviso do destinatário', async (t) => {
  const s = await iniciarServidor('link');
  t.after(() => s.fechar());
  const { base } = s;
  const H = { 'Content-Type': 'application/json' };
  let r = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ senha: 'senha-teste' }) });
  const admin = cookieDe(r);
  const criar = async (nome) => {
    const resp = await fetch(`${base}/admin/api/produtos`, { method: 'POST', headers: { ...H, Cookie: admin }, body: JSON.stringify({ nome, precoAvista: '520', publicado: true }) });
    return (await resp.json()).id;
  };
  const interesse = async (id, nome) => cookieDe(await fetch(`${base}/api/produtos/${id}/interesse`, { method: 'POST', headers: H, body: JSON.stringify({ nome, telefone: '48999991111' }) }));
  const reservaDe = (id) => s.db.prepare("SELECT * FROM reservations WHERE product_id = ? AND status = 'ativa'").get(id);

  // Pix
  const tv = await criar('Smart TV');
  const ana = await interesse(tv, 'Ana Souza');
  const bruno = await interesse(tv, 'Bruno Lima');
  r = await fetch(`${base}/api/produtos/${tv}/pagar/pix`, { method: 'POST', headers: { ...H, Cookie: ana } });
  assert.equal(r.status, 200);
  const pix = await r.json();
  assert.equal(pix.atencao.destinatario, 'Cleo Marcus Garcia, Banco Inter, CPF 032.929.669-81');
  assert.equal(pix.atencao.comprovanteTelefone, '(48) 984443883');
  assert.match(pix.atencao.comprovanteLink, /^https:\/\/wa\.me\/5548984443883/);
  assert.equal(reservaDe(tv).expira_em, null);
  assert.equal(reservaDe(tv).pagamento_escolhido, 'pix');
  r = await fetch(`${base}/api/produtos/${tv}/pagar/pix`, { method: 'POST', headers: { ...H, Cookie: bruno } });
  assert.equal(r.status, 400, 'quem está na fila não paga');
  r = await fetch(`${base}/api/produtos/${tv}/minha-reserva`, { headers: { Cookie: ana } });
  const estado = await r.json();
  assert.equal(estado.status, 'ativa');
  assert.equal(estado.pagamentoEscolhido, 'pix');

  // Cartão pelo WhatsApp
  const sofa = await criar('Sofa');
  const carla = await interesse(sofa, 'Carla');
  r = await fetch(`${base}/api/produtos/${sofa}/pagar/whatsapp`, { method: 'POST', headers: { ...H, Cookie: carla }, body: JSON.stringify({ opcao: 'invalida' }) });
  assert.equal(r.status, 400);
  r = await fetch(`${base}/api/produtos/${sofa}/pagar/whatsapp`, { method: 'POST', headers: { ...H, Cookie: carla }, body: JSON.stringify({ opcao: 'local' }) });
  assert.equal(r.status, 200);
  assert.equal(reservaDe(sofa).expira_em, null);
  assert.equal(reservaDe(sofa).pagamento_escolhido, 'cartao_local');
  const pg = s.db.prepare('SELECT * FROM payments WHERE reservation_id = ?').get(reservaDe(sofa).id);
  assert.equal(pg.metodo, 'cartao');
  assert.equal(pg.valor_cents, 54725);
  r = await fetch(`${base}/api/produtos/${sofa}/pagar/whatsapp`, { method: 'POST', headers: H, body: JSON.stringify({ opcao: 'link' }) });
  assert.equal(r.status, 400, 'sem reserva não registra');

  // Reabrir libera
  r = await fetch(`${base}/admin/api/produtos/${sofa}/reabrir`, { method: 'POST', headers: { ...H, Cookie: admin } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'disponivel');
  assert.equal(reservaDe(sofa), undefined);
});
