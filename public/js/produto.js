(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const produtoId = Number(params.get('id'));
  let produto = null;
  let reservaAtual = null;
  let reservaHoras = 48;
  let whatsappNumero = '5548984443883';
  let modoCompra = false;

  const $ = (id) => document.getElementById(id);

  function mostrarErro(mensagem) {
    const box = $('erro');
    box.textContent = mensagem;
    box.classList.remove('oculto');
  }

  function aviso(elemento, texto, tipo) {
    elemento.textContent = texto;
    elemento.className = `aviso ${tipo}`;
    elemento.classList.remove('oculto');
  }

  function dataHora(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  async function chamar(url, opcoes) {
    const resposta = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opcoes,
    });
    const corpo = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw new Error(corpo.erro || 'Falha na operação');
    return corpo;
  }

  function renderizarFotos(fotos) {
    const trilho = $('trilho');
    const pontos = $('pontos');
    trilho.innerHTML = '';
    pontos.innerHTML = '';
    if (!fotos.length) {
      trilho.innerHTML = '<div class="suave" style="aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;width:100%">Sem fotos</div>';
      $('anterior').classList.add('oculto');
      $('proxima').classList.add('oculto');
      return;
    }
    fotos.forEach((f, i) => {
      const img = document.createElement('img');
      img.src = f.url;
      img.alt = `${produto.nome} — foto ${i + 1} de ${fotos.length}`;
      img.loading = i === 0 ? 'eager' : 'lazy';
      if (i === 0 && produto.status === 'vendido') {
        const slide = document.createElement('div');
        slide.className = 'slide';
        img.className = 'foto';
        const selo = document.createElement('img');
        selo.className = 'selo-vendido';
        selo.src = '/img/vendido.png';
        selo.alt = 'Vendido';
        slide.appendChild(img);
        slide.appendChild(selo);
        trilho.appendChild(slide);
      } else {
        trilho.appendChild(img);
      }
      const ponto = document.createElement('span');
      if (i === 0) ponto.classList.add('ativo');
      pontos.appendChild(ponto);
    });
    const atualizarPontos = () => {
      const largura = trilho.clientWidth || 1;
      const indice = Math.round(trilho.scrollLeft / largura);
      [...pontos.children].forEach((p, i) => p.classList.toggle('ativo', i === indice));
    };
    trilho.addEventListener('scroll', atualizarPontos, { passive: true });
    $('anterior').onclick = () => trilho.scrollBy({ left: -trilho.clientWidth, behavior: 'smooth' });
    $('proxima').onclick = () => trilho.scrollBy({ left: trilho.clientWidth, behavior: 'smooth' });
  }

  function renderizarPrecos() {
    const bloco = $('precos');
    bloco.innerHTML = '';
    const { precos } = produto;
    if (!precos.avista) {
      bloco.innerHTML = '<p class="suave">Preço a combinar.</p>';
      return;
    }
    const linhaAvista = document.createElement('div');
    linhaAvista.className = 'opcao-preco';
    linhaAvista.innerHTML = `<span>À vista (Pix)</span><strong>${precos.avista.texto}</strong>`;
    bloco.appendChild(linhaAvista);

    if (precos.cartao && precos.cartaoModo === 'link') {
      const l1 = document.createElement('div');
      l1.className = 'opcao-preco';
      l1.innerHTML = `<span>Cartão de crédito (1x)</span><strong>${precos.cartao[0].totalTexto}</strong>`;
      bloco.appendChild(l1);
      const l2 = document.createElement('div');
      l2.className = 'opcao-preco';
      l2.innerHTML = `<span>Cartão parcelado</span><span class="suave">em até ${precos.cartao.length}x, com acréscimo</span>`;
      bloco.appendChild(l2);
      const nota = document.createElement('p');
      nota.className = 'suave';
      nota.textContent =
        'O pagamento com cartão tem custos adicionais aplicados pela plataforma Mercado Pago. Ao escolher essa forma, os valores de cada parcela são apresentados antes de você prosseguir. No Pix à vista não há acréscimo.';
      bloco.appendChild(nota);
    } else if (precos.cartao && precos.cartaoModo === 'comprador') {
      const c = precos.cartao[0];
      const l1 = document.createElement('div');
      l1.className = 'opcao-preco';
      l1.innerHTML = `<span>Cartão de crédito (1x)</span><strong>${c.totalTexto}</strong>`;
      bloco.appendChild(l1);
      const l2 = document.createElement('div');
      l2.className = 'opcao-preco';
      l2.innerHTML = `<span>Cartão parcelado</span><span class="suave">em até ${precos.cartaoParcelasMax}x, com juros do Mercado Pago</span>`;
      bloco.appendChild(l2);
      const nota = document.createElement('p');
      nota.className = 'suave';
      nota.textContent =
        `No cartão, o Mercado Pago calcula o valor final, inclusive os juros do parcelamento, e mostra na etapa "Escolha o parcelamento", antes de você confirmar.`;
      bloco.appendChild(nota);
    } else if (precos.cartao) {
      const titulo = document.createElement('p');
      titulo.className = 'suave';
      titulo.style.marginBottom = '2px';
      titulo.textContent = 'Cartão de crédito (de 1x a 6x):';
      bloco.appendChild(titulo);
      precos.cartao.forEach((c) => {
        const linha = document.createElement('div');
        linha.className = 'opcao-preco';
        linha.innerHTML = `<span>${c.parcelas}x de ${c.valorParcelaTexto}</span><span class="suave">total ${c.totalTexto}</span>`;
        bloco.appendChild(linha);
      });
      const nota = document.createElement('p');
      nota.className = 'suave';
      nota.textContent =
        'No cartão, o total é maior que o valor à vista porque inclui as taxas da operação e do parcelamento, pagas pelo comprador. À vista no Pix não há acréscimo.';
      bloco.appendChild(nota);
    }
  }

  function renderizarProduto() {
    $('conteudo').classList.remove('oculto');
    $('nome').textContent = produto.nome;
    $('descricao').textContent = produto.descricao;
    const entrega = $('entrega');
    entrega.textContent = '';
    if (produto.prazoEntrega) {
      const rotulo = document.createElement('span');
      rotulo.className = 'rotulo';
      rotulo.textContent = 'Entrega';
      const valor = document.createElement('strong');
      valor.textContent = produto.prazoEntrega;
      entrega.appendChild(rotulo);
      entrega.appendChild(valor);
    }
    entrega.classList.toggle('oculto', !produto.prazoEntrega);
    const etiqueta = $('etiqueta');
    etiqueta.textContent = { disponivel: 'Disponível', reservado: 'Reservado', vendido: 'Vendido' }[produto.status] || '';
    etiqueta.className = `etiqueta ${produto.status}`;
    $('duvidas').href = produto.whatsappDuvidas;
    renderizarFotos(produto.fotos);
    renderizarPrecos();
  }

  function atualizarBotaoComprar(estado) {
    const botao = $('btnComprar');
    const temPreco = Boolean(produto.precos.avista);
    const proprioAtivo = estado && estado.status === 'ativa';
    const naFila = estado && estado.status === 'fila';
    botao.classList.toggle('oculto', !temPreco);
    botao.disabled = false;
    botao.textContent = 'Comprar agora';
    if (produto.status === 'vendido') {
      botao.disabled = true;
      botao.textContent = 'Item vendido';
      return;
    }
    if (!proprioAtivo && (produto.status === 'reservado' || naFila)) {
      botao.disabled = true;
      botao.textContent = 'Item reservado por outro interessado';
    }
  }

  function renderizarReserva(estado) {
    atualizarBotaoComprar(estado);
    renderizarReservaBase(estado);
  }

  function renderizarReservaBase(estado) {
    const bloco = $('estadoReserva');
    const formulario = $('formInteresse');
    const painelPagamento = $('painelPagamento');
    bloco.innerHTML = '';
    formulario.classList.add('oculto');
    painelPagamento.classList.add('oculto');

    if (produto.status === 'vendido') {
      aviso(bloco, 'Este item já foi vendido.', 'erro');
      return;
    }

    if (estado && estado.status === 'ativa') {
      aviso(
        bloco,
        estado.pagamentoEscolhido
          ? 'Item reservado para você. Forma de pagamento escolhida: aguardando a confirmação do vendedor.'
          : `Item reservado para você até ${dataHora(estado.expiraEm)}. Escolha a forma de pagamento abaixo.`,
        'sucesso'
      );
      mostrarPagamento();
      return;
    }

    if (estado && estado.status === 'fila') {
      aviso(bloco, 'Você está na fila de interessados. Se o item for liberado, entraremos em contato pelo WhatsApp.', 'info');
      return;
    }

    if (produto.status === 'reservado') {
      bloco.innerHTML = `<p class="suave">Já existe um interessado com reserva ativa. Você pode entrar na fila e será avisado se o item for liberado.</p>`;
    } else {
      bloco.innerHTML = '<p class="suave">Ao demonstrar interesse, o item fica reservado para você por 48 horas.</p>';
    }
    formulario.classList.remove('oculto');
    $('tituloReserva').textContent = modoCompra ? 'Comprar agora' : 'Tenho interesse';
    $('btnInteresse').textContent = modoCompra
      ? 'Continuar para o pagamento'
      : `Tenho interesse (reservar por ${reservaHoras} h)`;
  }

  function mostrarPagamento() {
    const painel = $('painelPagamento');
    painel.classList.remove('oculto');
    const temPix = produto.precos.pix && produto.precos.avista;
    $('btnPix').classList.toggle('oculto', !temPix);
    const cartao = produto.precos.cartao;
    $('blocoCartao').classList.toggle('oculto', !cartao);
    if (cartao) {
      const sel = $('selParcelas');
      sel.innerHTML = '';
      const link = produto.precos.cartaoModo === 'link';
      const comprador = produto.precos.cartaoModo === 'comprador';
      if (link) {
        $('selParcelas').classList.add('oculto');
        document.querySelector('label[for="selParcelas"]').classList.add('oculto');
        $('btnCartao').textContent = 'Pagar com cartão (à vista ou parcelado)';
        $('textoCartao').textContent = 'Ao continuar, você verá os valores com os custos do Mercado Pago.';
        return;
      }
      if (comprador) {
        const base = cartao[0];
        for (let n = 1; n <= produto.precos.cartaoParcelasMax; n += 1) {
          const op = document.createElement('option');
          op.value = String(n);
          op.textContent = n === 1 ? `1x (${base.totalTexto})` : `${n}x (juros calculados pelo Mercado Pago)`;
          sel.appendChild(op);
        }
      } else {
        cartao.forEach((c) => {
          const op = document.createElement('option');
          op.value = String(c.parcelas);
          op.textContent = `${c.parcelas}x de ${c.valorParcelaTexto} (total ${c.totalTexto})`;
          sel.appendChild(op);
        });
      }
      const atualizar = () => {
        const n = Number(sel.value);
        if (comprador) {
          const base = cartao[0];
          $('btnCartao').textContent = `Pagar com cartão em ${n}x`;
          $('textoCartao').textContent = n === 1
            ? `Valor: ${base.totalTexto}.`
            : `Valor base: ${base.totalTexto}. Os juros do parcelamento em ${n}x são calculados pelo Mercado Pago e aparecem na etapa "Escolha o parcelamento", antes de confirmar.`;
        } else {
          const c = cartao.find((x) => x.parcelas === n) || cartao[0];
          $('btnCartao').textContent = `Pagar com cartão em ${c.parcelas}x de ${c.valorParcelaTexto}`;
          $('textoCartao').textContent =
            `Total: ${c.totalTexto}, já com as taxas. No Mercado Pago, na etapa "Escolha o parcelamento", confirme ${c.parcelas}x.`;
        }
      };
      sel.onchange = atualizar;
      atualizar();
    }
  }

  function abrirPopupCartao() {
    const precos = produto.precos;
    const fundo = document.createElement('div');
    fundo.className = 'popup-fundo';
    const caixa = document.createElement('div');
    caixa.className = 'popup';
    caixa.setAttribute('role', 'dialog');
    caixa.setAttribute('aria-modal', 'true');
    const linhas = precos.cartao
      .map((c) => {
        const rotulo = c.parcelas === 1 ? 'À vista' : `${c.parcelas}x de ${c.valorParcelaTexto}`;
        const total = c.parcelas === 1 ? c.totalTexto : `total ${c.totalTexto}`;
        return `<tr><td>${rotulo}</td><td>${total}</td></tr>`;
      })
      .join('');
    caixa.innerHTML =
      '<h2>Pagamento com cartão</h2>' +
      '<p>O pagamento com cartão tem <strong>custos adicionais aplicados pela plataforma Mercado Pago</strong> ' +
      '(tarifa de processamento e, no parcelamento, juros). Valores para este item, que no Pix custa ' +
      `${precos.avista.texto}:</p>` +
      `<table class="tabela-parcelas"><thead><tr><th>Forma</th><th>Valor</th></tr></thead><tbody>${linhas}</tbody></table>` +
      '<p class="suave">As duas opções abrem uma conversa no WhatsApp com o vendedor, já com o item e o valor do cartão à vista.</p>' +
      '<div class="acoes-popup"></div>';
    const acoes = caixa.querySelector('.acoes-popup');
    // A escolha é registrada no servidor (a reserva deixa de expirar) e só então o WhatsApp abre,
    // com a mensagem montada pelo servidor (nome da reserva, item e valor do cartão à vista).
    const links = reservaAtual && reservaAtual.whatsappCartao;
    const erro = document.createElement('div');
    erro.className = 'aviso erro oculto';
    const botaoWhatsApp = (texto, opcao) => {
      const b = document.createElement('button');
      b.className = 'botao';
      b.type = 'button';
      b.textContent = texto;
      b.addEventListener('click', async () => {
        // A janela é aberta já no clique, para o navegador não bloquear como pop-up.
        const janela = window.open('', '_blank');
        b.disabled = true;
        try {
          const r = await chamar(`/api/produtos/${produtoId}/pagar/whatsapp`, {
            method: 'POST',
            body: JSON.stringify({ opcao }),
          });
          if (janela) {
            janela.opener = null;
            janela.location.href = r.link;
          } else {
            window.location.href = r.link;
          }
          fundo.remove();
          carregarProduto();
        } catch (e) {
          if (janela) janela.close();
          aviso(erro, e.message, 'erro');
          b.disabled = false;
        }
      });
      return b;
    };
    if (links) {
      acoes.appendChild(botaoWhatsApp('Solicitar o link de pagamento', 'link'));
      acoes.appendChild(botaoWhatsApp('Pagamento no local', 'local'));
      acoes.appendChild(erro);
    } else {
      const aviso = document.createElement('p');
      aviso.className = 'suave';
      aviso.textContent = 'Não foi possível montar a mensagem. Recarregue a página ou fale com o vendedor pelo WhatsApp.';
      acoes.appendChild(aviso);
    }
    const fechar = document.createElement('button');
    fechar.className = 'botao secundario';
    fechar.type = 'button';
    fechar.textContent = 'Voltar';
    fechar.addEventListener('click', () => fundo.remove());
    acoes.appendChild(fechar);
    fundo.addEventListener('click', (e) => { if (e.target === fundo) fundo.remove(); });
    fundo.appendChild(caixa);
    document.body.appendChild(fundo);
  }

  async function carregarProduto() {
    if (!produtoId) {
      mostrarErro('Item não informado.');
      return;
    }
    try {
      const cfg = await chamar('/api/config');
      reservaHoras = cfg.reservaHoras;
      whatsappNumero = cfg.whatsappNumero || whatsappNumero;
      produto = await chamar(`/api/produtos/${produtoId}`);
      renderizarProduto();
      const estado = await chamar(`/api/produtos/${produtoId}/minha-reserva`);
      reservaAtual = estado;
      renderizarReserva(estado);
    } catch (erro) {
      mostrarErro('Item não encontrado ou indisponível.');
    }
  }

  $('btnComprar').addEventListener('click', () => {
    if (reservaAtual && reservaAtual.status === 'ativa') {
      $('painelPagamento').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    modoCompra = true;
    renderizarReserva(reservaAtual);
    $('painelReserva').scrollIntoView({ behavior: 'smooth' });
    $('nomeInteresse').focus();
  });

  $('formInteresse').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const botao = evento.submitter || evento.target.querySelector('button');
    botao.disabled = true;
    try {
      const resultado = await chamar(`/api/produtos/${produtoId}/interesse`, {
        method: 'POST',
        body: JSON.stringify({
          nome: $('nomeInteresse').value,
          telefone: $('telInteresse').value,
        }),
      });
      reservaAtual = { status: resultado.status, expiraEm: resultado.expiraEm };
      if (resultado.status === 'ativa') {
        produto.status = 'reservado';
      }
      await carregarProduto();
      if (modoCompra && reservaAtual && reservaAtual.status === 'ativa') {
        $('painelPagamento').scrollIntoView({ behavior: 'smooth' });
      }
    } catch (erro) {
      aviso($('estadoReserva'), erro.message, 'erro');
    } finally {
      botao.disabled = false;
    }
  });

  function abrirPopupPix(pix) {
    const fundo = document.createElement('div');
    fundo.className = 'popup-fundo';
    const caixa = document.createElement('div');
    caixa.className = 'popup';
    caixa.setAttribute('role', 'dialog');
    caixa.setAttribute('aria-modal', 'true');
    caixa.innerHTML =
      '<h2>Pagamento com Pix</h2>' +
      '<p>Valor: <strong data-campo="valor"></strong></p>' +
      '<div class="aviso atencao"><strong>Atenção</strong>' +
      '<p data-campo="destinatario"></p>' +
      '<p>Após efetivar o pagamento, compartilhe o comprovante com <a data-campo="telefone" target="_blank" rel="noopener"></a>.</p></div>' +
      '<p class="suave">Escaneie o QR code ou copie o código abaixo no app do seu banco.</p>' +
      '<div data-campo="qr" style="max-width:240px;margin:10px auto" aria-label="QR code do Pix"></div>' +
      '<div class="copia-cola" data-campo="codigo"></div>' +
      '<div class="acoes-popup"></div>' +
      '<p class="suave" data-campo="instrucao"></p>';
    const campo = (nome) => caixa.querySelector(`[data-campo="${nome}"]`);
    campo('valor').textContent = pix.valorTexto;
    const destinatario = campo('destinatario');
    if (pix.atencao.destinatario) {
      destinatario.textContent = `Verifique se o destinatário do PIX é ${pix.atencao.destinatario}.`;
    } else {
      destinatario.remove();
    }
    campo('telefone').textContent = pix.atencao.comprovanteTelefone;
    campo('telefone').href = pix.atencao.comprovanteLink;
    campo('qr').innerHTML = pix.qrSvg; // SVG gerado pelo servidor (biblioteca qrcode)
    campo('codigo').textContent = pix.copiaECola;
    campo('instrucao').textContent = pix.instrucao;

    const acoes = caixa.querySelector('.acoes-popup');
    const copiar = document.createElement('button');
    copiar.className = 'botao';
    copiar.type = 'button';
    copiar.textContent = 'Copiar código Pix';
    copiar.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pix.copiaECola);
        copiar.textContent = 'Código copiado';
      } catch (erro) {
        copiar.textContent = 'Selecione o código acima e copie';
      }
    });
    const fechar = document.createElement('button');
    fechar.className = 'botao secundario';
    fechar.type = 'button';
    fechar.textContent = 'Fechar';
    fechar.addEventListener('click', () => fundo.remove());
    acoes.appendChild(copiar);
    acoes.appendChild(fechar);
    fundo.addEventListener('click', (e) => { if (e.target === fundo) fundo.remove(); });
    fundo.appendChild(caixa);
    document.body.appendChild(fundo);
  }

  $('btnPix').addEventListener('click', async () => {
    const botao = $('btnPix');
    botao.disabled = true;
    try {
      const pix = await chamar(`/api/produtos/${produtoId}/pagar/pix`, { method: 'POST' });
      abrirPopupPix(pix);
      $('aviso').classList.add('oculto');
      carregarProduto();
    } catch (erro) {
      aviso($('aviso'), erro.message, 'erro');
    } finally {
      botao.disabled = false;
    }
  });

  $('btnCartao').addEventListener('click', async () => {
    const botao = $('btnCartao');
    if (produto.precos.cartaoModo === 'link') {
      abrirPopupCartao();
      return;
    }
    botao.disabled = true;
    try {
      const cartao = await chamar(`/api/produtos/${produtoId}/pagar/cartao`, {
        method: 'POST',
        body: JSON.stringify({ parcelas: Number($('selParcelas').value) }),
      });
      window.location.href = cartao.initPoint;
    } catch (erro) {
      aviso($('aviso'), erro.message, 'erro');
      botao.disabled = false;
    }
  });

  carregarProduto();
})();
