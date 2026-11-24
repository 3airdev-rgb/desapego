'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const crypto = require('crypto');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const { criarServico, ErroNegocio } = require('./reservations');
const { parseReais, calcularParcelado, payloadPixEstatico, formatBRL } = require('./pricing');

const STATUS_PRODUTO = ['disponivel', 'reservado', 'vendido'];
const TIPOS_IMAGEM = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FOTOS = 12;
const MAX_BYTES_FOTO = 8 * 1024 * 1024;

function assinarSessaoAdmin(senha) {
  return crypto.createHmac('sha256', senha).update('sessao-admin-desapego-arrivoinitalia').digest('hex');
}

function iguais(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function ehImagemValida(buffer, mime) {
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer.slice(0, 4).toString('hex') === '89504e47';
  if (mime === 'image/webp') {
    return buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

function extensaoPorMime(mime) {
  return { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[mime];
}

function linkWhatsApp(numero, texto) {
  return `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
}

function telefoneInternacional(telefone) {
  const digitos = String(telefone).replace(/\D/g, '');
  return digitos.length <= 11 ? `55${digitos}` : digitos;
}

function criarApp({ config, db, mp = null, agora = () => new Date() }) {
  const servico = criarServico({ db, reservaHoras: config.reservaHoras });
  const app = express();
  const seguro = config.publicBaseUrl.startsWith('https://');
  const cookieOpcoes = (maxAgeMs) => ({
    httpOnly: true,
    sameSite: 'lax',
    secure: seguro,
    maxAge: maxAgeMs,
    path: '/',
  });

  app.disable('x-powered-by');
  // Atrás do Nginx: confia apenas no primeiro proxy para obter o IP real do cliente.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());

  // Webhook do Mercado Pago recebe corpo JSON; a rota é tratada no bloco abaixo.

  // ---------- Consultas e helpers ----------

  const sel = {
    produtos: db.prepare('SELECT * FROM products ORDER BY id DESC'),
    produto: db.prepare('SELECT * FROM products WHERE id = ?'),
    produtoPublicado: db.prepare(
      "SELECT * FROM products WHERE id = ? AND publicado = 1"
    ),
    produtosPublicados: db.prepare(
      "SELECT * FROM products WHERE publicado = 1 ORDER BY (status = 'vendido') ASC, id DESC"
    ),
    fotos: db.prepare('SELECT * FROM photos WHERE product_id = ? ORDER BY ordem ASC, id ASC'),
    foto: db.prepare('SELECT * FROM photos WHERE id = ?'),
    contagemFotos: db.prepare('SELECT COUNT(*) AS n FROM photos WHERE product_id = ?'),
    reservaAtivaProduto: db.prepare(
      "SELECT * FROM reservations WHERE product_id = ? AND status = 'ativa' LIMIT 1"
    ),
    filaTamanho: db.prepare(
      "SELECT COUNT(*) AS n FROM reservations WHERE product_id = ? AND status = 'fila'"
    ),
    reserva: db.prepare('SELECT * FROM reservations WHERE id = ?'),
    ultimoPagamentoPendente: db.prepare(
      "SELECT * FROM payments WHERE reservation_id = ? AND metodo = ? AND status = 'pendente' ORDER BY id DESC LIMIT 1"
    ),
    pagamentoPorMpId: db.prepare('SELECT * FROM payments WHERE mp_payment_id = ?'),
  };

  const ins = {
    produto: db.prepare(
      'INSERT INTO products (nome, descricao, preco_avista_cents, prazo_entrega, status, publicado, criado_em, link_cartao) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ),
    foto: db.prepare('INSERT INTO photos (product_id, arquivo, ordem) VALUES (?, ?, ?)'),
    pagamento: db.prepare(
      'INSERT INTO payments (reservation_id, metodo, valor_cents, parcelas, status, mp_preference_id, mp_payment_id, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ),
    pagamentoAprovadoManual: db.prepare(
      "INSERT INTO payments (reservation_id, metodo, valor_cents, parcelas, status, criado_em) VALUES (?, ?, ?, 1, 'aprovado', ?)"
    ),
  };

  function fotosPublicas(produtoId) {
    return sel.fotos.all(produtoId).map((f) => ({
      id: f.id,
      url: `/uploads/${f.arquivo}`,
    }));
  }

  // Modo comprador: valor enviado ao Mercado Pago (o resto é calculado por ele).
  function valorEnviadoNoModoComprador(avista) {
    const pct1 = config.mercadoPago.taxasPct[1];
    if (config.mercadoPago.repassarTarifa && pct1 !== undefined) {
      return calcularParcelado(avista, pct1, 1).total;
    }
    return avista;
  }

  function opcoesDePreco(produto) {
    const avista = produto.preco_avista_cents;
    const opcoesCartao = [];
    const modoJuros = config.mercadoPago.modoJuros;
    let cartaoLinkTarifaTexto = null;
    if (avista && modoJuros === 'link') {
      const l = config.linkCartao;
      const aVista = Math.round(avista / (1 - l.tarifaPct / 100));
      cartaoLinkTarifaTexto = `${String(l.tarifaPct).replace('.', ',')}%`;
      opcoesCartao.push({
        parcelas: 1,
        valorParcelaCents: aVista,
        valorParcelaTexto: formatBRL(aVista),
        totalCents: aVista,
        totalTexto: formatBRL(aVista),
        acrescimoCents: aVista - avista,
        jurosPct: null,
      });
      for (let n = 2; n <= l.parcelasMax; n += 1) {
        const pct = l.jurosPct[n];
        if (pct === undefined) continue;
        const parcela = Math.round((aVista * (1 + pct / 100)) / n);
        const total = parcela * n;
        opcoesCartao.push({
          parcelas: n,
          valorParcelaCents: parcela,
          valorParcelaTexto: formatBRL(parcela),
          totalCents: total,
          totalTexto: formatBRL(total),
          acrescimoCents: total - avista,
          jurosPct: pct,
        });
      }
    } else if (avista && modoJuros === 'comprador') {
      const valorEnviado = valorEnviadoNoModoComprador(avista);
      opcoesCartao.push({
        parcelas: 1,
        valorParcelaCents: valorEnviado,
        valorParcelaTexto: formatBRL(valorEnviado),
        totalCents: valorEnviado,
        totalTexto: formatBRL(valorEnviado),
        acrescimoCents: valorEnviado - avista,
      });
    } else if (avista) {
      for (let n = 1; n <= config.mercadoPago.parcelasMax; n += 1) {
        const pct = config.mercadoPago.taxasPct[n];
        if (pct === undefined) continue;
        const c = calcularParcelado(avista, pct, n);
        opcoesCartao.push({
          parcelas: n,
          valorParcelaCents: c.valorParcela,
          valorParcelaTexto: formatBRL(c.valorParcela),
          totalCents: c.total,
          totalTexto: formatBRL(c.total),
          acrescimoCents: c.acrescimo,
        });
      }
    }
    return {
      avista: avista ? { valorCents: avista, texto: formatBRL(avista) } : null,
      cartao: opcoesCartao.length ? opcoesCartao : null,
      cartaoModo: modoJuros,
      cartaoLinkTarifa: cartaoLinkTarifaTexto,
      linkCartao: produto.link_cartao || null,
      cartaoParcelasMax: config.mercadoPago.parcelasMax,
      pix: Boolean(config.pix.chave),
    };
  }

  function produtoPublico(produto) {
    const ativa = sel.reservaAtivaProduto.get(produto.id);
    return {
      id: produto.id,
      nome: produto.nome,
      descricao: produto.descricao,
      prazoEntrega: produto.prazo_entrega,
      status: produto.status,
      fotos: fotosPublicas(produto.id),
      filaTamanho: sel.filaTamanho.get(produto.id).n,
      reservaExpiraEm: ativa ? ativa.expira_em : null,
      precos: opcoesDePreco(produto),
      whatsappDuvidas: linkWhatsApp(
        config.whatsappNumero,
        `Olá! Tenho uma dúvida sobre o item "${produto.nome}" da lista DESAPEGO.`
      ),
    };
  }

  function produtoAdmin(produto) {
    return {
      id: produto.id,
      nome: produto.nome,
      descricao: produto.descricao,
      precoAvistaCents: produto.preco_avista_cents,
      precoAvistaTexto: produto.preco_avista_cents ? formatBRL(produto.preco_avista_cents) : '',
      prazoEntrega: produto.prazo_entrega,
      linkCartao: produto.link_cartao || '',
      status: produto.status,
      publicado: produto.publicado === 1,
      fotos: fotosPublicas(produto.id),
      filaTamanho: sel.filaTamanho.get(produto.id).n,
    };
  }

  function cookieReserva(produtoId) {
    return `reserva_${produtoId}`;
  }

  function reservaDoCookie(req, produtoId) {
    const token = req.cookies[cookieReserva(produtoId)];
    return servico.obterPorToken(token, agora());
  }

  // ---------- Erros ----------

  function tratarErro(erro, res) {
    if (erro instanceof ErroNegocio) {
      return res.status(400).json({ erro: erro.message, codigo: erro.codigo });
    }
    if (erro.message && erro.message.includes('Mercado Pago')) {
      console.error('[Mercado Pago]', erro.message);
      return res.status(502).json({ erro: 'Pagamento com cartão indisponível no momento.' });
    }
    console.error(erro);
    return res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  }

  function envolver(fn) {
    return (req, res) => {
      Promise.resolve()
        .then(() => fn(req, res))
        .catch((erro) => tratarErro(erro, res));
    };
  }

  // ---------- Arquivos estáticos e páginas ----------

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/uploads', express.static(config.uploadsDir, { maxAge: '7d', index: false }));

  // ---------- API pública ----------

  app.get('/api/produtos', (req, res) => {
    servico.expirarVencidas(agora());
    res.json(sel.produtosPublicados.all().map((p) => produtoPublico(p)));
  });

  app.get('/api/produtos/:id', (req, res) => {
    servico.expirarVencidas(agora());
    const produto = sel.produtoPublicado.get(Number(req.params.id));
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    return res.json(produtoPublico(produto));
  });

  app.post(
    '/api/produtos/:id/interesse',
    envolver((req, res) => {
      const produtoId = Number(req.params.id);
      const { reserva, posicaoFila } = servico.registrarInteresse({
        productId: produtoId,
        nome: req.body.nome,
        telefone: req.body.telefone,
        agora: agora(),
      });
      res.cookie(cookieReserva(produtoId), reserva.token, cookieOpcoes(config.reservaHoras * 3600 * 1000));
      res.status(201).json({
        status: reserva.status,
        posicaoFila,
        expiraEm: reserva.expira_em,
      });
    })
  );

  // Cartão sem link cadastrado: o comprador fala com o vendedor pelo WhatsApp, com o nome do
  // cadastro da reserva e o valor do cartão à vista já preenchidos na mensagem.
  function linksWhatsAppCartao(produto, reserva) {
    const cartao = opcoesDePreco(produto).cartao;
    if (!cartao) return null;
    const valor = cartao[0].totalTexto;
    return {
      solicitarLink: linkWhatsApp(
        config.whatsappNumero,
        `Olá sou ${reserva.nome} gostaria de receber o link de pagamento para o produto ${produto.nome} com o valor de ${valor}`
      ),
      pagamentoNoLocal: linkWhatsApp(
        config.whatsappNumero,
        `Olá sou ${reserva.nome} e quero adquirir o produto ${produto.nome} com o valor de ${valor} para pagamento com cartão direto a você.`
      ),
    };
  }

  app.get('/api/produtos/:id/minha-reserva', (req, res) => {
    const produtoId = Number(req.params.id);
    const reserva = reservaDoCookie(req, produtoId);
    if (!reserva || reserva.product_id !== produtoId) return res.json({ status: null });
    const resposta = { status: reserva.status, expiraEm: reserva.expira_em };
    const produto = sel.produtoPublicado.get(produtoId);
    if (reserva.status === 'ativa' && produto && config.mercadoPago.modoJuros === 'link') {
      const links = linksWhatsAppCartao(produto, reserva);
      if (links) resposta.whatsappCartao = links;
    }
    return res.json(resposta);
  });

  app.post(
    '/api/produtos/:id/pagar/pix',
    envolver(async (req, res) => {
      const produtoId = Number(req.params.id);
      const produto = sel.produtoPublicado.get(produtoId);
      if (!produto) throw new ErroNegocio('Produto não disponível', 'nao_publicado');
      if (!produto.preco_avista_cents) throw new ErroNegocio('Preço ainda não definido', 'sem_preco');
      if (!config.pix.chave) throw new ErroNegocio('Pix não configurado', 'pix_indisponivel');

      const reserva = servico.exigirReservaAtiva(req.cookies[cookieReserva(produtoId)], produtoId, agora());
      const valor = produto.preco_avista_cents;
      const copiaECola = payloadPixEstatico({
        chave: config.pix.chave,
        nomeRecebedor: config.pix.nomeRecebedor,
        cidade: config.pix.cidade,
        valorCents: valor,
      });
      ins.pagamento.run(reserva.id, 'pix', valor, 1, 'pendente', null, null, agora().toISOString());
      const qrSvg = await QRCode.toString(copiaECola, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.json({
        valorTexto: formatBRL(valor),
        copiaECola,
        qrSvg,
        instrucao:
          'Pague pelo copia e cola no app do seu banco. Após o pagamento, o vendedor confirma o recebimento e sua compra é registrada.',
      });
    })
  );

  app.post(
    '/api/produtos/:id/pagar/cartao',
    envolver(async (req, res) => {
      const produtoId = Number(req.params.id);
      const produto = sel.produtoPublicado.get(produtoId);
      if (!produto) throw new ErroNegocio('Produto não disponível', 'nao_publicado');
      if (!produto.preco_avista_cents) throw new ErroNegocio('Preço ainda não definido', 'sem_preco');
      if (config.mercadoPago.modoJuros === 'link') {
        throw new ErroNegocio('O pagamento no cartão é feito pelo link do Mercado Pago do produto.', 'cartao_link');
      }
      if (!mp) {
        throw new ErroNegocio('Pagamento no cartão ainda não está disponível. Use o Pix ou fale com o vendedor.', 'cartao_indisponivel');
      }
      const parcelas = Number(req.body.parcelas);
      const modoComprador = config.mercadoPago.modoJuros === 'comprador';
      const pct = config.mercadoPago.taxasPct[modoComprador ? 1 : parcelas];
      if (
        !Number.isInteger(parcelas) ||
        parcelas < 1 ||
        parcelas > config.mercadoPago.parcelasMax ||
        (!modoComprador && pct === undefined)
      ) {
        throw new ErroNegocio('Escolha o número de parcelas (1 a 6)', 'parcelas');
      }

      const reserva = servico.exigirReservaAtiva(req.cookies[cookieReserva(produtoId)], produtoId, agora());
      const calculo = modoComprador
        ? { total: valorEnviadoNoModoComprador(produto.preco_avista_cents) }
        : calcularParcelado(produto.preco_avista_cents, pct, parcelas);
      const baseSegura = /^https:\/\/(?!localhost|127\.|\[::1\])/i.test(config.publicBaseUrl);
      const preferencia = await mp.criarPreferencia({
        titulo: produto.nome,
        totalCents: calculo.total,
        parcelas,
        parcelasMax: modoComprador ? config.mercadoPago.parcelasMax : parcelas,
        referenciaExterna: String(reserva.id),
        urlRetorno: baseSegura ? `${config.publicBaseUrl}/retorno.html` : null,
        urlNotificacao: baseSegura ? `${config.publicBaseUrl}/webhooks/mercadopago` : null,
      });
      ins.pagamento.run(
        reserva.id,
        'cartao',
        calculo.total,
        parcelas,
        'pendente',
        preferencia.id,
        null,
        agora().toISOString()
      );
      res.json({ initPoint: preferencia.initPoint, totalTexto: formatBRL(calculo.total) });
    })
  );

  // Webhook: o Mercado Pago informa a alteração de um pagamento; consultamos o status na API.
  app.post(
    '/webhooks/mercadopago',
    envolver(async (req, res) => {
      const tipo = req.query.type || req.body.type || req.body.topic;
      const id = req.query['data.id'] || (req.body.data && req.body.data.id) || req.query.id;
      if (tipo !== 'payment' || !id) return res.sendStatus(200);
      if (!mp) return res.sendStatus(200);

      const pagamento = await mp.obterPagamento(id);
      if (pagamento.status !== 'approved') return res.sendStatus(200);

      const referencia = Number(pagamento.external_reference);
      const reserva = sel.reserva.get(referencia);
      if (!reserva) return res.sendStatus(200);

      const jaRegistrado = sel.pagamentoPorMpId.get(String(id));
      if (jaRegistrado || reserva.status === 'convertida') return res.sendStatus(200);

      const pendente = sel.ultimoPagamentoPendente.get(reserva.id, 'cartao');
      if (pendente) {
        db.prepare("UPDATE payments SET status = 'aprovado', mp_payment_id = ? WHERE id = ?").run(
          String(id),
          pendente.id
        );
      }
      servico.converterVenda(reserva.id);
      return res.sendStatus(200);
    })
  );

  app.get('/api/config', (req, res) => {
    res.json({
      whatsappNumero: config.whatsappNumero,
      reservaHoras: config.reservaHoras,
      cartaoDisponivel: Boolean(mp),
      pixDisponivel: Boolean(config.pix.chave),
    });
  });

  // ---------- Painel administrativo ----------

  const tentativasLogin = new Map();
  const JANELA_MS = 15 * 60 * 1000;
  const MAX_TENTATIVAS = 10;

  function limiteLogin(req, res, next) {
    const agoraMs = Date.now();
    const registro = tentativasLogin.get(req.ip) || { n: 0, inicio: agoraMs };
    if (agoraMs - registro.inicio > JANELA_MS) {
      registro.n = 0;
      registro.inicio = agoraMs;
    }
    registro.n += 1;
    tentativasLogin.set(req.ip, registro);
    if (registro.n > MAX_TENTATIVAS) {
      return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos.' });
    }
    return next();
  }

  function exigirAdmin(req, res, next) {
    if (!config.adminPassword) return res.status(503).json({ erro: 'ADMIN_PASSWORD não configurada' });
    const sessao = req.cookies.admin_sessao;
    if (!sessao || !iguais(sessao, assinarSessaoAdmin(config.adminPassword))) {
      return res.status(401).json({ erro: 'Não autenticado' });
    }
    return next();
  }

  app.post('/admin/api/login', limiteLogin, (req, res) => {
    if (!config.adminPassword) return res.status(503).json({ erro: 'ADMIN_PASSWORD não configurada' });
    if (!iguais(req.body.senha || '', config.adminPassword)) {
      return res.status(401).json({ erro: 'Senha incorreta' });
    }
    res.cookie('admin_sessao', assinarSessaoAdmin(config.adminPassword), cookieOpcoes(12 * 3600 * 1000));
    return res.json({ ok: true });
  });

  app.post('/admin/api/logout', (req, res) => {
    res.clearCookie('admin_sessao', { path: '/' });
    res.json({ ok: true });
  });

  app.use('/admin/api', (req, res, next) => {
    if (req.path === '/login' || req.path === '/logout') return next();
    return exigirAdmin(req, res, next);
  });

  app.get('/admin/api/produtos', (req, res) => {
    servico.expirarVencidas(agora());
    res.json(sel.produtos.all().map(produtoAdmin));
  });

  function lerCamposProduto(body, existente) {
    const nome = String(body.nome ?? existente?.nome ?? '').trim();
    if (nome.length < 2) throw new ErroNegocio('Informe o nome do produto', 'dados');
    let preco = existente?.preco_avista_cents ?? null;
    if (body.precoAvista !== undefined) {
      try {
        preco = parseReais(body.precoAvista);
      } catch (erro) {
        throw new ErroNegocio('Preço à vista inválido. Use, por exemplo, 2.500,00', 'dados');
      }
    }
    const linkCartao = String(body.linkCartao ?? existente?.link_cartao ?? '').trim();
    if (linkCartao) {
      let u;
      try {
        u = new URL(linkCartao);
      } catch (erro) {
        u = null;
      }
      if (!u || u.protocol !== 'https:') {
        throw new ErroNegocio('O link do cartão deve começar com https:// (link de pagamento do Mercado Pago)', 'dados');
      }
    }
    return {
      nome,
      linkCartao,
      descricao: String(body.descricao ?? existente?.descricao ?? '').trim(),
      precoAvista: preco,
      prazoEntrega: String(body.prazoEntrega ?? existente?.prazo_entrega ?? '').trim(),
      publicado: body.publicado !== undefined ? (body.publicado ? 1 : 0) : existente?.publicado ?? 0,
    };
  }

  app.post(
    '/admin/api/produtos',
    envolver((req, res) => {
      const campos = lerCamposProduto(req.body);
      const info = ins.produto.run(
        campos.nome,
        campos.descricao,
        campos.precoAvista,
        campos.prazoEntrega,
        'disponivel',
        campos.publicado,
        agora().toISOString(),
        campos.linkCartao
      );
      res.status(201).json(produtoAdmin(sel.produto.get(Number(info.lastInsertRowid))));
    })
  );

  app.put(
    '/admin/api/produtos/:id',
    envolver((req, res) => {
      const existente = sel.produto.get(Number(req.params.id));
      if (!existente) return res.status(404).json({ erro: 'Produto não encontrado' });
      const campos = lerCamposProduto(req.body, existente);
      db.prepare(
        'UPDATE products SET nome = ?, descricao = ?, preco_avista_cents = ?, prazo_entrega = ?, publicado = ?, link_cartao = ? WHERE id = ?'
      ).run(
        campos.nome,
        campos.descricao,
        campos.precoAvista,
        campos.prazoEntrega,
        campos.publicado,
        campos.linkCartao,
        existente.id
      );
      return res.json(produtoAdmin(sel.produto.get(existente.id)));
    })
  );

  app.post(
    '/admin/api/produtos/:id/reabrir',
    envolver((req, res) => {
      const produto = sel.produto.get(Number(req.params.id));
      if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
      servico.reabrirProduto(produto.id);
      return res.json(produtoAdmin(sel.produto.get(produto.id)));
    })
  );

  app.post(
    '/admin/api/produtos/:id/vender',
    envolver((req, res) => {
      const produto = sel.produto.get(Number(req.params.id));
      if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
      const ativa = sel.reservaAtivaProduto.get(produto.id);
      if (!ativa) throw new ErroNegocio('Não há reserva ativa para registrar a venda', 'sem_reserva');
      const metodo = req.body && req.body.metodo === 'cartao' ? 'cartao' : 'pix';
      ins.pagamentoAprovadoManual.run(ativa.id, metodo, produto.preco_avista_cents, agora().toISOString());
      servico.converterVenda(ativa.id);
      return res.json(produtoAdmin(sel.produto.get(produto.id)));
    })
  );

  // Fotos (carrossel do produto)
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES_FOTO, files: MAX_FOTOS },
    fileFilter: (req, file, cb) => {
      if (!TIPOS_IMAGEM.includes(file.mimetype)) {
        return cb(new ErroNegocio('Envie apenas imagens JPEG, PNG ou WEBP', 'arquivo'));
      }
      return cb(null, true);
    },
  });

  app.post('/admin/api/produtos/:id/fotos', (req, res) => {
    upload.array('fotos', MAX_FOTOS)(req, res, (erroUpload) => {
      if (erroUpload) {
        const mensagem =
          erroUpload.code === 'LIMIT_FILE_SIZE'
            ? 'Cada foto deve ter até 8 MB'
            : erroUpload.message || 'Falha no envio';
        return res.status(400).json({ erro: mensagem });
      }
      try {
        const produto = sel.produto.get(Number(req.params.id));
        if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
        const arquivos = req.files || [];
        if (arquivos.length === 0) throw new ErroNegocio('Nenhuma foto enviada', 'arquivo');
        const jaTem = sel.contagemFotos.get(produto.id).n;
        if (jaTem + arquivos.length > MAX_FOTOS) {
          throw new ErroNegocio(`Cada produto aceita até ${MAX_FOTOS} fotos`, 'limite');
        }
        const pasta = path.join(config.uploadsDir, String(produto.id));
        fs.mkdirSync(pasta, { recursive: true });
        let ordem = jaTem;
        for (const arquivo of arquivos) {
          if (!ehImagemValida(arquivo.buffer, arquivo.mimetype)) {
            throw new ErroNegocio('Um dos arquivos não é uma imagem válida', 'arquivo');
          }
          const nome = crypto.randomBytes(12).toString('hex') + extensaoPorMime(arquivo.mimetype);
          fs.writeFileSync(path.join(pasta, nome), arquivo.buffer);
          ins.foto.run(produto.id, `${produto.id}/${nome}`, ordem);
          ordem += 1;
        }
        return res.status(201).json(produtoAdmin(sel.produto.get(produto.id)));
      } catch (erro) {
        return tratarErro(erro, res);
      }
    });
  });

  app.delete(
    '/admin/api/fotos/:id',
    envolver((req, res) => {
      const foto = sel.foto.get(Number(req.params.id));
      if (!foto) return res.status(404).json({ erro: 'Foto não encontrada' });
      db.prepare('DELETE FROM photos WHERE id = ?').run(foto.id);
      const caminho = path.join(config.uploadsDir, foto.arquivo);
      if (fs.existsSync(caminho)) fs.unlinkSync(caminho);
      return res.json({ ok: true });
    })
  );

  app.put(
    '/admin/api/produtos/:id/fotos/ordem',
    envolver((req, res) => {
      const produtoId = Number(req.params.id);
      const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
      const atuais = sel.fotos.all(produtoId).map((f) => f.id);
      if (ids.length !== atuais.length || !ids.every((id) => atuais.includes(id))) {
        throw new ErroNegocio('Ordem de fotos inconsistente', 'dados');
      }
      db.exec('BEGIN');
      try {
        const atualizar = db.prepare('UPDATE photos SET ordem = ? WHERE id = ?');
        ids.forEach((id, posicao) => atualizar.run(posicao, id));
        db.exec('COMMIT');
      } catch (erro) {
        db.exec('ROLLBACK');
        throw erro;
      }
      return res.json(produtoAdmin(sel.produto.get(produtoId)));
    })
  );

  app.get('/admin/api/produtos/:id/fila', (req, res) => {
    servico.expirarVencidas(agora());
    const produto = sel.produto.get(Number(req.params.id));
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });
    const reservas = servico.filaDoProduto(produto.id).map((r) => {
      const numero = telefoneInternacional(r.telefone);
      const texto =
        r.status === 'ativa' && r.aviso_pendente === 1
          ? `Olá ${r.nome}! O item "${produto.nome}" ficou disponível para você reservar por ${config.reservaHoras} horas. Posso confirmar?`
          : `Olá ${r.nome}, sobre o item "${produto.nome}" da lista DESAPEGO.`;
      return {
        id: r.id,
        nome: r.nome,
        telefone: r.telefone,
        status: r.status,
        expiraEm: r.expira_em,
        avisoPendente: r.aviso_pendente === 1,
        whatsappLink: linkWhatsApp(numero, texto),
      };
    });
    return res.json(reservas);
  });

  app.post(
    '/admin/api/reservas/:id/cancelar',
    envolver((req, res) => {
      const reservaId = Number(req.params.id);
      servico.cancelar(reservaId, agora());
      return res.json({ ok: true });
    })
  );

  app.post(
    '/admin/api/reservas/:id/aviso-enviado',
    envolver((req, res) => {
      servico.marcarAvisoEnviado(Number(req.params.id));
      return res.json({ ok: true });
    })
  );

  app.get('/admin/api/status', (req, res) => {
    res.json({
      statusProduto: STATUS_PRODUTO,
      reservaHoras: config.reservaHoras,
      cartaoConfigurado: Boolean(mp),
      pixConfigurado: Boolean(config.pix.chave),
    });
  });

  // Páginas do painel
  app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
  });

  app.use((req, res) => res.status(404).json({ erro: 'Não encontrado' }));

  return { app, servico };
}

module.exports = { criarApp, linkWhatsApp, ehImagemValida };
