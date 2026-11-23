'use strict';

const fs = require('fs');
const config = require('./config');
const { openDb } = require('./db');
const { criarApp } = require('./app');
const { criarClienteMP } = require('./mercadopago');

function iniciar() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  if (!config.adminPassword) {
    console.warn('AVISO: ADMIN_PASSWORD não definida. O painel administrativo ficará indisponível.');
  }
  if (!config.pix.chave) {
    console.warn('AVISO: PIX_CHAVE não definida. O pagamento via Pix ficará indisponível.');
  }

  const db = openDb(config.dbFile);
  const mp = config.mercadoPago.accessToken
    ? criarClienteMP({ accessToken: config.mercadoPago.accessToken })
    : null;

  const { app, servico } = criarApp({ config, db, mp });

  // Libera reservas vencidas e promove a fila a cada minuto.
  const intervalo = setInterval(() => {
    try {
      servico.expirarVencidas(new Date());
    } catch (erro) {
      console.error('Falha ao expirar reservas:', erro);
    }
  }, 60 * 1000);
  intervalo.unref();

  const servidor = app.listen(config.port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Desapego em http://localhost:${config.port}`);
  });

  const encerrar = () => {
    servidor.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);
}

if (require.main === module) {
  iniciar();
}

module.exports = { iniciar };
