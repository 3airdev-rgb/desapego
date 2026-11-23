(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const produtoId = Number(params.get('id'));
  let produto = null;
  let reservaAtual = null;
  let reservaHoras = 48;

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
      trilho.appendChild(img);
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

    if (precos.cartao) {
      const c = precos.cartao;
      const linha = document.createElement('div');
      linha.className = 'opcao-preco';
      linha.innerHTML = `<span>Cartão em ${c.parcelas}x</span><strong>${c.parcelas}x de ${c.valorParcelaTexto}</strong>`;
      bloco.appendChild(linha);
      const nota = document.createElement('p');
      nota.className = 'suave';
      nota.textContent =
        `Total no cartão parcelado: ${c.totalTexto}. A diferença em relação ao valor à vista é o custo da operação de parcelamento, pago pelo comprador.`;
      bloco.appendChild(nota);
    }
  }

  function renderizarProduto() {
    $('conteudo').classList.remove('oculto');
    $('nome').textContent = produto.nome;
    $('descricao').textContent = produto.descricao;
    $('entrega').textContent = produto.prazoEntrega ? `Entrega: ${produto.prazoEntrega}` : '';
    const etiqueta = $('etiqueta');
    etiqueta.textContent = { disponivel: 'Disponível', reservado: 'Reservado' }[produto.status] || '';
    etiqueta.className = `etiqueta ${produto.status}`;
    $('duvidas').href = produto.whatsappDuvidas;
    $('horas').textContent = String(reservaHoras);
    renderizarFotos(produto.fotos);
    renderizarPrecos();
  }

  function renderizarReserva(estado) {
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
        `Item reservado para você até ${dataHora(estado.expiraEm)}. Escolha a forma de pagamento abaixo.`,
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
  }

  function mostrarPagamento() {
    const painel = $('painelPagamento');
    painel.classList.remove('oculto');
    const temPix = produto.precos.pix && produto.precos.avista;
    $('btnPix').classList.toggle('oculto', !temPix);
    const cartao = produto.precos.cartao;
    $('btnCartao').classList.toggle('oculto', !cartao);
    $('textoCartao').textContent = cartao
      ? `Parcelado em 6x de ${cartao.valorParcelaTexto} (total ${cartao.totalTexto}).`
      : '';
  }

  async function carregarProduto() {
    if (!produtoId) {
      mostrarErro('Item não informado.');
      return;
    }
    try {
      const cfg = await chamar('/api/config');
      reservaHoras = cfg.reservaHoras;
      produto = await chamar(`/api/produtos/${produtoId}`);
      renderizarProduto();
      const estado = await chamar(`/api/produtos/${produtoId}/minha-reserva`);
      reservaAtual = estado;
      renderizarReserva(estado);
    } catch (erro) {
      mostrarErro('Item não encontrado ou indisponível.');
    }
  }

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
    } catch (erro) {
      aviso($('estadoReserva'), erro.message, 'erro');
      botao.disabled = false;
    }
  });

  $('btnPix').addEventListener('click', async () => {
    const botao = $('btnPix');
    botao.disabled = true;
    try {
      const pix = await chamar(`/api/produtos/${produtoId}/pagar/pix`, { method: 'POST' });
      $('qrPix').innerHTML = pix.qrSvg;
      $('copiaCola').textContent = pix.copiaECola;
      $('instrucaoPix').textContent = pix.instrucao;
      $('blocoPix').classList.remove('oculto');
      aviso($('aviso'), `Valor: ${pix.valorTexto}`, 'info');
    } catch (erro) {
      aviso($('aviso'), erro.message, 'erro');
    } finally {
      botao.disabled = false;
    }
  });

  $('btnCopiar').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('copiaCola').textContent);
      $('btnCopiar').textContent = 'Código copiado';
    } catch (erro) {
      aviso($('aviso'), 'Não foi possível copiar. Selecione o código manualmente.', 'erro');
    }
  });

  $('btnCartao').addEventListener('click', async () => {
    const botao = $('btnCartao');
    botao.disabled = true;
    try {
      const cartao = await chamar(`/api/produtos/${produtoId}/pagar/cartao`, { method: 'POST' });
      window.location.href = cartao.initPoint;
    } catch (erro) {
      aviso($('aviso'), erro.message, 'erro');
      botao.disabled = false;
    }
  });

  carregarProduto();
})();
