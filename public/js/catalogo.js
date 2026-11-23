(function () {
  'use strict';

  function el(tag, attrs, texto) {
    const e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k]));
    if (texto !== undefined) e.textContent = texto;
    return e;
  }

  function rotuloStatus(status) {
    return { disponivel: 'Disponível', reservado: 'Reservado (há interessado)', vendido: 'Vendido' }[status] || '';
  }

  function cartaoProduto(p) {
    const link = el('a', { class: 'cartao', href: `/produto.html?id=${p.id}` });
    const imagem = p.fotos[0]
      ? el('img', { src: p.fotos[0].url, alt: p.nome, loading: 'lazy' })
      : el('div', { class: 'suave', style: 'aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;background:#eee' }, 'Sem foto');
    const foto = el('div', { class: 'foto-wrap' });
    foto.appendChild(imagem);
    if (p.status === 'vendido') {
      foto.appendChild(el('img', { class: 'selo-vendido', src: '/img/vendido.png', alt: 'Vendido' }));
    }
    const corpo = el('div', { class: 'corpo' });
    const etiqueta = el('span', { class: `etiqueta ${p.status}` }, rotuloStatus(p.status));
    corpo.appendChild(etiqueta);
    corpo.appendChild(el('h2', null, p.nome));
    const preco = p.precos.avista
      ? el('div', { class: 'preco' }, p.precos.avista.texto + ' à vista')
      : el('div', { class: 'suave' }, 'Preço a combinar');
    corpo.appendChild(preco);
    if (p.prazoEntrega) corpo.appendChild(el('div', { class: 'entrega-card' }, 'Entrega: ' + p.prazoEntrega));
    link.appendChild(foto);
    link.appendChild(corpo);
    return link;
  }

  async function carregar() {
    const lista = document.getElementById('lista');
    try {
      const resposta = await fetch('/api/produtos');
      const produtos = await resposta.json();
      if (!produtos.length) {
        document.getElementById('vazio').classList.remove('oculto');
        return;
      }
      produtos.forEach((p) => lista.appendChild(cartaoProduto(p)));
    } catch (erro) {
      lista.appendChild(el('p', { class: 'aviso erro' }, 'Não foi possível carregar os itens.'));
    }
  }

  carregar();
})();
