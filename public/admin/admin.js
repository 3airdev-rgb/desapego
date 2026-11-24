(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let produtoAtual = null;
  let listaCache = [];

  function mostrar(id, visivel) {
    $(id).classList.toggle('secao-oculta', !visivel);
  }

  function mensagem(elemento, texto, tipo) {
    elemento.textContent = texto;
    elemento.className = `aviso ${tipo}`;
    elemento.classList.remove('secao-oculta');
  }

  async function api(url, opcoes = {}) {
    const isForm = opcoes.body instanceof FormData;
    const resposta = await fetch(url, {
      ...opcoes,
      headers: isForm ? {} : { 'Content-Type': 'application/json' },
      body: opcoes.body && !isForm ? JSON.stringify(opcoes.body) : opcoes.body,
    });
    if (resposta.status === 401) {
      mostrarLogin();
      throw new Error('Sessão expirada. Entre novamente.');
    }
    const corpo = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw new Error(corpo.erro || 'Falha na operação');
    return corpo;
  }

  function mostrarLogin() {
    mostrar('login', true);
    mostrar('painelLista', false);
    mostrar('painelEditor', false);
    $('sair').classList.add('oculto');
  }

  function mostrarLista() {
    mostrar('login', false);
    mostrar('painelLista', true);
    mostrar('painelEditor', false);
    $('sair').classList.remove('oculto');
    carregarLista();
  }

  function mostrarEditor() {
    mostrar('painelLista', false);
    mostrar('painelEditor', true);
  }

  async function carregarLista() {
    listaCache = await api('/admin/api/produtos');
    const ul = $('listaProdutos');
    ul.innerHTML = '';
    if (!listaCache.length) {
      ul.innerHTML = '<li class="suave">Nenhum produto cadastrado.</li>';
      return;
    }
    listaCache.forEach((p) => {
      const li = document.createElement('li');
      const info = document.createElement('div');
      const nome = document.createElement('strong');
      nome.textContent = p.nome;
      const detalhe = document.createElement('div');
      detalhe.className = 'suave';
      const partes = [
        p.precoAvistaTexto || 'sem preço',
        p.publicado ? 'publicado' : 'rascunho',
        p.status,
        `${p.fotos.length} foto(s)`,
        `fila: ${p.filaTamanho}`,
      ];
      detalhe.textContent = partes.join(' · ');
      info.appendChild(nome);
      info.appendChild(detalhe);
      const botao = document.createElement('button');
      botao.className = 'botao secundario';
      botao.style.width = 'auto';
      botao.style.margin = '0';
      botao.type = 'button';
      botao.textContent = 'Editar';
      botao.onclick = () => abrirProduto(p.id);
      li.appendChild(info);
      li.appendChild(botao);
      ul.appendChild(li);
    });
  }

  function preencherFormulario(p) {
    $('tituloEditor').textContent = p ? `Editar: ${p.nome}` : 'Novo produto';
    $('nome').value = p ? p.nome : '';
    $('descricao').value = p ? p.descricao : '';
    $('precoAvista').value = p && p.precoAvistaCents ? (p.precoAvistaCents / 100).toFixed(2).replace('.', ',') : '';
    $('prazoEntrega').value = p ? p.prazoEntrega : '';
    $('publicado').checked = p ? p.publicado : false;
    $('painelFotos').classList.remove('secao-oculta');
    $('painelFila').classList.toggle('secao-oculta', !p);
    $('arquivos').value = '';
  }

  async function abrirProduto(id) {
    produtoAtual = listaCache.find((p) => p.id === id) || (await api(`/admin/api/produtos`)).find((p) => p.id === id);
    preencherFormulario(produtoAtual);
    renderizarFotos();
    await carregarFila();
    mostrarEditor();
    $('avisoProduto').classList.add('secao-oculta');
  }

  function renderizarFotos() {
    const grade = $('miniaturas');
    grade.innerHTML = '';
    if (!produtoAtual) return;
    const fotos = produtoAtual.fotos;
    fotos.forEach((f, i) => {
      const card = document.createElement('div');
      card.className = 'miniatura';
      const img = document.createElement('img');
      img.src = f.url;
      img.alt = `Foto ${i + 1}`;
      const acoes = document.createElement('div');
      acoes.className = 'acoes';
      const esquerda = document.createElement('button');
      esquerda.type = 'button';
      esquerda.textContent = '◀';
      esquerda.disabled = i === 0;
      esquerda.onclick = () => moverFoto(i, i - 1);
      const direita = document.createElement('button');
      direita.type = 'button';
      direita.textContent = '▶';
      direita.disabled = i === fotos.length - 1;
      direita.onclick = () => moverFoto(i, i + 1);
      const remover = document.createElement('button');
      remover.type = 'button';
      remover.textContent = 'Excluir';
      remover.onclick = () => excluirFoto(f.id);
      acoes.appendChild(esquerda);
      acoes.appendChild(direita);
      card.appendChild(img);
      card.appendChild(acoes);
      card.appendChild(remover);
      grade.appendChild(card);
    });
  }

  async function moverFoto(de, para) {
    const ids = produtoAtual.fotos.map((f) => f.id);
    [ids[de], ids[para]] = [ids[para], ids[de]];
    try {
      produtoAtual = await api(`/admin/api/produtos/${produtoAtual.id}/fotos/ordem`, {
        method: 'PUT',
        body: { ids },
      });
      renderizarFotos();
    } catch (erro) {
      alert(erro.message);
    }
  }

  async function excluirFoto(id) {
    if (!confirm('Excluir esta foto?')) return;
    try {
      await api(`/admin/api/fotos/${id}`, { method: 'DELETE' });
      produtoAtual = (await api('/admin/api/produtos')).find((p) => p.id === produtoAtual.id);
      renderizarFotos();
    } catch (erro) {
      alert(erro.message);
    }
  }

  async function enviarFotos() {
    const arquivos = $('arquivos').files;
    if (!arquivos.length) return alert('Selecione ao menos uma foto.');
    if (!produtoAtual) return alert('As fotos selecionadas serão enviadas quando você clicar em "Salvar produto".');
    const dados = new FormData();
    for (const arquivo of arquivos) dados.append('fotos', arquivo);
    try {
      produtoAtual = await api(`/admin/api/produtos/${produtoAtual.id}/fotos`, {
        method: 'POST',
        body: dados,
      });
      $('arquivos').value = '';
      renderizarFotos();
    } catch (erro) {
      alert(erro.message);
    }
  }

  async function salvarProduto(evento) {
    evento.preventDefault();
    const corpo = {
      nome: $('nome').value,
      descricao: $('descricao').value,
      precoAvista: $('precoAvista').value,
      prazoEntrega: $('prazoEntrega').value,
      publicado: $('publicado').checked,
    };
    try {
      const fotosPendentes = produtoAtual ? [] : [...$('arquivos').files];
      if (produtoAtual) {
        produtoAtual = await api(`/admin/api/produtos/${produtoAtual.id}`, { method: 'PUT', body: corpo });
      } else {
        produtoAtual = await api('/admin/api/produtos', { method: 'POST', body: corpo });
      }
      if (fotosPendentes.length) {
        const dados = new FormData();
        fotosPendentes.forEach((f) => dados.append('fotos', f));
        try {
          produtoAtual = await api(`/admin/api/produtos/${produtoAtual.id}/fotos`, { method: 'POST', body: dados });
        } catch (erroFoto) {
          mensagem($('avisoProduto'), `Produto salvo, mas as fotos falharam: ${erroFoto.message}`, 'erro');
          preencherFormulario(produtoAtual);
          return;
        }
      }
      preencherFormulario(produtoAtual);
      $('painelFotos').classList.remove('secao-oculta');
      $('painelFila').classList.remove('secao-oculta');
      renderizarFotos();
      await carregarFila();
      mensagem($('avisoProduto'), 'Produto salvo.', 'sucesso');
    } catch (erro) {
      mensagem($('avisoProduto'), erro.message, 'erro');
    }
  }

  async function carregarFila() {
    const bloco = $('listaFila');
    bloco.innerHTML = '';
    if (!produtoAtual) return;
    const reservas = await api(`/admin/api/produtos/${produtoAtual.id}/fila`);
    if (!reservas.length) {
      bloco.innerHTML = '<p class="suave">Nenhum interessado no momento.</p>';
      return;
    }
    reservas.forEach((r, i) => {
      const item = document.createElement('div');
      item.className = 'fila-item';
      const titulo = document.createElement('div');
      const rotulo = { ativa: 'Reserva ativa', fila: `Fila (${i})` }[r.status] || r.status;
      titulo.innerHTML = `<strong></strong> · <span class="suave"></span>`;
      titulo.querySelector('strong').textContent = r.nome;
      const detalhe = titulo.querySelector('span');
      const expira = r.expiraEm ? ` até ${new Date(r.expiraEm).toLocaleString('pt-BR')}` : '';
      detalhe.textContent = `${rotulo}${expira} · ${r.telefone}`;
      item.appendChild(titulo);

      if (r.pagamentoEscolhido) {
        const forma = {
          pix: 'Pix',
          cartao_link: 'cartão: pediu o link de pagamento pelo WhatsApp',
          cartao_local: 'cartão: pagamento no local',
        }[r.pagamentoEscolhido] || r.pagamentoEscolhido;
        const pago = document.createElement('div');
        pago.className = 'aviso info';
        pago.textContent = `Forma de pagamento escolhida: ${forma}. O item fica reservado (sem prazo) até você registrar a venda, cancelar a reserva ou reabrir o item.`;
        item.appendChild(pago);
      }

      if (r.avisoPendente) {
        const aviso = document.createElement('div');
        aviso.className = 'aviso info';
        aviso.textContent = 'Este interessado foi promovido da fila. Envie o aviso pelo WhatsApp.';
        item.appendChild(aviso);
      }

      const acoes = document.createElement('div');
      acoes.className = 'acoes';
      const whats = document.createElement('a');
      whats.href = r.whatsappLink;
      whats.target = '_blank';
      whats.rel = 'noopener';
      whats.textContent = 'Abrir WhatsApp';
      if (r.avisoPendente) whats.classList.add('primario');
      acoes.appendChild(whats);

      if (r.avisoPendente) {
        const avisado = document.createElement('button');
        avisado.type = 'button';
        avisado.textContent = 'Marcar aviso enviado';
        avisado.onclick = async () => {
          await api(`/admin/api/reservas/${r.id}/aviso-enviado`, { method: 'POST' });
          await carregarFila();
        };
        acoes.appendChild(avisado);
      }

      if (r.status === 'ativa' || r.status === 'fila') {
        const cancelar = document.createElement('button');
        cancelar.type = 'button';
        cancelar.textContent = r.status === 'ativa' ? 'Cancelar reserva' : 'Remover da fila';
        cancelar.onclick = async () => {
          if (!confirm('Confirmar cancelamento?')) return;
          await api(`/admin/api/reservas/${r.id}/cancelar`, { method: 'POST' });
          await abrirProduto(produtoAtual.id);
        };
        acoes.appendChild(cancelar);
      }

      item.appendChild(acoes);
      bloco.appendChild(item);
    });
  }

  async function reabrir() {
    if (!confirm('Reabrir este item para venda? A reserva ativa, se houver, será cancelada e o próximo da fila recebe a reserva.')) return;
    try {
      produtoAtual = await api(`/admin/api/produtos/${produtoAtual.id}/reabrir`, { method: 'POST' });
      await abrirProduto(produtoAtual.id);
    } catch (erro) {
      alert(erro.message);
    }
  }

  async function registrarVenda(metodo) {
    const nome = metodo === 'cartao' ? 'O pagamento no cartão foi concluído na maquininha' : 'O Pix foi recebido';
    if (!confirm(`Confirme: ${nome}. A venda será registrada e o item ficará marcado como vendido.`)) return;
    try {
      await api(`/admin/api/produtos/${produtoAtual.id}/vender`, {
        method: 'POST',
        body: { metodo },
      });
      mostrarLista();
    } catch (erro) {
      alert(erro.message);
    }
  }

  // Eventos
  $('formLogin').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    try {
      await api('/admin/api/login', { method: 'POST', body: { senha: $('senha').value } });
      $('senha').value = '';
      mostrarLista();
    } catch (erro) {
      mensagem($('erroLogin'), erro.message, 'erro');
    }
  });

  $('sair').addEventListener('click', async () => {
    await api('/admin/api/logout', { method: 'POST' });
    mostrarLogin();
  });

  $('novo').addEventListener('click', () => {
    produtoAtual = null;
    preencherFormulario(null);
    $('miniaturas').innerHTML = '';
    $('listaFila').innerHTML = '';
    $('avisoProduto').classList.add('secao-oculta');
    mostrarEditor();
  });

  $('voltarLista').addEventListener('click', mostrarLista);
  $('formProduto').addEventListener('submit', salvarProduto);
  $('enviarFotos').addEventListener('click', enviarFotos);
  $('reabrir').addEventListener('click', reabrir);
  $('vender').addEventListener('click', () => registrarVenda('pix'));
  $('venderCartao').addEventListener('click', () => registrarVenda('cartao'));

  // Início: se já houver sessão, abre a lista; senão, mostra o login.
  api('/admin/api/produtos')
    .then(() => mostrarLista())
    .catch(() => mostrarLogin());
})();
