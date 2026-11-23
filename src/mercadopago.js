'use strict';

// Integração mínima com a API do Mercado Pago (Checkout Pro com parcelamento).
// fetch é injetável para permitir testes sem chamadas reais.

const API = 'https://api.mercadopago.com';

function criarClienteMP({ accessToken, fetchImpl = globalThis.fetch }) {
  async function requisitar(caminho, opcoes = {}) {
    if (!accessToken) throw new Error('Mercado Pago não configurado (MP_ACCESS_TOKEN)');
    const resposta = await fetchImpl(`${API}${caminho}`, {
      ...opcoes,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(opcoes.headers || {}),
      },
    });
    const corpo = await resposta.json().catch(() => ({}));
    if (!resposta.ok) {
      const detalhe = [corpo.message, corpo.error, corpo.status, JSON.stringify(corpo.cause || '')]
        .filter(Boolean)
        .join(' | ') || resposta.status;
      throw new Error(`Mercado Pago recusou a requisição: ${detalhe}`);
    }
    return corpo;
  }

  /**
   * Cria preferência de pagamento com o valor total já acrescido do custo,
   * parcelado em até `parcelas` vezes. O comprador paga o acréscimo.
   */
  async function criarPreferencia({
    titulo,
    totalCents,
    parcelas,
    parcelasMax,
    referenciaExterna,
    urlRetorno,
    urlNotificacao,
  }) {
    const corpo = {
      items: [
        {
          title: titulo,
          quantity: 1,
          currency_id: 'BRL',
          unit_price: Number((totalCents / 100).toFixed(2)),
        },
      ],
      payment_methods: {
        installments: parcelasMax || parcelas,
        default_installments: parcelas,
        excluded_payment_types: [{ id: 'ticket' }],
      },
      external_reference: referenciaExterna,
    };
    // Retorno automático e webhook exigem endereço público com HTTPS. Em ambiente local
    // (localhost) o Mercado Pago recusa a preferência, então esses campos são omitidos.
    if (urlRetorno) {
      corpo.back_urls = {
        success: `${urlRetorno}?status=sucesso`,
        pending: `${urlRetorno}?status=pendente`,
        failure: `${urlRetorno}?status=falha`,
      };
      corpo.auto_return = 'approved';
    }
    if (urlNotificacao) corpo.notification_url = urlNotificacao;
    const preferencia = await requisitar('/checkout/preferences', {
      method: 'POST',
      body: JSON.stringify(corpo),
    });
    return { id: preferencia.id, initPoint: preferencia.init_point };
  }

  async function obterPagamento(paymentId) {
    return requisitar(`/v1/payments/${encodeURIComponent(paymentId)}`);
  }

  return { criarPreferencia, obterPagamento };
}

module.exports = { criarClienteMP };
