'use strict';

// Regras de reserva: interesse, fila de espera, expiração e promoção do próximo interessado.

const crypto = require('crypto');

class ErroNegocio extends Error {
  constructor(mensagem, codigo = 'erro') {
    super(mensagem);
    this.codigo = codigo;
  }
}

function agoraIso(agora = new Date()) {
  return agora.toISOString();
}

function somarHoras(data, horas) {
  return new Date(data.getTime() + horas * 3600 * 1000);
}

function criarServico({ db, reservaHoras }) {
  const sel = {
    produto: db.prepare('SELECT * FROM products WHERE id = ?'),
    reservaPorToken: db.prepare('SELECT * FROM reservations WHERE token = ?'),
    reservaPorId: db.prepare('SELECT * FROM reservations WHERE id = ?'),
    ativaDoProduto: db.prepare(
      "SELECT * FROM reservations WHERE product_id = ? AND status = 'ativa' LIMIT 1"
    ),
    proximaFila: db.prepare(
      "SELECT * FROM reservations WHERE product_id = ? AND status = 'fila' ORDER BY id ASC LIMIT 1"
    ),
    tamanhoFila: db.prepare(
      "SELECT COUNT(*) AS n FROM reservations WHERE product_id = ? AND status = 'fila'"
    ),
    ativasVencidas: db.prepare(
      "SELECT * FROM reservations WHERE status = 'ativa' AND expira_em <= ?"
    ),
  };

  const upd = {
    reservaStatus: db.prepare('UPDATE reservations SET status = ? WHERE id = ?'),
    reservaAtivar: db.prepare(
      "UPDATE reservations SET status = 'ativa', expira_em = ?, aviso_pendente = 1 WHERE id = ?"
    ),
    reservaAvisoOk: db.prepare('UPDATE reservations SET aviso_pendente = 0 WHERE id = ?'),
    reservaNova: db.prepare(
      'INSERT INTO reservations (product_id, token, nome, telefone, status, criada_em, expira_em) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ),
    produtoStatus: db.prepare('UPDATE products SET status = ? WHERE id = ?'),
    filaCancelar: db.prepare(
      "UPDATE reservations SET status = 'cancelada' WHERE product_id = ? AND status = 'fila'"
    ),
  };

  /**
   * Expira reservas vencidas e promove o próximo da fila de cada produto afetado.
   * Retorna a lista de reservas promovidas (para o painel exibir o aviso ao próximo).
   */
  function expirarVencidas(agora = new Date()) {
    const promovidas = [];
    const vencidas = sel.ativasVencidas.all(agoraIso(agora));
    for (const reserva of vencidas) {
      upd.reservaStatus.run('expirada', reserva.id);
      promovidas.push(...promoverProximo(reserva.product_id, agora));
    }
    return promovidas;
  }

  /** Promove o primeiro da fila a reserva ativa, se o produto não tiver reserva ativa. */
  function promoverProximo(productId, agora = new Date()) {
    const produto = sel.produto.get(productId);
    if (!produto || produto.status === 'vendido') return [];
    if (sel.ativaDoProduto.get(productId)) return [];

    const proxima = sel.proximaFila.get(productId);
    if (!proxima) {
      upd.produtoStatus.run('disponivel', productId);
      return [];
    }
    upd.reservaAtivar.run(agoraIso(somarHoras(agora, reservaHoras)), proxima.id);
    upd.produtoStatus.run('reservado', productId);
    return [sel.reservaPorId.get(proxima.id)];
  }

  /**
   * Registra interesse de um comprador. Se o produto estiver livre, a reserva fica ativa por 48h.
   * Caso contrário, entra na fila de espera.
   */
  function registrarInteresse({ productId, nome, telefone, agora = new Date() }) {
    expirarVencidas(agora);
    const produto = sel.produto.get(productId);
    if (!produto || produto.publicado !== 1) {
      throw new ErroNegocio('Produto não disponível', 'nao_publicado');
    }
    if (produto.status === 'vendido') {
      throw new ErroNegocio('Este item já foi vendido', 'vendido');
    }
    const nomeLimpo = String(nome || '').trim();
    const telLimpo = String(telefone || '').replace(/\D/g, '');
    if (nomeLimpo.length < 2) throw new ErroNegocio('Informe seu nome', 'dados');
    if (telLimpo.length < 10) throw new ErroNegocio('Informe um telefone com DDD', 'dados');

    const token = crypto.randomBytes(24).toString('hex');
    const ativa = sel.ativaDoProduto.get(productId);
    const agoraTxt = agoraIso(agora);

    if (!ativa) {
      const expira = agoraIso(somarHoras(agora, reservaHoras));
      upd.reservaNova.run(productId, token, nomeLimpo, telLimpo, 'ativa', agoraTxt, expira);
      upd.produtoStatus.run('reservado', productId);
    } else {
      upd.reservaNova.run(productId, token, nomeLimpo, telLimpo, 'fila', agoraTxt, null);
    }
    const criada = sel.reservaPorToken.get(token);
    return { reserva: criada, posicaoFila: ativa ? sel.tamanhoFila.get(productId).n : 0 };
  }

  function obterPorToken(token, agora = new Date()) {
    expirarVencidas(agora);
    if (!token) return null;
    return sel.reservaPorToken.get(token) || null;
  }

  /** Reserva válida para compra: ativa e dentro do prazo. */
  function exigirReservaAtiva(token, productId, agora = new Date()) {
    const reserva = obterPorToken(token, agora);
    if (!reserva || reserva.product_id !== productId) {
      throw new ErroNegocio('Reserva não encontrada para este item', 'sem_reserva');
    }
    if (reserva.status !== 'ativa') {
      throw new ErroNegocio('Sua reserva não está mais ativa. Verifique a fila ou entre em contato.', 'reserva_inativa');
    }
    return reserva;
  }

  /** Cancela uma reserva (pelo comprador ou pelo administrador). */
  function cancelar(reservaId, agora = new Date()) {
    const reserva = sel.reservaPorId.get(reservaId);
    if (!reserva) throw new ErroNegocio('Reserva inexistente', 'nao_encontrada');
    if (reserva.status === 'ativa') {
      upd.reservaStatus.run('cancelada', reservaId);
      return promoverProximo(reserva.product_id, agora);
    }
    if (reserva.status === 'fila') {
      upd.reservaStatus.run('cancelada', reservaId);
    }
    return [];
  }

  /** Marca a venda: a reserva ativa vira convertida, o item vira vendido e a fila é encerrada. */
  function converterVenda(reservaId) {
    const reserva = sel.reservaPorId.get(reservaId);
    if (!reserva) throw new ErroNegocio('Reserva inexistente', 'nao_encontrada');
    upd.reservaStatus.run('convertida', reservaId);
    upd.produtoStatus.run('vendido', reserva.product_id);
    upd.filaCancelar.run(reserva.product_id);
  }

  /** Liberação manual de um item vendido (volta a disponível). */
  function reabrirProduto(productId) {
    upd.produtoStatus.run('disponivel', productId);
    return promoverProximo(productId);
  }

  function marcarAvisoEnviado(reservaId) {
    upd.reservaAvisoOk.run(reservaId);
  }

  function filaDoProduto(productId) {
    return db
      .prepare(
        "SELECT * FROM reservations WHERE product_id = ? AND status IN ('ativa', 'fila') ORDER BY CASE status WHEN 'ativa' THEN 0 ELSE 1 END, id ASC"
      )
      .all(productId);
  }

  return {
    expirarVencidas,
    registrarInteresse,
    obterPorToken,
    exigirReservaAtiva,
    cancelar,
    converterVenda,
    reabrirProduto,
    marcarAvisoEnviado,
    filaDoProduto,
    ErroNegocio,
  };
}

module.exports = { criarServico, ErroNegocio };
