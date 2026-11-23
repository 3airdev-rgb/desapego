'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { criarServico, ErroNegocio } = require('../src/reservations');

function preparar() {
  const db = openDb(':memory:');
  db.prepare(
    'INSERT INTO products (nome, descricao, preco_avista_cents, prazo_entrega, status, publicado, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('Robô aspirador', '', 250000, 'imediata', 'disponivel', 1, new Date().toISOString());
  const servico = criarServico({ db, reservaHoras: 48 });
  const produto = db.prepare('SELECT * FROM products WHERE id = 1').get();
  return { db, servico, produto };
}

const t0 = new Date('2026-11-23T12:00:00Z');
const horas = (h) => new Date(t0.getTime() + h * 3600 * 1000);

test('primeiro interessado recebe reserva ativa de 48h', () => {
  const { servico, produto, db } = preparar();
  const { reserva, posicaoFila } = servico.registrarInteresse({
    productId: produto.id, nome: 'Ana', telefone: '48999991111', agora: t0,
  });
  assert.equal(reserva.status, 'ativa');
  assert.equal(posicaoFila, 0);
  assert.equal(new Date(reserva.expira_em).getTime(), horas(48).getTime());
  assert.equal(db.prepare('SELECT status FROM products WHERE id = 1').get().status, 'reservado');
});

test('segundo interessado entra na fila e não recebe a reserva', () => {
  const { servico, produto } = preparar();
  servico.registrarInteresse({ productId: produto.id, nome: 'Ana', telefone: '48999991111', agora: t0 });
  const { reserva, posicaoFila } = servico.registrarInteresse({
    productId: produto.id, nome: 'Bruno', telefone: '48988882222', agora: t0,
  });
  assert.equal(reserva.status, 'fila');
  assert.equal(reserva.expira_em, null);
  assert.equal(posicaoFila, 1);
});

test('expirada a reserva, o primeiro da fila é promovido e marcado para aviso', () => {
  const { servico, produto, db } = preparar();
  servico.registrarInteresse({ productId: produto.id, nome: 'Ana', telefone: '48999991111', agora: t0 });
  servico.registrarInteresse({ productId: produto.id, nome: 'Bruno', telefone: '48988882222', agora: t0 });
  servico.registrarInteresse({ productId: produto.id, nome: 'Carla', telefone: '48977773333', agora: t0 });

  const antes = servico.expirarVencidas(horas(47));
  assert.equal(antes.length, 0, 'antes de 48h nada expira');

  const promovidas = servico.expirarVencidas(horas(48.1));
  assert.equal(promovidas.length, 1);
  assert.equal(promovidas[0].nome, 'Bruno');
  assert.equal(promovidas[0].status, 'ativa');
  assert.equal(promovidas[0].aviso_pendente, 1);

  const filaRestante = db
    .prepare("SELECT nome FROM reservations WHERE status = 'fila' ORDER BY id")
    .all()
    .map((r) => r.nome);
  assert.deepEqual(filaRestante, ['Carla']);
});

test('cancelar a reserva ativa promove o próximo; cancelar fila não promove', () => {
  const { servico, produto } = preparar();
  const ana = servico.registrarInteresse({ productId: produto.id, nome: 'Ana', telefone: '48999991111', agora: t0 }).reserva;
  const bruno = servico.registrarInteresse({ productId: produto.id, nome: 'Bruno', telefone: '48988882222', agora: t0 }).reserva;
  const carla = servico.registrarInteresse({ productId: produto.id, nome: 'Carla', telefone: '48977773333', agora: t0 }).reserva;

  servico.cancelar(carla.id, t0); // remove da fila, sem promover ninguém
  const promovidas = servico.cancelar(ana.id, t0);
  assert.equal(promovidas.length, 1);
  assert.equal(promovidas[0].id, bruno.id);
});

test('venda convertida encerra a fila e marca o item como vendido', () => {
  const { servico, produto, db } = preparar();
  const ana = servico.registrarInteresse({ productId: produto.id, nome: 'Ana', telefone: '48999991111', agora: t0 }).reserva;
  servico.registrarInteresse({ productId: produto.id, nome: 'Bruno', telefone: '48988882222', agora: t0 });

  servico.converterVenda(ana.id);
  assert.equal(db.prepare('SELECT status FROM products WHERE id = 1').get().status, 'vendido');
  const statusFila = db.prepare("SELECT status FROM reservations WHERE nome = 'Bruno'").get().status;
  assert.equal(statusFila, 'cancelada');
});

test('produto vendido ou não publicado não aceita interesse', () => {
  const { servico, produto, db } = preparar();
  db.prepare("UPDATE products SET status = 'vendido' WHERE id = 1").run();
  assert.throws(
    () => servico.registrarInteresse({ productId: produto.id, nome: 'Ana', telefone: '48999991111', agora: t0 }),
    (erro) => erro instanceof ErroNegocio && erro.codigo === 'vendido'
  );

  db.prepare("UPDATE products SET status = 'disponivel', publicado = 0 WHERE id = 1").run();
  assert.throws(
    () => servico.registrarInteresse({ productId: produto.id, nome: 'Ana', telefone: '48999991111', agora: t0 }),
    (erro) => erro.codigo === 'nao_publicado'
  );
});

test('dados inválidos são recusados', () => {
  const { servico, produto } = preparar();
  assert.throws(() => servico.registrarInteresse({ productId: produto.id, nome: 'A', telefone: '48999991111' }));
  assert.throws(() => servico.registrarInteresse({ productId: produto.id, nome: 'Ana', telefone: '123' }));
});

test('exigirReservaAtiva recusa reserva expirada', () => {
  const { servico, produto } = preparar();
  const ana = servico.registrarInteresse({ productId: produto.id, nome: 'Ana', telefone: '48999991111', agora: t0 }).reserva;
  assert.throws(
    () => servico.exigirReservaAtiva(ana.token, produto.id, horas(49)),
    (erro) => erro.codigo === 'sem_reserva' || erro.codigo === 'reserva_inativa'
  );
});

test('fila cresce na ordem de chegada e a lista mostra ativa primeiro', () => {
  const { servico, produto } = preparar();
  servico.registrarInteresse({ productId: produto.id, nome: 'Ana', telefone: '48999991111', agora: t0 });
  servico.registrarInteresse({ productId: produto.id, nome: 'Bruno', telefone: '48988882222', agora: t0 });
  servico.registrarInteresse({ productId: produto.id, nome: 'Carla', telefone: '48977773333', agora: t0 });
  const nomes = servico.filaDoProduto(produto.id).map((r) => r.nome);
  assert.deepEqual(nomes, ['Ana', 'Bruno', 'Carla']);
});
